import type {
  BusinessSession,
  BusinessTaskTimestamp,
  BatchFailure,
  ImportBatch,
  ImportSelection,
  LocalProject,
  LocalProjects,
} from '@ohif/core';
import type filesToImportBatch from '../routes/Local/filesToImportBatch';

type Dependencies = {
  parse?: typeof filesToImportBatch;
  release?: (batch: ImportBatch) => unknown;
  identityGeneration?: () => number;
};
export class LocalProjectService implements LocalProjects {
  private release: (batch: ImportBatch) => unknown;
  private current: LocalProject | null = null;
  private batch: ImportBatch | null = null;
  private failures: readonly BatchFailure[] = [];
  private attempt = 0;
  private generation = 0;
  private identity: string | null = null;
  private credentialGeneration = 0;
  private projectGeneration = new WeakMap<LocalProject, number>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit = () => this.listeners.forEach(listener => listener());
  constructor(
    private readonly session: BusinessSession,
    private readonly dependencies: Dependencies = {}
  ) {
    this.credentialGeneration = dependencies.identityGeneration?.() ?? 0;
    this.release = dependencies.release ?? (() => undefined);
    this.observeIdentity();
    session.subscribe(() => this.observeIdentity());
  }
  private observeIdentity() {
    const { status, context } = this.session.getSnapshot();
    // 身份恢复的loading不是账号切换；新的凭证到期时间或退出会废弃旧资格。
    if (status === 'loading' || status === 'error') {
      return;
    }
    const identity =
      status === 'authenticated' && context
        ? JSON.stringify([context.user.uid, context.expires_at])
        : null;
    const credentialGeneration = this.dependencies.identityGeneration?.() ?? 0;
    if (identity !== this.identity || credentialGeneration !== this.credentialGeneration) {
      this.credentialGeneration = credentialGeneration;
      this.identity = identity;
      this.generation++;
      if (this.current && this.current.phase !== 'disposed') {
        this.current.phase = 'invalid';
        this.emit();
      }
    }
  }
  private parse = async (input: ImportSelection): Promise<ImportBatch> => {
    const parser = await import('../routes/Local/filesToImportBatch');
    this.release = this.dependencies.release ?? parser.releaseImportBatch;
    return parser.default(input);
  };
  async create(
    input: ImportSelection,
    microscopyLoaded = false,
    options?: { teamId?: string }
  ): Promise<LocalProject | null> {
    const snapshot = this.session.getSnapshot();
    const { context } = snapshot;
    const teamId = options?.teamId ?? snapshot.currentTeamId;
    if (
      snapshot.status !== 'authenticated' ||
      !context ||
      !teamId ||
      !context.memberships.some(member => member.team_id === teamId)
    ) {
      throw new Error('请先验证业务身份和团队');
    }
    this.dispose();
    const attempt = this.attempt;
    const generation = this.generation;
    const importer_uid = context.user.uid;
    const batch = await (this.dependencies.parse ?? this.parse)({
      ...input,
      files: [...input.files],
    });
    const latest = this.session.getSnapshot();
    if (
      attempt !== this.attempt ||
      generation !== this.generation ||
      latest.status !== 'authenticated' ||
      latest.context?.user.uid !== importer_uid ||
      !latest.context.memberships.some(member => member.team_id === teamId)
    ) {
      this.release(batch);
      return null;
    }
    this.failures = batch.failures;
    if (!batch.successes.length) {
      this.release(batch);
      return null;
    }
    const title = batch.kind === 'folder' ? batch.folder_name : batch.successes[0].file_name;
    if (!title || !title.trim() || title.length > 1024) {
      this.release(batch);
      throw new Error('首次标题必须非空且不超过1024字符');
    }
    const project: LocalProject = {
      ...batch,
      importer_uid,
      team_id: teamId,
      title,
      mode_path:
        microscopyLoaded && batch.successes.some(item => item.dataset.Modality === 'SM')
          ? 'microscopy'
          : 'segmentation/dicomlocal',
      registration_key: crypto.randomUUID(),
      phase: 'ready',
    };
    // 运行期状态可变，批次身份／标题／团队不能在后续重试或事件中改写。
    for (const key of Object.keys(project).filter(key => key !== 'phase')) {
      Object.defineProperty(project, key, { writable: false, configurable: false });
    }
    this.current = project;
    this.batch = batch;
    this.projectGeneration.set(project, generation);
    return project;
  }
  getCurrent = () => this.current;
  getFailures = () => this.failures;
  isCurrent = (project: LocalProject): boolean => {
    const snapshot = this.session.getSnapshot();
    return (
      this.current === project &&
      this.projectGeneration.get(project) === this.generation &&
      snapshot.status === 'authenticated' &&
      snapshot.context?.user.uid === project.importer_uid &&
      project.phase !== 'invalid' &&
      project.phase !== 'disposed'
    );
  };
  invalidate = (project: LocalProject) => {
    if (this.current === project && project.phase !== 'disposed') {
      project.phase = 'invalid';
      this.emit();
    }
  };
  updateTimestamp = (project: LocalProject, value: BusinessTaskTimestamp): boolean => {
    if (
      !this.isCurrent(project) ||
      project.phase !== 'registered' ||
      value.task_id !== project.task_id ||
      !project.updated_at ||
      !Number.isFinite(Date.parse(value.updated_at)) ||
      Date.parse(value.updated_at) <= Date.parse(project.updated_at)
    ) {
      return false;
    }
    project.updated_at = value.updated_at;
    return true;
  };
  dispose = () => {
    this.attempt++;
    this.failures = [];
    if (this.current) {
      this.current.phase = 'disposed';
      this.emit();
    }
    if (this.batch) {
      this.release(this.batch);
    }
    this.batch = null;
    this.current = null;
  };
}

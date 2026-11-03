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
  private retained = new Map<string, { project: LocalProject; batch: ImportBatch }>();
  private batches = new WeakMap<LocalProject, ImportBatch>();
  private selections = new WeakMap<LocalProject, ImportSelection>();
  private workspaceStates = new WeakMap<LocalProject, unknown>();
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
      this.disposeAll();
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
    this.batches.set(project, batch);
    this.selections.set(project, { ...input, files: [...input.files] });
    this.projectGeneration.set(project, generation);
    return project;
  }
  private eligible(project: LocalProject) {
    const snapshot = this.session.getSnapshot();
    return (
      this.projectGeneration.get(project) === this.generation &&
      project.phase === 'registered' &&
      snapshot.status === 'authenticated' &&
      snapshot.context?.user.uid === project.importer_uid &&
      snapshot.context.memberships.some(member => member.team_id === project.team_id)
    );
  }
  retain = (project: LocalProject) => {
    const batch = this.batches.get(project);
    if (!this.eligible(project) || !project.task_id || !batch) {
      throw new Error('任务内存资格已失效');
    }
    this.retained.set(project.task_id, { project, batch });
    this.emit();
  };
  getRetained = (taskId: string) => {
    const project = this.retained.get(taskId)?.project;
    return project && this.eligible(project) ? project : null;
  };
  activate = (taskId: string) => {
    const entry = this.retained.get(taskId);
    if (!entry || !this.eligible(entry.project)) {
      throw new Error('当前页面未保留该任务影像，需重新导入');
    }
    if (this.current && this.current !== entry.project) {
      throw new Error('请先离开当前任务');
    }
    this.current = entry.project;
    this.batch = entry.batch;
    this.emit();
    return entry.project;
  };
  suspend = () => {
    const status = this.session.getSnapshot().status;
    const pendingIdentity = status === 'loading' || status === 'error';
    const owned =
      this.current &&
      this.identity !== null &&
      this.projectGeneration.get(this.current) === this.generation &&
      this.current.phase === 'registered';
    if (this.current && (this.eligible(this.current) || (pendingIdentity && owned))) {
      const batch = this.batches.get(this.current);
      if (!batch || !this.current.task_id) {
        throw new Error('任务内存不存在');
      }
      this.retained.set(this.current.task_id, { project: this.current, batch });
      this.current = null;
      this.batch = null;
      this.emit();
    } else {
      this.dispose();
    }
  };
  getSelection = (project: LocalProject) =>
    this.eligible(project) ? this.selections.get(project) : undefined;
  setWorkspaceState = (project: LocalProject, state: unknown) => {
    if (this.eligible(project)) {
      this.workspaceStates.set(project, state);
    }
  };
  getWorkspaceState = (project: LocalProject) =>
    this.eligible(project) ? this.workspaceStates.get(project) : undefined;
  disposeAll = () => {
    const entries = [...this.retained.values()];
    const batches = new Set(entries.map(entry => entry.batch));
    if (this.batch) {
      batches.add(this.batch);
    }
    for (const { project } of entries) {
      project.phase = 'disposed';
    }
    if (this.current) {
      this.current.phase = 'disposed';
    }
    this.retained.clear();
    this.current = null;
    this.batch = null;
    this.workspaceStates = new WeakMap();
    this.selections = new WeakMap();
    this.attempt++;
    this.failures = [];
    this.emit();
    batches.forEach(batch => this.release(batch));
  };
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
    const project = this.current,
      batch = this.batch;
    this.current = null;
    this.batch = null;
    if (project) {
      if (project.task_id) {
        this.retained.delete(project.task_id);
      }
      this.selections.delete(project);
      this.workspaceStates.delete(project);
      project.phase = 'disposed';
      this.emit();
    }
    if (batch) {
      this.release(batch);
    }
  };
}

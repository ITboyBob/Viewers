import type {
  BusinessSession,
  ImportBatch,
  ImportSelection,
  LocalImportScope,
  LocalParticipationPort,
  SharedFilePort,
  SharedViewContext,
  SharedViewPort,
  ProjectModeLifecycle,
} from '@ohif/core';
import { createModeProjectLifecycle } from '../ProjectRuntimeService';
import { validateSharedBundle } from './SharedFileStore';
export type SharedViewDependencies = {
  session: BusinessSession;
  generation(): number;
  files: SharedFilePort;
  createParticipation(taskId: string): LocalParticipationPort;
  parse(input: ImportSelection): Promise<ImportBatch>;
  release(batch: ImportBatch): unknown;
  prepareScope(id: string, datasets: readonly Record<string, unknown>[]): LocalImportScope;
};
type Lease = {
  generation: number;
  sessionGeneration: number;
  uid: string;
  controller: AbortController;
  participation: LocalParticipationPort;
  context: SharedViewContext | null;
  stopped: boolean;
  released: boolean;
  pendingReady: boolean;
  setupComplete: boolean;
  nativeReady: boolean;
  parsed?: ImportBatch;
  scope?: LocalImportScope;
  lifecycle?: ProjectModeLifecycle;
  stopSession?: () => void;
  stopParticipation?: () => void;
};
export class SharedViewService implements SharedViewPort {
  private current: Lease | null = null;
  private snapshot: SharedViewContext | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly dependencies: SharedViewDependencies) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit = () => this.listeners.forEach(listener => listener());
  private update(lease: Lease, change: Partial<SharedViewContext>) {
    if (lease.context) {
      lease.context = Object.freeze({ ...lease.context, ...change });
    }
    if (this.current === lease) {
      this.snapshot = lease.context;
      this.emit();
    }
  }
  private ownSession(lease: Lease) {
    const snapshot = this.dependencies.session.getSnapshot();
    return (
      lease.sessionGeneration === this.dependencies.generation() &&
      snapshot.status !== 'invalid' &&
      (snapshot.status === 'loading' ||
        snapshot.status === 'error' ||
        snapshot.context?.user.uid === lease.uid)
    );
  }
  private guard(lease: Lease) {
    if (
      this.current !== lease ||
      lease.stopped ||
      !this.ownSession(lease) ||
      lease.controller.signal.aborted ||
      lease.participation.getSnapshot().phase === 'closed'
    ) {
      throw new Error('本次共享加载已取消');
    }
  }
  async open(taskId: string) {
    this.dispose();
    this.snapshot = null;
    this.emit();
    const session = this.dependencies.session.getSnapshot();
    if (!taskId || session.status !== 'authenticated' || !session.context) {
      throw new Error('请先验证自己的账户');
    }
    const participation = this.dependencies.createParticipation(taskId);
    const lease: Lease = {
      generation: ++this.generation,
      sessionGeneration: this.dependencies.generation(),
      uid: session.context.user.uid,
      controller: new AbortController(),
      participation,
      context: null,
      stopped: false,
      released: false,
      pendingReady: false,
      setupComplete: false,
      nativeReady: false,
    };
    this.current = lease;
    lease.stopSession = this.dependencies.session.subscribe(() => {
      if (!this.ownSession(lease)) {
        this.end(lease, true);
      } else if (
        lease.pendingReady &&
        this.dependencies.session.getSnapshot().status === 'authenticated'
      ) {
        this.completeReady(lease.generation);
      }
    });
    lease.stopParticipation = participation.subscribe(() => {
      if (participation.getSnapshot().phase === 'closed') {
        this.end(lease, !this.ownSession(lease));
      }
    });
    try {
      const loading = await participation.join('loading');
      this.guard(lease);
      const bundle = validateSharedBundle(
        await this.dependencies.files.read(
          taskId,
          loading.batch_id,
          loading.source_participant_id,
          lease.controller.signal
        )
      );
      this.guard(lease);
      const manifest = bundle.manifest;
      if (
        manifest.task_id !== taskId ||
        manifest.batch_id !== loading.batch_id ||
        manifest.source_participant_id !== loading.source_participant_id
      ) {
        throw new Error('源确认与共享清单不匹配');
      }
      lease.context = Object.freeze({
        task_id: taskId,
        batch_id: manifest.batch_id,
        source_participant_id: manifest.source_participant_id,
        title: manifest.title,
        team_id: manifest.team_id,
        importer_uid: manifest.importer_uid,
        viewer_uid: lease.uid,
        session_generation: lease.sessionGeneration,
        load_generation: lease.generation,
        phase: 'loading',
        view_ready: false,
        mode_path: manifest.mode_path,
        study_uids: Object.freeze([]),
        local_files: Object.freeze([]),
        scope_id: `${manifest.batch_id}:${lease.generation}`,
        scope_handle: null,
      });
      this.update(lease, {});
      const files = bundle.files.map(
        (file, index) =>
          new File([file.blob], manifest.files[index].file_name, {
            type: file.blob.type || 'application/dicom',
          })
      );
      const parsed = await this.dependencies.parse({ files, kind: 'files' });
      this.adoptParsed(lease, parsed);
      if (parsed.failures.length || parsed.successes.length !== manifest.files.length) {
        throw new Error('共享文件未能完整解析');
      }
      const localFiles = parsed.successes.map((item, index) => {
        const expected = manifest.files[index];
        if (
          item.selection_index !== index ||
          item.study_uid !== expected.study_uid ||
          item.series_uid !== expected.series_uid ||
          item.sop_uid !== expected.sop_uid
        ) {
          throw new Error('共享文件UID不匹配');
        }
        return Object.freeze({ ...item, selection_index: expected.selection_index });
      });
      lease.scope = this.dependencies.prepareScope(
        lease.context.scope_id,
        localFiles.map(file => file.dataset)
      );
      this.update(lease, {
        local_files: Object.freeze(localFiles),
        study_uids: Object.freeze([...new Set(localFiles.map(file => file.study_uid))]),
        scope_handle: lease.scope,
      });
      await participation.join('active');
      this.guard(lease);
      lease.lifecycle = createModeProjectLifecycle({
        deactivate: () => {
          this.stopCommunication(lease);
          if (lease.context?.phase === 'active') {
            this.update(lease, { phase: 'disposed', view_ready: false });
          }
        },
        releaseScope: () => {
          lease.stopSession?.();
          this.releaseResources(lease);
        },
      });
      lease.scope.activate();
      this.update(lease, { phase: 'active' });
    } catch (_error) {
      this.stopCommunication(lease);
      this.update(lease, {
        phase: this.ownSession(lease) ? 'disposed' : 'invalid',
        view_ready: false,
      });
      this.releaseLease(lease);
      throw new Error('本地共享不可用，请确认源窗口仍在线后重试。');
    }
  }
  /** 同步认领，迟到资源必须在进入任何当前代次字段前独立释放。 */
  private adoptParsed(lease: Lease, parsed: ImportBatch) {
    try {
      this.guard(lease);
    } catch (error) {
      this.dependencies.release(parsed);
      throw error;
    }
    lease.parsed = parsed;
  }
  private stopCommunication(lease: Lease) {
    if (lease.stopped) {
      return;
    }
    lease.stopped = true;
    lease.controller.abort();
    lease.stopParticipation?.();
    lease.participation.close(this.ownSession(lease) ? 'exit' : 'identity_invalid');
  }
  private releaseResources(lease: Lease) {
    if (lease.released) {
      return;
    }
    lease.released = true;
    let failed = false;
    try {
      lease.scope?.release();
    } catch (_error) {
      failed = true;
    }
    try {
      if (lease.parsed) {
        this.dependencies.release(lease.parsed);
      }
    } catch (_error) {
      failed = true;
    }
    lease.parsed = undefined;
    lease.scope = undefined;
    this.update(lease, {
      local_files: Object.freeze([]),
      study_uids: Object.freeze([]),
      scope_handle: null,
    });
    if (failed) {
      this.update(lease, { phase: 'invalid', view_ready: false });
    }
  }
  private releaseLease(lease: Lease) {
    lease.stopSession?.();
    try {
      lease.lifecycle?.dispose();
    } finally {
      this.releaseResources(lease);
    }
  }
  private end(lease: Lease, identityInvalid: boolean) {
    if (this.current !== lease) {
      return;
    }
    const ready = lease.context?.view_ready === true;
    this.stopCommunication(lease);
    this.update(lease, { phase: identityInvalid ? 'invalid' : ready ? 'detached' : 'disposed' });
    if (!ready) {
      this.releaseLease(lease);
    }
  }
  markSetupComplete(generation: number) {
    if (this.current?.generation === generation) {
      this.current.setupComplete = true;
      this.completeReady(generation);
    }
  }
  markViewReady(generation: number) {
    if (this.current?.generation === generation) {
      this.current.nativeReady = true;
      this.completeReady(generation);
    }
  }
  private completeReady(generation: number) {
    const lease = this.current;
    if (
      !lease ||
      lease.generation !== generation ||
      !lease.setupComplete ||
      !lease.nativeReady ||
      lease.context?.view_ready ||
      lease.stopped ||
      !this.ownSession(lease) ||
      lease.context?.phase !== 'active' ||
      lease.participation.getSnapshot().phase !== 'active' ||
      lease.scope?.isActive?.() === false
    ) {
      return;
    }
    if (this.dependencies.session.getSnapshot().status !== 'authenticated') {
      lease.pendingReady = true;
      return;
    }
    lease.pendingReady = false;
    lease.participation.setViewReady(true);
    this.update(lease, { view_ready: true });
  }
  getModeLifecycle = () => this.current?.lifecycle ?? null;
  dispose() {
    const lease = this.current;
    if (!lease) {
      return;
    }
    this.stopCommunication(lease);
    this.update(lease, { phase: 'disposed', view_ready: false });
    try {
      this.releaseLease(lease);
    } finally {
      this.current = null;
    }
  }
}

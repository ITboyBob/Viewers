import type {
  BusinessSession,
  LocalParticipantIdentity,
  LocalParticipationIdentities,
  LocalProject,
  LocalProjects,
  LocalSharingLeaveReason,
  LocalSharingRole,
  SharedPublicationContext,
  SharedPublicationSnapshot,
} from '@ohif/core';

/** 每页仅有一个参与生命周期；发布器与协议取得同一个源上下文。 */
export class LocalParticipationIdentity implements LocalParticipationIdentities {
  private current: LocalParticipantIdentity | null = null;
  private sourceContext: SharedPublicationContext | null = null;
  private project: LocalProject | null = null;

  constructor(
    private readonly session: BusinessSession,
    private readonly projects: LocalProjects,
    private readonly generation: () => number,
    private readonly randomId: () => string = () => crypto.randomUUID(),
    private readonly beforeClose: (
      identity: LocalParticipantIdentity,
      reason: LocalSharingLeaveReason
    ) => void = () => undefined
  ) {
    session.subscribe(() => {
      const identity = this.current;
      const snapshot = session.getSnapshot();
      if (
        identity &&
        (identity.session_generation !== generation() ||
          snapshot.status === 'invalid' ||
          (snapshot.status === 'authenticated' && snapshot.context?.user.uid !== identity.user.uid))
      ) {
        identity.close('identity_invalid');
      }
    });
    projects.subscribe(() => {
      if (
        this.project &&
        (projects.getCurrent() !== this.project ||
          this.project.phase === 'invalid' ||
          this.project.phase === 'disposed')
      ) {
        this.sourceContext?.close('source_invalid');
      }
    });
  }

  private create(taskId: string, role: LocalSharingRole): LocalParticipantIdentity {
    const snapshot = this.session.getSnapshot();
    if (!taskId || snapshot.status !== 'authenticated' || !snapshot.context) {
      throw new Error('请先验证当前账户及任务');
    }
    this.close();
    const generation = this.generation();
    const user = Object.freeze({
      uid: snapshot.context.user.uid,
      username: snapshot.context.user.username,
    });
    let closed = false;
    let closing = false;
    let seq = 0;
    const listeners = new Set<() => void>();
    const identity: LocalParticipantIdentity = Object.freeze({
      participant_id: this.randomId(),
      task_id: taskId,
      role,
      user,
      session_generation: generation,
      isCurrent: () =>
        !closed &&
        this.current === identity &&
        this.generation() === generation &&
        this.session.getSnapshot().status === 'authenticated' &&
        this.session.getSnapshot().context?.user.uid === user.uid,
      nextSeq: () => {
        // 普通发送由协议检查isCurrent；失效关闭前仍可为最终leave分配序号。
        if (closed || this.current !== identity || seq >= Number.MAX_SAFE_INTEGER) {
          throw new Error('本次参与已经结束');
        }
        return ++seq;
      },
      close: (reason: LocalSharingLeaveReason = 'exit') => {
        if (closed || closing) {
          return;
        }
        closing = true;
        try {
          this.beforeClose(identity, reason);
        } finally {
          closed = true;
          listeners.forEach(listener => listener());
          listeners.clear();
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    this.current = identity;
    return identity;
  }

  source(project: LocalProject): SharedPublicationContext {
    if (
      !project.task_id ||
      project.phase !== 'registered' ||
      !this.projects.isCurrent(project) ||
      this.session.getSnapshot().context?.user.uid !== project.importer_uid
    ) {
      throw new Error('只有当前已真实登记的导入项目才能发布共享');
    }
    if (this.project === project && this.sourceContext?.isCurrent()) {
      return this.sourceContext;
    }
    const identity = this.create(project.task_id, 'source');
    const listeners = new Set<() => void>();
    let snapshot: SharedPublicationSnapshot = Object.freeze({
      publication_phase: 'waiting',
      manifest: null,
      view_ready: false,
      error: null,
    });
    const publish = (next: SharedPublicationSnapshot) => {
      snapshot = Object.freeze(next);
      listeners.forEach(listener => listener());
    };
    const context: SharedPublicationContext = Object.freeze({
      identity,
      task_id: project.task_id,
      batch_id: project.batch_id,
      isCurrent: () => identity.isCurrent() && this.projects.isCurrent(project),
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      setPublication: (phase, manifest, error) => {
        if (!context.isCurrent()) {
          return false;
        }
        if (
          phase === 'ready' &&
          (!manifest ||
            manifest.task_id !== context.task_id ||
            manifest.batch_id !== context.batch_id ||
            manifest.source_participant_id !== identity.participant_id)
        ) {
          throw new Error('共享清单不属于当前发布实例');
        }
        publish({
          ...snapshot,
          publication_phase: phase,
          manifest: phase === 'ready' ? manifest! : null,
          error: error ?? null,
        });
        return true;
      },
      setViewReady: value => {
        if (context.isCurrent()) {
          publish({ ...snapshot, view_ready: value });
        }
      },
      close: reason => identity.close(reason),
    });
    identity.subscribe(() => {
      publish({ ...snapshot, publication_phase: 'cancelled', view_ready: false });
      listeners.clear();
    });
    this.project = project;
    this.sourceContext = context;
    return context;
  }

  viewer = (taskId: string) => this.create(taskId, 'viewer');
  getSource = () => (this.sourceContext?.isCurrent() ? this.sourceContext : null);
  close = (reason: LocalSharingLeaveReason = 'exit') => {
    this.current?.close(reason);
    this.current = null;
    this.sourceContext = null;
    this.project = null;
  };
}

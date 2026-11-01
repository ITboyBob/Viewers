import type {
  BusinessSession,
  ImportSelection,
  LocalParticipationIdentities,
  LocalProject,
  LocalProjects,
  SharedFilePort,
  SharedPublicationContext,
  SharedFileManifest,
  SharedFilePublicationPort,
} from '@ohif/core';
type Preparation = {
  files: Map<number, File>;
  generation: number;
  uid: string;
  cancelled: boolean;
  project?: LocalProject;
  source?: SharedPublicationContext;
  controller?: AbortController;
  pending?: Promise<void>;
  stop?: () => void;
};
export class SharedFilePublisher implements SharedFilePublicationPort {
  private current: Preparation | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly dependencies: {
      session: BusinessSession;
      projects: LocalProjects;
      identities: LocalParticipationIdentities;
      files: SharedFilePort;
      generation: () => number;
    }
  ) {}
  private emit = () => this.listeners.forEach(listener => listener());
  prepare(input: ImportSelection) {
    this.cancel();
    const snapshot = this.dependencies.session.getSnapshot();
    const preparation: Preparation = {
      files: new Map(input.files.map((file, index) => [index, file])),
      generation: this.dependencies.generation(),
      uid: snapshot.context?.user.uid ?? '',
      cancelled: false,
    };
    this.current = preparation;
    return {
      attach: (project: LocalProject) => {
        if (
          this.current !== preparation ||
          preparation.cancelled ||
          !this.valid(preparation) ||
          project.importer_uid !== preparation.uid ||
          !this.dependencies.projects.isCurrent(project)
        ) {
          this.cancelPreparation(preparation);
          return;
        }
        preparation.project = project;
      },
      cancel: () => this.cancelPreparation(preparation),
    };
  }
  private valid(preparation: Preparation) {
    const snapshot = this.dependencies.session.getSnapshot();
    return (
      !preparation.cancelled &&
      this.current === preparation &&
      preparation.generation === this.dependencies.generation() &&
      snapshot.status === 'authenticated' &&
      snapshot.context?.user.uid === preparation.uid
    );
  }
  publish(project: LocalProject): Promise<void> {
    const preparation = this.current;
    if (
      !preparation ||
      preparation.project !== project ||
      !this.valid(preparation) ||
      !this.dependencies.projects.isCurrent(project) ||
      project.phase !== 'registered' ||
      !project.task_id
    ) {
      return Promise.resolve();
    }
    if (preparation.pending) {
      return preparation.pending;
    }
    if (preparation.source?.getSnapshot().publication_phase === 'ready') {
      return Promise.resolve();
    }
    preparation.pending = this.write(preparation, project).finally(() => {
      preparation.pending = undefined;
    });
    return preparation.pending;
  }
  private async write(preparation: Preparation, project: LocalProject) {
    try {
      const source = preparation.source ?? this.dependencies.identities.source(project);
      preparation.source = source;
      if (!preparation.stop) {
        preparation.stop = source.subscribe(() => {
          if (!source.isCurrent()) {
            this.cancelPreparation(preparation);
          }
          this.emit();
        });
      }
      const successes = [...project.successes].sort(
        (a, b) => a.selection_index - b.selection_index
      );
      const files = successes.map(item => {
        const blob = preparation.files.get(item.selection_index);
        if (!blob) {
          throw new Error('缺少本次成功文件的原始引用');
        }
        return { batch_id: project.batch_id, selection_index: item.selection_index, blob };
      });
      const manifest: SharedFileManifest = {
        cache_version: 1,
        cache_state: 'ready',
        task_id: project.task_id!,
        batch_id: project.batch_id,
        source_participant_id: source.identity.participant_id,
        title: project.title,
        team_id: project.team_id,
        importer_uid: project.importer_uid,
        mode_path: project.mode_path,
        files: successes.map((item, index) => ({
          selection_index: item.selection_index,
          file_name: item.file_name,
          study_uid: item.study_uid,
          series_uid: item.series_uid,
          sop_uid: item.sop_uid,
          byte_length: files[index].blob.size,
        })),
      };
      const controller = new AbortController();
      preparation.controller = controller;
      source.setPublication('writing');
      const saved = await this.dependencies.files.publish({ manifest, files }, controller.signal);
      await this.waitForEntryValidation(preparation, controller.signal);
      if (this.valid(preparation) && source.isCurrent()) {
        source.setPublication('ready', saved);
        preparation.files.clear();
      } else {
        this.cancelPreparation(preparation);
      }
    } catch (_error) {
      if (this.valid(preparation)) {
        preparation.source?.setPublication('failed', undefined, '本地共享不可用，原阅片不受影响');
      } else {
        this.cancelPreparation(preparation);
      }
    }
  }
  private waitForEntryValidation(preparation: Preparation, signal: AbortSignal): Promise<void> {
    if (this.dependencies.session.getSnapshot().status !== 'loading' || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const finish = () => {
        stop();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const stop = this.dependencies.session.subscribe(() => {
        if (
          this.dependencies.session.getSnapshot().status !== 'loading' ||
          preparation.generation !== this.dependencies.generation()
        ) {
          finish();
        }
      });
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  private cancelPreparation(preparation: Preparation) {
    if (preparation.cancelled) {
      return;
    }
    preparation.cancelled = true;
    preparation.controller?.abort();
    preparation.files.clear();
    preparation.source?.close();
    preparation.stop?.();
    if (this.current === preparation) {
      this.current = null;
    }
    this.emit();
  }
  cancel(project?: LocalProject) {
    if (this.current && (!project || this.current.project === project)) {
      this.cancelPreparation(this.current);
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

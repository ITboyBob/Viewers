import type {
  LocalProject,
  TaskStorageApi,
  ProjectWorkspaceAdapter,
  ResultArtifact,
  ProjectEventService,
} from '@ohif/core';

type Pending = { id: string; artifacts: ResultArtifact[]; fingerprint: string; generation: number };
/** 单页保存协调器：页面内重试，CAS冲突暂停；不提供离线编辑或持久待发队列。 */
export class TaskAutoSave {
  private revision = 0;
  private generation = 0;
  private acknowledged = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subscriptions: Array<{ unsubscribe(): void }> = [];
  private flight: AbortController | undefined;
  private pending: Pending | undefined;
  private fingerprint = '';
  private retry = 0;
  private status: HTMLDivElement | undefined;
  private conflict = false;
  private started = false;
  private allowed = false;
  private restoring = false;
  private recovery: AbortController | undefined;
  constructor(
    private project: LocalProject,
    private storage: TaskStorageApi,
    private adapter: ProjectWorkspaceAdapter,
    private services: ProjectEventService[],
    private active: () => boolean,
    private delay = 1000
  ) {}
  get hasPending() {
    return this.generation !== this.acknowledged || !!this.pending;
  }
  private permission(canEdit: boolean) {
    if (this.project.can_edit === canEdit) {
      return;
    }
    this.project.can_edit = canEdit;
    this.adapter.setReadOnly?.(!canEdit);
    window.dispatchEvent(new Event('colla:task-access'));
  }
  private show(message: string, retryable = false) {
    if (!this.status) {
      this.status = document.createElement('div');
      this.status.setAttribute('role', 'status');
      this.status.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:10000;padding:6px 12px;background:#071a35;color:#d8edff;border-radius:4px;pointer-events:none';
      document.body.appendChild(this.status);
    }
    this.status.textContent = message;
    if (retryable) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重试保存';
      retry.setAttribute('aria-label', '重试保存');
      retry.style.cssText = 'pointer-events:auto;margin-left:10px;text-decoration:underline';
      retry.addEventListener('click', () => this.online());
      this.status.appendChild(retry);
    }
  }
  async restore(signal: AbortSignal) {
    this.restoring = true;
    try {
      this.permission(false);
      const value = await this.storage.results(this.project.task_id!, signal);
      if (signal.aborted || this.stopped || !this.active()) {
        throw new Error('成果恢复已取消');
      }
      if (
        !Number.isSafeInteger(value?.revision) ||
        value.revision < 0 ||
        !Array.isArray(value.objects) ||
        typeof value.access?.can_edit !== 'boolean'
      ) {
        throw new Error('成果响应不完整');
      }
      let artifacts: ResultArtifact[] = [];
      if (value.objects.length || this.revision !== value.revision) {
        if (!this.adapter.importArtifacts) {
          throw new Error('成果回载不可用');
        }
        artifacts = await this.storage.readArtifacts(this.project.task_id!, value, signal);
        await this.adapter.importArtifacts(this.project, artifacts, signal);
      }
      if (signal.aborted || this.stopped || !this.active()) {
        throw new Error('成果恢复已取消');
      }
      this.fingerprint = await this.hash(artifacts);
      this.revision = value.revision;
      this.allowed = value.access.can_edit;
      this.permission(this.started && this.allowed);
      this.show(value.access.can_edit ? '成果已同步' : '当前任务只读');
    } finally {
      this.restoring = false;
    }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.hasPending) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  private online = () => {
    if (this.conflict || this.stopped || !this.active() || this.recovery) {
      return;
    }
    if (this.hasPending || this.adapter.isBusy?.()) {
      if (!this.hasPending) {
        this.generation++;
      }
      this.retry++;
      this.schedule(0);
      return;
    }
    const controller = new AbortController();
    this.recovery = controller;
    this.restore(controller.signal)
      .catch(() => {
        if (!this.stopped && !controller.signal.aborted) {
          this.show('重新连接失败，编辑暂停', true);
        }
      })
      .finally(() => {
        if (this.recovery === controller) {
          this.recovery = undefined;
        }
      });
  };
  private offline = () => {
    this.recovery?.abort();
    this.permission(false);
    this.show('连接已断开，编辑暂停；未确认修改仅在当前页保留');
  };
  async start() {
    if (this.started || this.stopped || !this.active()) {
      return;
    }
    if (this.adapter.exportArtifacts) {
      this.fingerprint = await this.hash(await this.adapter.exportArtifacts(this.project));
    }
    if (this.stopped || !this.active()) {
      return;
    }
    this.started = true;
    this.permission(this.allowed);
    this.show(this.allowed ? '成果已同步' : '当前任务只读');
    const excluded =
      /selection|jump|visibility|representation_(added|removed)|loading_complete|cleared_representation/i;
    for (const service of this.services) {
      for (const [name, event] of Object.entries(service.EVENTS)) {
        if (excluded.test(name) || /SELECTION|JUMP/.test(name)) {
          continue;
        }
        this.subscriptions.push(
          service.subscribe(event, () => {
            if (
              this.stopped ||
              !this.active() ||
              !this.allowed ||
              this.restoring ||
              this.conflict
            ) {
              return;
            }
            // 暂停输入不等于丢弃断连前已启动、随后完成的原生操作。
            this.generation++;
            if (this.project.can_edit) {
              this.show('有未保存成果');
            }
            this.schedule(this.delay);
          })
        );
      }
    }
    window.addEventListener('beforeunload', this.beforeUnload);
    window.addEventListener('online', this.online);
    window.addEventListener('offline', this.offline);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), delay);
  }
  private async hash(artifacts: ResultArtifact[]) {
    const values: string[] = [];
    for (const artifact of artifacts) {
      const digest = await crypto.subtle.digest('SHA-256', await artifact.blob.arrayBuffer());
      values.push(
        artifact.type +
          ':' +
          Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')
      );
    }
    return values.join('|');
  }
  private async save() {
    if (this.stopped || !this.active() || this.flight || this.conflict || !this.hasPending) {
      return;
    }
    if (this.adapter.isBusy?.()) {
      this.schedule(this.delay);
      return;
    }
    const controller = new AbortController();
    this.flight = controller;
    try {
      if (!this.pending) {
        if (!this.adapter.exportArtifacts) {
          throw new Error('成果编码不可用');
        }
        const generation = this.generation,
          artifacts = await this.adapter.exportArtifacts(this.project),
          fingerprint = await this.hash(artifacts);
        if (this.stopped || controller.signal.aborted || !this.active()) {
          return;
        }
        if (fingerprint === this.fingerprint) {
          if (this.retry) {
            await this.restore(controller.signal);
          }
          this.retry = 0;
          this.acknowledged = generation;
          this.show(this.hasPending ? '新修改待保存' : '成果已保存');
          return;
        }
        this.pending = { id: crypto.randomUUID(), artifacts, fingerprint, generation };
      }
      // 重连/失败重试先取得后端状态；仍用原操作ID消除“已提交但响应丢失”的歧义。
      if (this.retry) {
        await this.storage.results(this.project.task_id!, controller.signal);
      }
      if (this.stopped || controller.signal.aborted || !this.active()) {
        return;
      }
      this.show('正在自动保存…');
      const pending = this.pending;
      const result = await this.storage.save(
        this.project.task_id!,
        this.revision,
        pending.artifacts,
        pending.id,
        controller.signal
      );
      if (this.stopped || controller.signal.aborted || !this.active()) {
        return;
      }
      this.revision = result.revision;
      this.fingerprint = pending.fingerprint;
      this.acknowledged = pending.generation;
      this.pending = undefined;
      this.retry = 0;
      this.allowed = result.access.can_edit;
      this.permission(this.allowed);
      this.show(
        this.hasPending
          ? '新修改待保存'
          : result.access.can_edit
            ? '成果已保存'
            : '成果已保存，当前任务只读'
      );
    } catch (error) {
      if (this.stopped || controller.signal.aborted) {
        return;
      }
      this.permission(false);
      const status = (error as { status?: number }).status;
      if (
        typeof status === 'number' &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        this.conflict = true;
        this.show(
          status === 409
            ? '保存冲突：编辑已暂停，请重新打开任务获取最新成果'
            : '权限或任务已变化：编辑已暂停'
        );
      } else {
        this.retry++;
        this.show(
          '保存失败：' +
            (error instanceof Error ? error.message : '未知错误') +
            '；编辑暂停，正在重试，关闭页面可能丢失未保存成果',
          true
        );
        this.schedule(Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5)));
      }
    } finally {
      this.flight = undefined;
      if (!this.stopped && !this.conflict && this.hasPending && !this.retry) {
        this.schedule(this.delay);
      }
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.flight?.abort();
    this.recovery?.abort();
    this.subscriptions.splice(0).forEach(x => x.unsubscribe());
    window.removeEventListener('beforeunload', this.beforeUnload);
    window.removeEventListener('online', this.online);
    window.removeEventListener('offline', this.offline);
    this.status?.remove();
    this.pending = undefined;
    this.storage.forgetPending?.(this.project.task_id!);
  }
}

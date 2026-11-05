import type {
  LocalImportScope,
  LocalProject,
  LocalProjects,
  ProjectLifecycleHandle,
  ProjectModeLifecycle,
  ProjectRuntime,
  ProjectAnnotationServices,
  TaskApi,
  ProjectWorkspaceAdapter,
} from '@ohif/core';
import { TaskAutoSave } from './TaskAutoSave';
import { ProjectUpdateBridge } from './ProjectUpdateBridge';

type Binding = {
  project: LocalProject;
  handle: ProjectLifecycleHandle;
  active: boolean;
  lifecycle: ProjectModeLifecycle;
  scope: LocalImportScope;
  generation: number;
  stopBridge?: () => void;
  enableStoredBridge?: () => void;
  storedBridgeStarted?: boolean;
  autoSave?: TaskAutoSave;
  restoreController: AbortController;
  restored: boolean;
  captured: boolean;
  visitRecorded?: boolean;
  notify?: (message: string) => void;
};
export class ProjectRuntimeService implements ProjectRuntime {
  private binding: Binding | null = null;
  private adapter?: ProjectWorkspaceAdapter;
  setSnapshotAdapter(adapter: ProjectWorkspaceAdapter) {
    this.adapter = adapter;
  }
  prepareSuspend() {
    const binding = this.binding;
    if (
      binding?.autoSave?.hasPending &&
      !window.confirm('有尚未确认保存的成果，离开可能丢失这些修改。仍要离开吗？')
    )
      throw new Error('请等待成果保存或重试后离开');
    if (
      binding &&
      !binding.captured &&
      this.projects.isCurrent(binding.project) &&
      binding.project.phase === 'registered' &&
      binding.project.mode_path === 'segmentation/dicomlocal' &&
      this.adapter
    ) {
      if (!binding.restored) {
        throw new Error('任务仍在恢复，请稍后返回');
      }
      this.projects.setWorkspaceState?.(binding.project, this.adapter.capture(binding.project));
      binding.captured = true;
    }
  }
  async restoreMode(services: ProjectAnnotationServices, dataSourceName?: string) {
    const binding = this.binding;
    if (!binding) {
      return;
    }
    binding.notify = message =>
      services.uiNotificationService?.show({ title: '任务恢复', message, type: 'warning' });
    if (
      binding.project.source_stored &&
      binding.project.mode_path === 'segmentation/dicomlocal' &&
      this.storage
    ) {
      if (!this.adapter) throw new Error('原生成果适配器未装配');
      binding.stopBridge?.();
      binding.storedBridgeStarted = false;
      binding.autoSave?.stop();
      const saver = new TaskAutoSave(
        binding.project,
        this.storage,
        this.adapter,
        [services.measurementService, services.segmentationService].filter(Boolean),
        () => this.binding === binding && !binding.restoreController.signal.aborted
      );
      binding.autoSave = saver;
      await saver.restore(binding.restoreController.signal);
      if (
        this.binding !== binding ||
        binding.restoreController.signal.aborted ||
        !this.projects.isCurrent(binding.project)
      ) {
        saver.stop();
        return;
      }
      binding.restored = true;
      // Mode完成原生初始化、保存器建立基线后才开始用户业务事件订阅。
      binding.enableStoredBridge = () => {
        if (!binding.storedBridgeStarted) {
          binding.storedBridgeStarted = true;
          this.beginMode(services, dataSourceName);
        }
      };
      return;
    }
    const state = this.projects.getWorkspaceState?.(binding.project);
    if (state !== undefined) {
      if (!this.adapter) {
        throw new Error('任务恢复适配器不可用');
      }
      binding.restored = false;
      if (state && typeof state === 'object' && 'captureError' in state) {
        throw new Error(String(state.captureError));
      }
      await this.adapter.restore(binding.project, state, binding.restoreController.signal);
    }
    if (
      this.binding !== binding ||
      binding.restoreController.signal.aborted ||
      !this.projects.isCurrent(binding.project)
    ) {
      return;
    }
    binding.restored = true;
    this.beginMode(services, dataSourceName);
  }
  constructor(
    private readonly projects: LocalProjects,
    private readonly tasks?: TaskApi,
    private readonly onDeactivate?: (project: LocalProject) => void,
    private readonly storage?: import('@ohif/core').TaskStorageApi
  ) {}
  async startAutoSave() {
    const binding = this.binding;
    if (!binding) return;
    await binding.autoSave?.start();
    if (
      this.binding !== binding ||
      binding.restoreController.signal.aborted ||
      !this.projects.isCurrent(binding.project)
    )
      return;
    binding.enableStoredBridge?.();
    if (
      binding.project.source_stored &&
      !binding.visitRecorded &&
      this.binding === binding &&
      !binding.restoreController.signal.aborted
    ) {
      try {
        await this.tasks?.visit(binding.project.task_id!, binding.restoreController.signal);
        binding.visitRecorded = true;
      } catch (error) {
        if (!binding.restoreController.signal.aborted)
          binding.notify?.('任务已加载，但最近访问记录未保存，请稍后重新进入重试');
      }
    }
  }
  get restoringWorkspace() {
    return !!this.binding && !this.binding.restored;
  }
  get phaseOneMask() {
    return this.binding !== null;
  }
  getCurrent = () => this.binding?.project ?? null;
  getHandle = () => this.binding?.handle ?? null;
  getModeLifecycle = () => this.binding?.lifecycle ?? null;
  beginMode(services: ProjectAnnotationServices, dataSourceName?: string): () => void {
    const binding = this.binding;
    if (
      !binding ||
      !this.tasks ||
      !binding.project.importer_uid ||
      (binding.project.viewer_uid && binding.project.viewer_uid !== binding.project.importer_uid) ||
      dataSourceName !== 'dicomlocal' ||
      binding.project.mode_path !== 'segmentation/dicomlocal' ||
      !this.projects.isCurrent(binding.project) ||
      binding.scope.isActive?.() === false ||
      !services.measurementService ||
      !services.segmentationService
    ) {
      return () => undefined;
    }
    binding.stopBridge?.();
    const generation = ++binding.generation;
    binding.active = true;
    const bridge = new ProjectUpdateBridge({
      project: binding.project,
      projects: this.projects,
      tasks: this.tasks,
      measurementService: services.measurementService,
      segmentationService: services.segmentationService,
      isActive: () =>
        this.binding === binding &&
        binding.active &&
        binding.generation === generation &&
        binding.scope.isActive?.() !== false,
      isRestoring: () => binding.autoSave?.isRestoring ?? false,
      notify: message =>
        services.uiNotificationService?.show({ title: '项目时间', message, type: 'warning' }),
    });
    binding.stopBridge = bridge.stop;
    bridge.start();
    return () => {
      bridge.stop();
      if (binding.generation === generation) {
        binding.active = false;
        binding.generation++;
      }
    };
  }
  bind(project: LocalProject, scope: LocalImportScope): ProjectLifecycleHandle {
    if (
      this.binding ||
      !this.projects.isCurrent(project) ||
      project.phase !== 'registered' ||
      !project.task_id
    ) {
      throw new Error('只有当前已真实登记的批次才能绑定空闲运行时');
    }
    let released = false;
    const handle: ProjectLifecycleHandle = {
      deactivate: () => {
        binding.active = false;
        binding.generation++;
        binding.stopBridge?.();
        binding.autoSave?.stop();
        binding.restoreController.abort();
        if (
          !binding.captured &&
          binding.restored &&
          this.projects.isCurrent(project) &&
          project.phase === 'registered' &&
          project.mode_path === 'segmentation/dicomlocal' &&
          this.adapter
        ) {
          try {
            this.prepareSuspend();
          } catch (error) {
            const message = error instanceof Error ? error.message : '任务快照保存失败，请先导出';
            this.projects.setWorkspaceState?.(project, {
              captureError: message,
              previous: this.projects.getWorkspaceState?.(project),
            });
            binding.notify?.(message);
          }
          binding.captured = true;
        }
        this.onDeactivate?.(project);
      },
      releaseScope: () => {
        if (released) {
          return;
        }
        released = true;
        if (binding.active) {
          handle.deactivate();
        }
        unsubscribeProject?.();
        try {
          scope.release();
        } finally {
          if (this.binding === binding) {
            this.binding = null;
          }
          if (this.projects.getCurrent() === project) {
            if (project.phase === 'registered' && this.projects.suspend) {
              this.projects.suspend();
            } else {
              this.projects.dispose();
            }
          }
        }
      },
    };
    const binding: Binding = {
      project,
      active: true,
      handle,
      lifecycle: createModeProjectLifecycle(handle),
      scope,
      generation: 0,
      restoreController: new AbortController(),
      restored: this.projects.getWorkspaceState?.(project) === undefined,
      captured: false,
    };
    this.binding = binding;
    const unsubscribeProject = this.projects.subscribe?.(() => {
      if (!this.projects.isCurrent(project)) {
        handle.releaseScope();
      }
    });
    return binding.handle;
  }
}
/** 显式串联原生退出与scope释放，不依赖React多个effect的自然卸载顺序。 */
export function createModeProjectLifecycle(handle: ProjectLifecycleHandle | null) {
  let nativeExit: (() => void) | null = null;
  let disposed = false;
  return {
    setNativeExit(exit: () => void) {
      nativeExit?.();
      let called = false;
      const cleanup = () => {
        if (called) {
          return;
        }
        called = true;
        handle?.deactivate();
        try {
          exit();
        } finally {
          if (nativeExit === cleanup) {
            nativeExit = null;
          }
        }
      };
      nativeExit = cleanup;
      if (disposed) {
        cleanup();
      }
      return cleanup;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (nativeExit) {
          nativeExit();
        } else {
          handle?.deactivate();
        }
      } finally {
        handle?.releaseScope();
      }
    },
  };
}

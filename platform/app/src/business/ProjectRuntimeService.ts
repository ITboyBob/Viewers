import type {
  LocalImportScope,
  LocalProject,
  LocalProjects,
  ProjectLifecycleHandle,
  ProjectModeLifecycle,
  ProjectRuntime,
  ProjectAnnotationServices,
  TaskApi,
} from '@ohif/core';
import { ProjectUpdateBridge } from './ProjectUpdateBridge';

type Binding = {
  project: LocalProject;
  handle: ProjectLifecycleHandle;
  active: boolean;
  lifecycle: ProjectModeLifecycle;
  scope: LocalImportScope;
  generation: number;
  stopBridge?: () => void;
};
export class ProjectRuntimeService implements ProjectRuntime {
  private binding: Binding | null = null;
  constructor(
    private readonly projects: LocalProjects,
    private readonly tasks?: TaskApi
  ) {}
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
            this.projects.dispose();
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
    };
    this.binding = binding;
    const unsubscribeProject = this.projects.subscribe?.(() => {
      if (!this.projects.isCurrent(project)) {
        handle.deactivate();
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

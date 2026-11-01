import type {
  LocalImportScope,
  LocalProject,
  LocalProjects,
  ProjectLifecycleHandle,
  ProjectModeLifecycle,
  ProjectRuntime,
} from '@ohif/core';

type Binding = {
  project: LocalProject;
  handle: ProjectLifecycleHandle;
  active: boolean;
  lifecycle: ProjectModeLifecycle;
};
export class ProjectRuntimeService implements ProjectRuntime {
  private binding: Binding | null = null;
  constructor(private readonly projects: LocalProjects) {}
  get phaseOneMask() {
    return this.binding !== null;
  }
  getCurrent = () => this.binding?.project ?? null;
  getHandle = () => this.binding?.handle ?? null;
  getModeLifecycle = () => this.binding?.lifecycle ?? null;
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
      },
      releaseScope: () => {
        if (released) {
          return;
        }
        released = true;
        binding.active = false;
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
    };
    this.binding = binding;
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

import { ProjectRuntimeService, createModeProjectLifecycle } from './ProjectRuntimeService';
import type { LocalProject, LocalProjects } from '@ohif/core';
import { PubSubService } from '../../../core/src/services/_shared/pubSubServiceInterface';
let runtime: ProjectRuntimeService, project: LocalProject, dispose: jest.Mock;
const scope = () => ({ activate: jest.fn(), release: jest.fn() });
beforeEach(() => {
  project = {
    phase: 'registered',
    task_id: 'real-id',
    mode_path: 'segmentation/dicomlocal',
  } as LocalProject;
  dispose = jest.fn();
  runtime = new ProjectRuntimeService({
    isCurrent: () => true,
    getCurrent: () => project,
    dispose,
  } as unknown as LocalProjects);
});
test('空运行时不伪造project，登记后绑定真实scope，退出先失活后释放并清理文件', () => {
  expect(runtime.phaseOneMask).toBe(false);
  expect(runtime.getCurrent()).toBeNull();
  const prepared = scope(),
    handle = runtime.bind(project, prepared);
  expect(runtime.phaseOneMask).toBe(true);
  expect(runtime.getCurrent()).toBe(project);
  expect(runtime.getHandle()).toBe(handle);
  handle.deactivate();
  expect(prepared.release).not.toHaveBeenCalled();
  handle.releaseScope();
  handle.releaseScope();
  expect(prepared.release).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(runtime.phaseOneMask).toBe(false);
  expect(runtime.getCurrent()).toBeNull();
});
test('未登记不得绑定，现有binding不可被新项目静默覆盖', () => {
  project.phase = 'ready';
  expect(() => runtime.bind(project, scope())).toThrow();
  project.phase = 'registered';
  runtime.bind(project, scope());
  expect(() => runtime.bind(project, scope())).toThrow();
});
test('旧handle释放不会影响后来绑定，scope释放异常也必须清理当前资格', () => {
  const old = runtime.bind(project, scope());
  old.releaseScope();
  const prepared = scope();
  const current = runtime.bind(project, prepared);
  old.releaseScope();
  expect(prepared.release).not.toHaveBeenCalled();
  prepared.release.mockImplementation(() => {
    throw new Error('synthetic');
  });
  expect(() => current.releaseScope()).toThrow('synthetic');
  expect(runtime.getCurrent()).toBeNull();
});
test('模式边界显式先deactivate，再原生退出，finally释放；重复React cleanup不重复退出', () => {
  const events: string[] = [];
  const boundary = createModeProjectLifecycle({
    deactivate: () => events.push('deactivate'),
    releaseScope: () => events.push('release'),
  });
  const cleanup = boundary.setNativeExit(() => events.push('native-exit'));
  boundary.dispose();
  cleanup();
  boundary.dispose();
  expect(events).toEqual(['deactivate', 'native-exit', 'release']);
});
test('原生退出抛错或从未完成初始化也要finally释放scope', () => {
  const releaseScope = jest.fn();
  const boundary = createModeProjectLifecycle({ deactivate: jest.fn(), releaseScope });
  boundary.setNativeExit(() => {
    throw new Error('native');
  });
  expect(() => boundary.dispose()).toThrow('native');
  expect(releaseScope).toHaveBeenCalledTimes(1);
  const early = createModeProjectLifecycle({ deactivate: jest.fn(), releaseScope });
  early.dispose();
  expect(releaseScope).toHaveBeenCalledTimes(2);
});
test('模式内重初始化的旧cleanup不释放项目或覆盖新cleanup', () => {
  const releaseScope = jest.fn(),
    one = jest.fn(),
    two = jest.fn();
  const boundary = createModeProjectLifecycle({ deactivate: jest.fn(), releaseScope });
  const old = boundary.setNativeExit(one);
  old();
  boundary.setNativeExit(two);
  old();
  expect(releaseScope).not.toHaveBeenCalled();
  boundary.dispose();
  expect(one).toHaveBeenCalledTimes(1);
  expect(two).toHaveBeenCalledTimes(1);
  expect(releaseScope).toHaveBeenCalledTimes(1);
});

test('已经退出后才注册的原生cleanup立即执行，无scope的原生模式也保持退出', () => {
  const boundary = createModeProjectLifecycle(null);
  boundary.dispose();
  const exit = jest.fn();
  boundary.setNativeExit(exit);
  expect(exit).toHaveBeenCalledTimes(1);
});

describe('3B真实事件桥接与generation生命周期', () => {
  let services, touch: jest.Mock, emit: () => void, eligible: boolean, prepared;
  const flush = async () => {
    for (let n = 0; n < 30; n++) {
      await Promise.resolve();
    }
  };
  beforeEach(() => {
    Object.assign(project, {
      batch_id: 'b',
      mode_path: 'segmentation/dicomlocal',
      importer_uid: 'u',
      study_uids: ['1'],
      successes: [],
      updated_at: '2026-11-01T00:00:00Z',
    });
    eligible = true;
    const projects = {
      isCurrent: () => eligible,
      getCurrent: () => project,
      dispose,
      updateTimestamp: jest.fn(),
      subscribe: listener => {
        emit = listener;
        return jest.fn();
      },
    };
    touch = jest
      .fn()
      .mockResolvedValue({ task_id: project.task_id, updated_at: '2026-11-01T00:00:01Z' });
    runtime = new ProjectRuntimeService(projects as never, { touch } as never);
    prepared = { ...scope(), isActive: () => true };
    runtime.bind(project, prepared);
    services = {
      measurementService: new PubSubService({ ADDED: 'measurement' }),
      segmentationService: new PubSubService({ ADDED: 'segmentation' }),
      uiNotificationService: { show: jest.fn() },
    };
  });
  const broadcast = () => services.measurementService._broadcastEvent('measurement', {});
  test('原生或错数据源不启动，当前mask scope才拥有桥接', async () => {
    runtime.beginMode(services, 'dicomweb');
    broadcast();
    expect(touch).not.toHaveBeenCalled();
    prepared.isActive = () => false;
    runtime.beginMode(services, 'dicomlocal');
    broadcast();
    expect(touch).not.toHaveBeenCalled();
    prepared.isActive = () => true;
    runtime.beginMode(services, 'dicomlocal');
    broadcast();
    await flush();
    expect(touch).toHaveBeenCalledTimes(1);
    runtime.getModeLifecycle().dispose();
  });
  test('再次进入只一组订阅，旧generation返回或旧cleanup不能停止新桥接', async () => {
    let finish;
    touch.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const oldStop = runtime.beginMode(services, 'dicomlocal');
    broadcast();
    const oldSignal = touch.mock.calls[0][1];
    runtime.beginMode(services, 'dicomlocal');
    expect(oldSignal.aborted).toBe(true);
    oldStop();
    finish({ task_id: project.task_id, updated_at: '2026-11-01T00:00:09Z' });
    broadcast();
    await flush();
    expect(touch).toHaveBeenCalledTimes(2);
    expect(services.measurementService.listeners.measurement).toHaveLength(1);
    runtime.getModeLifecycle().dispose();
    expect(services.measurementService.listeners.measurement).toHaveLength(0);
  });
  test('身份失效同步中止桥接并释放scope和图像', async () => {
    const lifetime = runtime.getModeLifecycle();
    runtime.beginMode(services, 'dicomlocal');
    eligible = false;
    emit();
    broadcast();
    await flush();
    expect(touch).not.toHaveBeenCalled();
    expect(prepared.release).toHaveBeenCalledTimes(1);
    expect(services.measurementService.listeners.measurement).toHaveLength(0);
    lifetime.dispose();
    expect(prepared.release).toHaveBeenCalledTimes(1);
  });
});

test('退出先保存独立快照再执行原生清理，暂停保留项目而非销毁', () => {
  const events: string[] = [];
  const projects = {
    isCurrent: () => true,
    getCurrent: () => project,
    suspend: () => events.push('suspend'),
    dispose: jest.fn(),
    setWorkspaceState: (_p, value) => events.push(value),
  } as unknown as LocalProjects;
  runtime = new ProjectRuntimeService(projects);
  runtime.setSnapshotAdapter({ capture: () => 'snapshot', restore: jest.fn() });
  runtime.bind(project, scope());
  const lifecycle = runtime.getModeLifecycle();
  lifecycle.setNativeExit(() => events.push('native-exit'));
  lifecycle.dispose();
  expect(events).toEqual(['snapshot', 'native-exit', 'suspend']);
  expect(projects.dispose).not.toHaveBeenCalled();
});

test('恢复未完成时不启动事件桥接；离开后晚完成不能重新挂载', async () => {
  let complete!: () => void;
  let signal!: AbortSignal;
  const projects = {
    isCurrent: () => true,
    getCurrent: () => project,
    dispose: jest.fn(),
    getWorkspaceState: () => ({}),
  } as unknown as LocalProjects;
  runtime = new ProjectRuntimeService(projects);
  runtime.setSnapshotAdapter({
    capture: jest.fn(),
    restore: (_p, _s, abort) => {
      signal = abort;
      return new Promise(resolve => {
        complete = resolve;
      });
    },
  });
  runtime.bind(project, scope());
  const begin = jest.spyOn(runtime, 'beginMode');
  const restoring = runtime.restoreMode({}, 'dicomlocal');
  expect(begin).not.toHaveBeenCalled();
  runtime.getHandle().releaseScope();
  expect(signal.aborted).toBe(true);
  complete();
  await restoring;
  expect(begin).not.toHaveBeenCalled();
});

test('有待恢复快照时从bind起保护旧数据，初始化失败不得用空状态覆盖', () => {
  const saved = { old: 'nonempty-mask' },
    write = jest.fn(),
    capture = jest.fn();
  const projects = {
    isCurrent: () => true,
    getCurrent: () => project,
    getWorkspaceState: () => saved,
    setWorkspaceState: write,
    suspend: jest.fn(),
  } as unknown as LocalProjects;
  runtime = new ProjectRuntimeService(projects);
  runtime.setSnapshotAdapter({ capture, restore: jest.fn() });
  runtime.bind(project, scope());
  runtime.getModeLifecycle().setNativeExit(() => {});
  runtime.getModeLifecycle().dispose();
  expect(capture).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

test('返回预捕获失败不会覆盖原快照或释放工作台；自动退出失败留下显式错误而非空成功', async () => {
  const saved = { pixels: [1, 2] };
  const set = jest.fn();
  const projects = {
    isCurrent: () => true,
    getCurrent: () => project,
    setWorkspaceState: set,
    getWorkspaceState: () => undefined,
    suspend: jest.fn(),
  } as unknown as LocalProjects;
  runtime = new ProjectRuntimeService(projects);
  runtime.setSnapshotAdapter({
    capture: () => {
      throw new Error('不能保存');
    },
    restore: jest.fn(),
  });
  runtime.bind(project, scope());
  expect(() => runtime.prepareSuspend()).toThrow('不能保存');
  expect(set).not.toHaveBeenCalled();
  expect(runtime.getCurrent()).toBe(project);
  runtime.getModeLifecycle().dispose();
  expect(set).toHaveBeenCalledWith(project, expect.objectContaining({ captureError: '不能保存' }));
  expect(projects.suspend).toHaveBeenCalledTimes(1);
});

test('显微镜任务不使用Cornerstone测量快照，暂停仍保留其文件', () => {
  project.mode_path = 'microscopy';
  const projects = {
    isCurrent: () => true,
    getCurrent: () => project,
    suspend: jest.fn(),
    setWorkspaceState: jest.fn(),
  } as unknown as LocalProjects;
  runtime = new ProjectRuntimeService(projects);
  const capture = jest.fn();
  runtime.setSnapshotAdapter({ capture, restore: jest.fn() });
  runtime.bind(project, scope());
  runtime.prepareSuspend();
  runtime.getModeLifecycle().dispose();
  expect(capture).not.toHaveBeenCalled();
  expect(projects.suspend).toHaveBeenCalledTimes(1);
});

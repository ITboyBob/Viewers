import { ProjectRuntimeService, createModeProjectLifecycle } from './ProjectRuntimeService';
import type { LocalProject, LocalProjects } from '@ohif/core';
import { PubSubService } from '../../../core/src/services/_shared/pubSubServiceInterface';
let runtime: ProjectRuntimeService, project: LocalProject, dispose: jest.Mock;
const scope = () => ({ activate: jest.fn(), release: jest.fn() });
beforeEach(() => {
  project = { phase: 'registered', task_id: 'real-id' } as LocalProject;
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
  test('身份失效同步中止桥接，但实际退出前保留scope和图像', async () => {
    runtime.beginMode(services, 'dicomlocal');
    eligible = false;
    emit();
    broadcast();
    await flush();
    expect(touch).not.toHaveBeenCalled();
    expect(prepared.release).not.toHaveBeenCalled();
    expect(services.measurementService.listeners.measurement).toHaveLength(0);
    runtime.getModeLifecycle().dispose();
    expect(prepared.release).toHaveBeenCalledTimes(1);
  });
});

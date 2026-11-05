import { ProjectRuntimeService } from './ProjectRuntimeService';
import { PubSubService } from '../../../core/src/services/_shared/pubSubServiceInterface';
let mockRestoring = false;
const mockRestore = jest.fn(),
  mockStart = jest.fn(),
  mockStop = jest.fn();
jest.mock('./TaskAutoSave', () => ({
  TaskAutoSave: class {
    get isRestoring() {
      return mockRestoring;
    }
    restore(...args: unknown[]) {
      return mockRestore(...args);
    }
    start() {
      return mockStart();
    }
    stop() {
      mockStop();
    }
  },
}));
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function setup(viewer = 'u') {
  mockRestoring = false;
  mockRestore.mockReset().mockResolvedValue(undefined);
  mockStart.mockReset().mockResolvedValue(undefined);
  mockStop.mockReset();
  const project: any = {
    source_stored: true,
    phase: 'registered',
    task_id: 't',
    batch_id: 'b',
    mode_path: 'segmentation/dicomlocal',
    importer_uid: 'u',
    viewer_uid: viewer,
    study_uids: [],
    successes: [],
    updated_at: '2026-11-01T00:00:00Z',
  };
  const projects: any = {
    isCurrent: () => true,
    getCurrent: () => project,
    suspend: jest.fn(),
    invalidate: jest.fn(),
    updateTimestamp: jest.fn(),
  };
  const tasks: any = {
    touch: jest.fn().mockResolvedValue({ task_id: 't', updated_at: '2026-11-01T00:00:01Z' }),
    visit: jest.fn(),
  };
  const runtime = new ProjectRuntimeService(projects, tasks, undefined, {} as any);
  const handle = runtime.bind(project, {
    activate: jest.fn(),
    release: jest.fn(),
    isActive: () => true,
  });
  runtime.setSnapshotAdapter({ capture: jest.fn(), restore: jest.fn() });
  const services: any = {
    measurementService: new PubSubService({ ADDED: 'added', VISIBILITY_CHANGED: 'visibility' }),
    segmentationService: new PubSubService({ ADDED: 'segmentation' }),
    uiNotificationService: { show: jest.fn() },
  };
  const broadcast = () => services.measurementService._broadcastEvent('visibility', {});
  return { project, projects, tasks, runtime, handle, services, broadcast };
}
test('已保存任务恢复及初始化静默，正式启用后展示事件更新时间且订阅不叠加', async () => {
  const f = setup();
  mockRestore.mockImplementation(async () => f.broadcast());
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  f.broadcast();
  await flush();
  expect(f.tasks.touch).not.toHaveBeenCalled();
  await f.runtime.startAutoSave();
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(1);
  await f.runtime.startAutoSave();
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(2);
  expect(f.services.measurementService.listeners.visibility).toHaveLength(1);
  f.handle.deactivate();
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(2);
});
test('其他读取者保留成果保存服务，不启动仅属原导入者的时间桥接', async () => {
  const f = setup('viewer');
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  await f.runtime.startAutoSave();
  f.broadcast();
  await flush();
  expect(mockStart).toHaveBeenCalled();
  expect(f.tasks.touch).not.toHaveBeenCalled();
});
test('退出后的迟到启用不能复活旧项目订阅', async () => {
  const f = setup();
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  let done!: () => void;
  mockStart.mockImplementation(() => new Promise<void>(resolve => (done = resolve)));
  const starting = f.runtime.startAutoSave();
  f.handle.releaseScope();
  done();
  await starting;
  f.broadcast();
  await flush();
  expect(f.tasks.touch).not.toHaveBeenCalled();
});
test('退出中止时间请求，晚响应不写已退出项目', async () => {
  const f = setup();
  let done!: (value: unknown) => void;
  f.tasks.touch.mockImplementation(() => new Promise(resolve => (done = resolve)));
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  await f.runtime.startAutoSave();
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(1);
  const signal = f.tasks.touch.mock.calls[0][1];
  f.handle.deactivate();
  expect(signal.aborted).toBe(true);
  done({ task_id: 't', updated_at: '2026-11-01T00:00:03Z' });
  await flush();
  expect(f.projects.updateTimestamp).not.toHaveBeenCalled();
});

test.each([403, 404])('重连期间在途时间请求返回%s仍立即失效，旧队列不能复活', async status => {
  const f = setup();
  let reject!: (reason: unknown) => void;
  f.tasks.touch.mockReturnValueOnce(new Promise((_resolve, no) => (reject = no)));
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  await f.runtime.startAutoSave();
  f.broadcast();
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(1);
  mockRestoring = true;
  reject({ status });
  await flush();
  expect(f.projects.invalidate).toHaveBeenCalledWith(f.project);
  mockRestoring = false;
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(1);
});
test('重新恢复期间原生广播不入时间队列，恢复结束只处理新用户事件', async () => {
  const f = setup();
  await f.runtime.restoreMode(f.services, 'dicomlocal');
  await f.runtime.startAutoSave();
  mockRestoring = true;
  f.broadcast();
  await flush();
  expect(f.tasks.touch).not.toHaveBeenCalled();
  mockRestoring = false;
  f.broadcast();
  await flush();
  expect(f.tasks.touch).toHaveBeenCalledTimes(1);
});

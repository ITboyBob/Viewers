import { setupSegmentationDataModifiedHandler } from './segmentationHandlers';
import { updateSegmentationStats } from './updateSegmentationStats';
jest.mock('@cornerstonejs/tools', () => ({}), { virtual: true });
jest.mock('./updateSegmentationStats', () => ({
  updateSegmentationStats: jest.fn().mockResolvedValue({ segments: {} }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(updateSegmentationStats).mockClear();
});
afterEach(() => jest.useRealTimers());

function fixture() {
  const listeners = new Set<(value: unknown) => void>();
  const state = { restoring: false };
  const service = {
    EVENTS: { SEGMENTATION_DATA_MODIFIED: 'data' },
    subscribe: jest.fn((_event, callback) => {
      listeners.add(callback);
      return { unsubscribe: () => listeners.delete(callback) };
    }),
    getSegmentation: () => ({ segments: {} }),
    addOrUpdateSegmentation: jest.fn(),
    subscribeDebounced: jest.fn((_event, callback, wait) => {
      let timer;
      const listener = value => {
        clearTimeout(timer);
        timer = setTimeout(() => callback(value), wait);
      };
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    }),
  };
  const handle = setupSegmentationDataModifiedHandler({
    segmentationService: service,
    customizationService: { getCustomization: jest.fn() },
    commandsManager: { runCommand: jest.fn() },
    isRestoring: () => state.restoring,
  });
  return {
    state,
    service,
    handle,
    emit: (segmentationId: string) => listeners.forEach(fn => fn({ segmentationId })),
  };
}

test('恢复产生的数据事件不排入原生异步统计，恢复后的用户编辑仍正常统计', async () => {
  const f = fixture();
  f.state.restoring = true;
  f.emit('restored');
  f.state.restoring = false;
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).not.toHaveBeenCalled();
  f.emit('edited');
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).toHaveBeenCalledTimes(1);
  f.handle.unsubscribe();
});

test('恢复开始后不执行此前排队的统计', async () => {
  const f = fixture();
  f.emit('edited');
  f.state.restoring = true;
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).not.toHaveBeenCalled();
  f.handle.unsubscribe();
});

test('退出模式后已排队的统计不再启动或写回', async () => {
  const f = fixture();
  f.emit('edited');
  f.handle.unsubscribe();
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).not.toHaveBeenCalled();
  expect(f.service.addOrUpdateSegmentation).not.toHaveBeenCalled();
});

import { setupSegmentationDataModifiedHandler } from './segmentationHandlers';
import { updateSegmentationStats } from './updateSegmentationStats';
jest.mock('@cornerstonejs/tools', () => ({}), { virtual: true });
jest.mock('./updateSegmentationStats', () => ({
  updateSegmentationStats: jest.fn().mockResolvedValue({ segments: {} }),
}));
test('恢复产生的数据事件不排入原生异步统计，恢复后的用户编辑仍正常统计', async () => {
  jest.useFakeTimers();
  let restoring = true,
    emit!: (value: unknown) => void;
  const service = {
    EVENTS: { SEGMENTATION_DATA_MODIFIED: 'data' },
    subscribe: jest.fn((_event, callback) => {
      emit = callback;
      return { unsubscribe: jest.fn() };
    }),
    getSegmentation: () => ({ segments: {} }),
    addOrUpdateSegmentation: jest.fn(),
    subscribeDebounced: jest.fn((_event, callback, wait) => {
      emit = value => setTimeout(() => callback(value), wait);
      return { unsubscribe: jest.fn() };
    }),
  };
  const handle = setupSegmentationDataModifiedHandler({
    segmentationService: service,
    customizationService: { getCustomization: jest.fn() },
    commandsManager: { runCommand: jest.fn() },
    isRestoring: () => restoring,
  });
  emit({ segmentationId: 'restored' });
  restoring = false;
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).not.toHaveBeenCalled();
  emit({ segmentationId: 'edited' });
  await jest.advanceTimersByTimeAsync(1100);
  expect(updateSegmentationStats).toHaveBeenCalledTimes(1);
  handle.unsubscribe();
  jest.useRealTimers();
});

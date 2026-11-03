import createAdapter from './ProjectWorkspaceAdapter';
import { cache, imageLoader } from '@cornerstonejs/core';
import { annotation, segmentation } from '@cornerstonejs/tools';
jest.mock(
  '@cornerstonejs/core',
  () => ({
    cache: { getImage: jest.fn() },
    imageLoader: { loadAndCacheImage: jest.fn(), createAndCacheDerivedLabelmapImages: jest.fn() },
  }),
  { virtual: true }
);
jest.mock(
  '@cornerstonejs/tools',
  () => ({
    annotation: {
      state: {
        getAllAnnotations: jest.fn(),
        getAnnotationManager: () => ({ addAnnotation: jest.fn() }),
      },
    },
    segmentation: {
      getLabelmapImageIds: jest.fn(),
      activeSegmentation: { setActiveSegmentation: jest.fn() },
    },
    Enums: { SegmentationRepresentations: { Labelmap: 'Labelmap' } },
    utilities: { triggerAnnotationRenderForViewportIds: jest.fn() },
  }),
  { virtual: true }
);
const project = { task_id: 'task-a', successes: [{ image_id: 'raw-a' }] } as any;
const setup = () => {
  const pixels = new Uint8Array([0, 1, 1, 0]);
  const mask = {
    segmentationId: 'mask',
    label: '保留Mask',
    segments: { 1: { label: '区域', locked: false, active: true } },
    representationData: { Labelmap: { imageIds: ['mask-a'], referencedImageIds: ['raw-a'] } },
  };
  (cache.getImage as jest.Mock).mockReturnValue({
    referencedImageId: 'raw-a',
    rows: 2,
    columns: 2,
    voxelManager: { getScalarData: () => pixels },
  });
  (segmentation.getLabelmapImageIds as jest.Mock).mockReturnValue(['mask-a']);
  (annotation.state.getAllAnnotations as jest.Mock).mockReturnValue([
    {
      annotationUID: 'length',
      metadata: { referencedImageId: 'raw-a', toolName: 'Length' },
      data: { handles: { points: [[1, 2, 3]] } },
    },
  ]);
  const services = {
    segmentationService: {
      getSegmentations: () => [mask],
      getRepresentationsForSegmentation: () => [],
    },
    measurementService: { getMeasurements: () => [{ uid: 'length', label: '测量' }] },
  } as any;
  return { pixels, mask, adapter: createAdapter(services), services };
};
test('快照独立复制Mask像素和测量，不能保留共享像素或混入其他影像', () => {
  const { pixels, mask, adapter } = setup();
  const state = adapter.capture(project) as any;
  pixels[1] = 7;
  mask.segments[1].label = '已修改';
  expect(Array.from(state.segmentations[0].frames[0].pixels)).toEqual([0, 1, 1, 0]);
  expect(state.segmentations[0].segments[1].label).toBe('区域');
  expect(state.measurements[0].uid).toBe('length');
  expect(() => adapter.capture({ ...project, successes: [{ image_id: 'other' }] })).toThrow();
});
test('恢复任务ID不匹配或已取消时不写入任何原生状态', async () => {
  const { adapter } = setup();
  const state = adapter.capture(project);
  const controller = new AbortController();
  controller.abort();
  await expect(adapter.restore(project, state, controller.signal)).rejects.toThrow();
  await expect(
    adapter.restore({ ...project, task_id: 'other' }, state, new AbortController().signal)
  ).rejects.toThrow();
  expect(imageLoader.createAndCacheDerivedLabelmapImages).not.toHaveBeenCalled();
});

function restorable() {
  const fixture = setup();
  const output = new Uint8Array(4);
  const servicesNativeRestore = jest.fn().mockReturnValue('length');
  fixture.services.measurementService.nativeRestore = servicesNativeRestore;
  Object.assign(fixture.services, {
    toolGroupService: { getToolGroupForViewport: () => ({ hasTool: () => true }) },
    viewportGridService: {
      getState: () => ({ viewports: new Map([['v', {}]]) }),
      getActiveViewportId: () => 'v',
    },
    cornerstoneViewportService: {
      getCornerstoneViewport: () => ({ getImageData: () => ({ imageData: {} }) }),
    },
  });
  Object.assign(fixture.services.segmentationService, {
    addOrUpdateSegmentation: jest.fn(),
    addSegmentationRepresentation: jest.fn().mockResolvedValue(undefined),
    setSegmentColor: jest.fn(),
    setSegmentVisibility: jest.fn(),
  });
  Object.assign(fixture.services.measurementService, {
    getSource: () => ({ annotationToMeasurement: servicesNativeRestore }),
    addRawMeasurement: jest.fn(),
  });
  (imageLoader.loadAndCacheImage as jest.Mock).mockResolvedValue({});
  (imageLoader.createAndCacheDerivedLabelmapImages as jest.Mock).mockResolvedValue([
    {
      imageId: 'restored-mask',
      rows: 2,
      columns: 2,
      voxelManager: { getScalarData: () => output },
    },
  ]);
  return { ...fixture, output };
}
afterEach(() => jest.clearAllMocks());
test('原生服务就绪后重建标签图及测量，像素和段属性与快照一致且不互相引用', async () => {
  const { adapter, output, services } = restorable();
  const snapshot = adapter.capture(project) as any;
  snapshot.segmentations[0].colors = { 1: [1, 2, 3, 255] };
  snapshot.segmentations[0].visible = { 1: false };
  await adapter.restore(project, snapshot, new AbortController().signal);
  expect(Array.from(output)).toEqual([0, 1, 1, 0]);
  output[1] = 5;
  expect(snapshot.segmentations[0].frames[0].pixels[1]).toBe(1);
  expect(services.segmentationService.addOrUpdateSegmentation).toHaveBeenCalledWith(
    expect.objectContaining({
      segmentationId: 'mask',
      config: expect.objectContaining({ label: '保留Mask' }),
    })
  );
  expect(services.segmentationService.setSegmentVisibility).toHaveBeenCalledWith(
    'v',
    'mask',
    1,
    false
  );
  expect(services.measurementService.nativeRestore).toHaveBeenCalledWith(
    'Length',
    expect.objectContaining({ uid: 'length' })
  );
});
test('等待影像期间取消不能添加任何分割或测量', async () => {
  const { adapter, services } = restorable(),
    controller = new AbortController();
  const snapshot = adapter.capture(project);
  (imageLoader.loadAndCacheImage as jest.Mock).mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(adapter.restore(project, snapshot, controller.signal)).rejects.toThrow('取消');
  expect(services.segmentationService.addOrUpdateSegmentation).not.toHaveBeenCalled();
});
test('损坏尺寸和其他任务引用明确失败，不发布空白分割', async () => {
  const { adapter, services } = restorable();
  const snapshot = adapter.capture(project) as any;
  snapshot.segmentations[0].frames[0].rows = 100;
  await expect(adapter.restore(project, snapshot, new AbortController().signal)).rejects.toThrow(
    '尺寸'
  );
  expect(services.segmentationService.addOrUpdateSegmentation).not.toHaveBeenCalled();
  snapshot.segmentations[0].frames[0].referenceId = 'foreign';
  await expect(adapter.restore(project, snapshot, new AbortController().signal)).rejects.toThrow(
    '其他任务'
  );
});
test('快照缺少Mask缓存或存在不支持的分割类型时不能伪装保存成功', () => {
  const { adapter, mask } = setup();
  (cache.getImage as jest.Mock).mockReturnValue(undefined);
  expect(() => adapter.capture(project)).toThrow('无法保留');
  mask.representationData = {} as any;
  expect(() => adapter.capture(project)).toThrow('不支持');
});

test('多帧文件保留帧级测量引用，恢复后仍指向原帧，不接受越界帧', async () => {
  const { adapter, services } = restorable();
  const multi = { ...project, successes: [{ image_id: 'raw-a', dataset: { NumberOfFrames: 3 } }] };
  services.segmentationService.getSegmentations = () => [];
  (annotation.state.getAllAnnotations as jest.Mock).mockReturnValue([
    {
      annotationUID: 'length',
      metadata: { referencedImageId: 'raw-a&frame=2', toolName: 'Length' },
      data: { handles: { points: [] } },
    },
    {
      annotationUID: 'foreign',
      metadata: { referencedImageId: 'raw-a&frame=4', toolName: 'Length' },
      data: {},
    },
  ]);
  const snapshot = adapter.capture(multi) as any;
  expect(snapshot.annotations).toHaveLength(1);
  await adapter.restore(multi, snapshot, new AbortController().signal);
  expect(services.measurementService.nativeRestore).toHaveBeenCalledWith(
    'Length',
    expect.objectContaining({
      annotation: expect.objectContaining({
        metadata: expect.objectContaining({ referencedImageId: 'raw-a&frame=2' }),
      }),
    })
  );
});

test('快照不保留测量服务闭包，颜色与原生LUT互不引用', () => {
  const { adapter, services } = setup();
  const color = [1, 2, 3, 255];
  services.measurementService.getMeasurements = () => [
    { uid: 'length', source: { callback: () => {} }, getReport: () => 'private closure' },
  ];
  services.segmentationService.getRepresentationsForSegmentation = () => [
    { viewportId: 'v', representations: [{ segments: { 1: { visible: false } } }] },
  ];
  services.segmentationService.getSegmentColor = () => color;
  const snapshot = adapter.capture(project) as any;
  color[0] = 99;
  expect(snapshot.segmentations[0].colors[1]).toEqual([1, 2, 3, 255]);
  expect(snapshot.measurements[0]).toEqual({ uid: 'length' });
});
test('等待视口期间取消立即移除输入遮罩，不载入和覆盖影像', async () => {
  jest.useFakeTimers();
  try {
    const { adapter, services } = restorable(),
      controller = new AbortController();
    services.cornerstoneViewportService.getCornerstoneViewport = () => null;
    const pending = adapter.restore(project, adapter.capture(project), controller.signal);
    const failure = expect(pending).rejects.toThrow('取消');
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    controller.abort();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await jest.advanceTimersByTimeAsync(30);
    await failure;
  } finally {
    jest.useRealTimers();
  }
});
test('未映射的原生标注仍可恢复，源缓存缺少referencedImageId时按原始映射校验', async () => {
  const { adapter, services } = restorable();
  (cache.getImage as jest.Mock).mockReturnValue({
    rows: 2,
    columns: 2,
    voxelManager: { getScalarData: () => new Uint8Array(4) },
  });
  services.measurementService.getMeasurements = () => [];
  const saved = adapter.capture(project);
  await adapter.restore(project, saved, new AbortController().signal);
  expect(services.measurementService.nativeRestore).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')).toBeNull();
});
test('原生测量来源缺失明确失败，不能把标注恢复伪装成成功', async () => {
  const { adapter, services } = restorable();
  const saved = adapter.capture(project);
  services.measurementService.getSource = () => undefined;
  await expect(adapter.restore(project, saved, new AbortController().signal)).rejects.toThrow(
    '来源'
  );
  expect(document.querySelector('[role="status"]')).toBeNull();
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');

// Exercise the production adapter against the public SDK contract, without WebGL.
const images = new Map();
const volumes = new Map();
const history = [];
const notifications = [];
let fixture;
class StackViewport {
  getCurrentImageId() {
    return 'reference-b';
  }
}
class VolumeViewport {
  getCamera() {
    return { viewPlaneNormal: [0, 0, 1], focalPoint: [0, 0, 1] };
  }
  getVolumeId() {
    return 'source-volume';
  }
}
function voxelManager(pixels) {
  return {
    getAtIndex: index => pixels[index],
    setAtIndex: (index, value) => {
      pixels[index] = value;
    },
  };
}
function createLabelmapMemo(id, source) {
  const before = new Map();
  const after = new Map();
  return {
    voxelManager: {
      setAtIndex(index, value) {
        if (!before.has(index)) before.set(index, source.getAtIndex(index));
        source.setAtIndex(index, value);
      },
    },
    commitMemo() {
      for (const index of before.keys()) after.set(index, source.getAtIndex(index));
      return before.size > 0;
    },
    restoreMemo(isUndo = true) {
      for (const [index, value] of isUndo ? before : after) source.setAtIndex(index, value);
    },
  };
}
globalThis.__maskSdk = {
  VolumeViewport,
  StackViewport,
  cache: { getImage: id => images.get(id), getVolume: id => volumes.get(id) },
  utilities: {
    transformWorldToIndex: (_, point) => point,
    HistoryMemo: { DefaultHistoryMemo: { push: memo => history.push(memo) } },
  },
  segmentation: {
    segmentLocking: { isSegmentIndexLocked: () => fixture.active.segments[1].locked },
    triggerSegmentationEvents: { triggerSegmentationDataModified: id => notifications.push(id) },
  },
  toolUtilities: {
    segmentation: {
      LabelmapMemo: { createLabelmapMemo },
      getOrCreateSegmentationVolume: () => volumes.get('label-volume'),
    },
  },
};
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cornerstonejs/core') return { url: 'mask-sdk:core', shortCircuit: true };
    if (specifier === '@cornerstonejs/tools') return { url: 'mask-sdk:tools', shortCircuit: true };
    if (specifier === './maskAlgorithms') return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'mask-sdk:core')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const { VolumeViewport, StackViewport, cache, utilities } = globalThis.__maskSdk; export const Types = {};',
      };
    if (url === 'mask-sdk:tools')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const { segmentation } = globalThis.__maskSdk; export const utilities = globalThis.__maskSdk.toolUtilities;',
      };
    return nextLoad(url, context);
  },
});
const createMaskCommands =
  require('../../extensions/cornerstone/src/utils/maskEditing/createMaskCommands.ts').default;
hook.deregister();

function setup(labels, width = labels.length, height = 1, raw = labels.map(() => 200)) {
  images.clear();
  volumes.clear();
  history.length = 0;
  notifications.length = 0;
  const pixels = Uint8Array.from(labels);
  const manager = voxelManager(pixels);
  const active = {
    segmentationId: 'mask',
    segments: { 1: { segmentIndex: 1, label: 'Bone', locked: false } },
    representationData: {
      Labelmap: {
        imageIds: ['label-a', 'label-b'],
        referencedImageIds: ['reference-a', 'reference-b'],
      },
    },
  };
  const source = {
    columns: width,
    rows: height,
    getPixelData: () => Int16Array.from(raw),
    slope: 1,
    intercept: 0,
    color: false,
    isPreScaled: true,
  };
  images.set('reference-b', source);
  images.set('label-b', {
    columns: width,
    rows: height,
    voxelManager: manager,
    dataType: 'Uint8Array',
  });
  fixture = { active, pixels, manager, source, viewport: new StackViewport() };
  const services = {
    viewportGridService: { getActiveViewportId: () => 'viewport' },
    cornerstoneViewportService: { getCornerstoneViewport: () => fixture.viewport },
    segmentationService: {
      getActiveSegmentation: () => fixture.active,
      getActiveSegment: () => fixture.active?.segments[1],
      getSegmentation: () => fixture.active,
      setActiveSegment() {},
      addSegment(id, config) {
        fixture.active.segments[config.segmentIndex] = { ...config };
      },
      removeSegment(id, index) {
        for (let i = 0; i < pixels.length; i++) if (pixels[i] === index) pixels[i] = 0;
        delete fixture.active.segments[index];
      },
    },
  };
  fixture.commands = createMaskCommands({ servicesManager: { services } });
  return fixture;
}

test('stack edits match the source image reference, not a slice ordinal', () => {
  const f = setup([0, 0, 2]);
  assert.equal(f.commands.thresholdMaskSlice({ lower: 150, upper: 300 }).changed, 2);
  assert.deepEqual([...f.pixels], [1, 1, 2]);
  assert.deepEqual(notifications, ['mask']);
});

test('threshold converts unscaled DICOM pixels using rescale slope and intercept', () => {
  const f = setup([0, 0], 2, 1, [1024, 1200]);
  f.source.isPreScaled = false;
  f.source.intercept = -1024;
  f.commands.thresholdMaskSlice({ lower: 150, upper: 300 });
  assert.deepEqual([...f.pixels], [0, 1]);
});

test('pre-scaled HU values are not rescaled a second time', () => {
  const f = setup([0, 0], 2, 1, [0, 200]);
  f.source.intercept = -1024;
  f.commands.thresholdMaskSlice({ lower: 150, upper: 300 });
  assert.deepEqual([...f.pixels], [0, 1]);
});

test('locked masks reject every operation without changing data or history', () => {
  const f = setup([1, 0, 1]);
  f.active.segments[1].locked = true;
  assert.throws(() => f.commands.thresholdMaskSlice({ lower: 0, upper: 500 }), /锁定/);
  assert.throws(() => f.commands.fillMaskHoles(), /锁定/);
  assert.throws(() => f.commands.splitMaskComponents(), /锁定/);
  assert.deepEqual([...f.pixels], [1, 0, 1]);
  assert.equal(history.length, 0);
});

test('missing image correspondence is rejected instead of modifying the wrong image', () => {
  const f = setup([0]);
  f.active.representationData.Labelmap.referencedImageIds = ['unrelated-a', 'unrelated-b'];
  assert.throws(() => f.commands.fillMaskHoles(), /对应/);
  assert.deepEqual([...f.pixels], [0]);
});

test('fill can be undone and redone through the shared history contract', () => {
  const f = setup([1, 1, 1, 1, 0, 1, 1, 1, 1], 3, 3);
  assert.equal(f.commands.fillMaskHoles().changed, 1);
  assert.equal(f.pixels[4], 1);
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.equal(f.pixels[4], 0);
  history[0].restoreMemo(false);
  assert.equal(f.pixels[4], 1);
});

test('split undo and redo restore both pixel labels and segment metadata', () => {
  const f = setup([1, 0, 1]);
  f.commands.splitMaskComponents();
  assert.deepEqual([...f.pixels], [1, 0, 2]);
  assert.equal(f.active.segments[2].label, 'Bone / 2');
  history[0].restoreMemo(true);
  assert.deepEqual([...f.pixels], [1, 0, 1]);
  assert.equal(f.active.segments[2], undefined);
  history[0].restoreMemo(false);
  assert.deepEqual([...f.pixels], [1, 0, 2]);
  assert.equal(f.active.segments[2].label, 'Bone / 2');
});

test('no-op operations do not pollute undo history', () => {
  const f = setup([0, 0]);
  assert.equal(f.commands.fillMaskHoles().changed, 0);
  assert.equal(f.commands.splitMaskComponents().changed, 0);
  assert.equal(history.length, 0);
});

test('three-dimensional perspective viewports are rejected', () => {
  const f = setup([0]);
  f.viewport = {};
  assert.throws(() => f.commands.fillMaskHoles(), /CT 切片窗口/);
});

function makeVolume() {
  const f = setup(Array(18).fill(0));
  const geometry = {
    dimensions: [3, 3, 2],
    origin: [0, 0, 0],
    spacing: [1, 1, 1],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    imageData: {},
  };
  const labelVolume = { ...geometry, voxelManager: f.manager, dataType: 'Uint8Array' };
  const sourceVolume = {
    ...geometry,
    voxelManager: voxelManager(Array(18).fill(200)),
    imageIds: ['reference-b', 'reference-b'],
    isDynamicVolume: () => false,
  };
  f.active.representationData.Labelmap = { volumeId: 'label-volume' };
  f.viewport = new VolumeViewport();
  volumes.set('label-volume', labelVolume);
  volumes.set('source-volume', sourceVolume);
  return { ...f, labelVolume, sourceVolume };
}

test('volume threshold changes only the plane displayed by the active camera', () => {
  const f = makeVolume();
  f.commands.thresholdMaskSlice({ lower: 150, upper: 300 });
  assert.deepEqual([...f.pixels], [...Array(9).fill(0), ...Array(9).fill(1)]);
});

test('orthographic slice editing also accepts an image-backed labelmap', () => {
  const f = makeVolume();
  f.active.representationData.Labelmap = { imageIds: ['label-b'] };
  f.commands.thresholdMaskSlice({ lower: 150, upper: 300 });
  assert.deepEqual([...f.pixels], [...Array(9).fill(0), ...Array(9).fill(1)]);
});

test('a pending orthographic labelmap reports loading rather than a wrong viewport type', () => {
  const f = makeVolume();
  f.active.representationData.Labelmap = { imageIds: ['label-b'] };
  volumes.delete('label-volume');
  assert.throws(() => f.commands.fillMaskHoles(), /Mask 体数据尚未就绪/);
});

test('stack slice editing can resolve images from a volume-backed labelmap', () => {
  const f = setup([0, 0]);
  f.active.representationData.Labelmap = { volumeId: 'label-volume' };
  volumes.set('label-volume', { imageIds: ['label-b'] });
  images.get('label-b').referencedImageId = 'reference-b';
  f.commands.thresholdMaskSlice({ lower: 150, upper: 300 });
  assert.deepEqual([...f.pixels], [1, 1]);
});

test('a pending stack labelmap reports loading rather than a three-dimensional view', () => {
  const f = setup([0]);
  f.active.representationData.Labelmap = {};
  assert.throws(() => f.commands.fillMaskHoles(), /Mask 数据尚未就绪/);
});

test('volume threshold rejects mismatched source geometry', () => {
  const f = makeVolume();
  f.sourceVolume.origin = [10, 0, 0];
  assert.throws(() => f.commands.thresholdMaskSlice({ lower: 150, upper: 300 }), /空间信息/);
  assert.deepEqual([...f.pixels], Array(18).fill(0));
});

test('oblique volume views are rejected before writing pixels', () => {
  const f = makeVolume();
  f.viewport.getCamera = () => ({ viewPlaneNormal: [1, 1, 0], focalPoint: [0, 0, 1] });
  assert.throws(() => f.commands.fillMaskHoles(), /斜切面/);
  assert.equal(history.length, 0);
});

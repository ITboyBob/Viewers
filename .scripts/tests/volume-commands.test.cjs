const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const images = new Map();
const history = [];
let fixture;
let nextIdentity = 0;
class StackViewport {}
class VolumeViewport {}
function manager(pixels) {
  return {
    getAtIndex: index => pixels[index],
    getScalarData: () => pixels,
    setAtIndex(index, value) {
      pixels[index] = value;
      fixture.onWrite?.();
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
globalThis.__volumeMaskSdk = {
  StackViewport,
  VolumeViewport,
  cache: { getImage: id => images.get(id), getVolume: () => undefined },
  imageLoader: {
    loadAndCacheImage: async id => {
      if (fixture.load) return fixture.load(id);
      throw new Error(`load failed: ${id}`);
    },
  },
  eventTarget: { dispatchEvent: () => true },
  utilities: {
    transformWorldToIndex: (_, point) => point,
    transformIndexToWorld: (_, point) => [point[0], point[1], point[2] * fixture.volume.spacing[2]],
    uuidv4: () => `whole-operation-${++nextIdentity}`,
    HistoryMemo: { DefaultHistoryMemo: { push: memo => history.push(memo) } },
  },
  segmentation: {
    getLabelmapImageIds: () => ['label-0', 'label-1'],
    segmentLocking: { isSegmentIndexLocked: () => fixture.locked },
    triggerSegmentationEvents: { triggerSegmentationDataModified() {} },
  },
  toolUtilities: {
    segmentation: {
      LabelmapMemo: { createLabelmapMemo },
      getOrCreateSegmentationVolume: () => fixture.volume,
    },
  },
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './createMaskProjectCommands')
      return { url: 'volume-mask:project-commands', shortCircuit: true };
    if (specifier === './createMaskVisibilityCommands')
      return { url: 'volume-mask:visibility-commands', shortCircuit: true };
    if (specifier === '@cornerstonejs/core') return { url: 'volume-mask:core', shortCircuit: true };
    if (specifier === '@cornerstonejs/tools')
      return { url: 'volume-mask:tools', shortCircuit: true };
    if (
      [
        './maskAlgorithms',
        './volumeAlgorithms',
        './maskOperationEvents',
        './maskRoi',
        './createMaskRefinementCommands',
        './refinementAlgorithms',
        './maskRefinementEvents',
        './maskHistory',
      ].includes(specifier)
    )
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'volume-mask:project-commands')
      return { format: 'module', shortCircuit: true, source: 'export default () => ({})' };
    if (url === 'volume-mask:visibility-commands')
      return { format: 'module', shortCircuit: true, source: 'export default () => ({})' };
    if (url === 'volume-mask:core')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const {StackViewport,VolumeViewport,cache,imageLoader,eventTarget,utilities}=globalThis.__volumeMaskSdk; export const metaData={get:(_,id)=>globalThis.__volumeMaskSdk.metadata?.(id)}; export const Types={};',
      };
    if (url === 'volume-mask:tools')
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const {segmentation}=globalThis.__volumeMaskSdk; export const utilities=globalThis.__volumeMaskSdk.toolUtilities;',
      };
    return next(url, context);
  },
});
const createVolumeMaskCommands =
  require('../../extensions/cornerstone/src/utils/maskEditing/createVolumeMaskCommands.ts').default;
hooks.deregister();

function setup(
  labels = [
    [0, 0],
    [0, 0],
  ],
  raw = [
    [200, 0],
    [0, 200],
  ]
) {
  images.clear();
  history.length = 0;
  nextIdentity = 0;
  const pixels = labels.map(values => Uint8Array.from(values));
  const active = {
    segmentationId: 'mask',
    representationData: { Labelmap: {} },
    segments: { 1: { label: 'Mask 1' } },
  };
  pixels.forEach(values =>
    values.forEach(value => {
      if (value) active.segments[value] ||= { label: `Mask ${value}` };
    })
  );
  fixture = { pixels, active, locked: false, segmentIndex: 1 };
  fixture.displaySet = { isReconstructable: true };
  fixture.volume = {
    dimensions: [2, 1, 2],
    spacing: [1, 1, 2],
    imageData: {},
    dataType: 'Uint8Array',
    voxelManager: {
      getAtIndex: index => pixels[Math.floor(index / 2)][index % 2],
      setAtIndex: (index, value) => {
        pixels[Math.floor(index / 2)][index % 2] = value;
        fixture.onWrite?.();
      },
    },
  };
  for (let i = 0; i < 2; i++) {
    images.set(`label-${i}`, {
      columns: 2,
      rows: 1,
      voxelManager: manager(pixels[i]),
      referencedImageId: `ref-${i}`,
    });
    images.set(`ref-${i}`, {
      columns: 2,
      rows: 1,
      color: false,
      isPreScaled: true,
      getPixelData: () => Int16Array.from(raw[i]),
      slope: 1,
      intercept: 0,
    });
  }
  fixture.commands = createVolumeMaskCommands({
    servicesManager: {
      services: {
        viewportGridService: {
          getActiveViewportId: () => 'viewport',
          getDisplaySetsUIDsForViewport: () => ['case'],
        },
        displaySetService: { getDisplaySetByUID: () => fixture.displaySet },
        cornerstoneViewportService: { getCornerstoneViewport: () => new StackViewport() },
        segmentationService: {
          getActiveSegmentation: () => active,
          getActiveSegment: () => ({ segmentIndex: fixture.segmentIndex }),
          getSegmentation: () => active,
          addSegment: (_, config) => {
            active.segments[config.segmentIndex] = { ...config };
            fixture.segmentIndex = config.segmentIndex;
          },
          setActiveSegment: (_, index) => {
            fixture.segmentIndex = index;
          },
          removeSegment: (_, index) => {
            delete active.segments[index];
            pixels.forEach(values => {
              for (let i = 0; i < values.length; i++) if (values[i] === index) values[i] = 0;
            });
          },
        },
      },
    },
  });
  return fixture;
}

test('whole-series threshold selects every frame and creates one undo item', async () => {
  const f = setup();
  assert.equal((await f.commands.thresholdMaskSeries({ lower: 150, upper: 300 })).changed, 2);
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [1, 0],
      [0, 1],
    ]
  );
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [0, 0],
      [0, 0],
    ]
  );
  history[0].restoreMemo(false);
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [1, 0],
      [0, 1],
    ]
  );
});

test('replacement removes only the current label and preserves other masks', async () => {
  const f = setup(
    [
      [1, 2],
      [2, 1],
    ],
    [
      [0, 200],
      [200, 0],
    ]
  );
  await f.commands.thresholdMaskSeries({ lower: 150, upper: 300 });
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [0, 2],
      [2, 0],
    ]
  );
});

test('additive threshold preserves manual labels outside the chosen range', async () => {
  const f = setup(
    [
      [1, 0],
      [0, 1],
    ],
    [
      [0, 200],
      [200, 0],
    ]
  );
  await f.commands.thresholdMaskSeries({ lower: 150, upper: 300, replace: false });
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [1, 1],
      [1, 1],
    ]
  );
});

test('a source frame that cannot load leaves every mask unchanged', async () => {
  const f = setup();
  images.delete('ref-1');
  await assert.rejects(f.commands.thresholdMaskSeries({ lower: 150, upper: 300 }), /load failed/);
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [0, 0],
      [0, 0],
    ]
  );
  assert.equal(history.length, 0);
});

test('locking during processing rolls back earlier frame writes', async () => {
  const f = setup();
  f.onWrite = () => {
    f.locked = true;
  };
  await assert.rejects(f.commands.thresholdMaskSeries({ lower: 150, upper: 300 }), /锁定/);
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [0, 0],
      [0, 0],
    ]
  );
  assert.equal(history.length, 0);
});

test('invalid threshold input does not change data or history', async () => {
  const f = setup();
  await assert.rejects(f.commands.thresholdMaskSeries({ lower: 300, upper: 150 }), /下限/);
  assert.equal(history.length, 0);
});

test('reapplying the same threshold does not create a redundant undo step', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  assert.equal((await f.commands.thresholdMaskSeries({ lower: 150, upper: 300 })).changed, 0);
  assert.equal(history.length, 0);
});

test('whole-series thresholds rescale raw CT values once and preserve existing HU values', async () => {
  const f = setup(
    [
      [0, 0],
      [0, 0],
    ],
    [
      [1024, 1224],
      [200, 0],
    ]
  );
  Object.assign(images.get('ref-0'), { isPreScaled: false, intercept: -1024 });
  Object.assign(images.get('ref-1'), { isPreScaled: true, intercept: -1024 });
  await f.commands.thresholdMaskSeries({ lower: 150, upper: 300 });
  assert.deepEqual(
    f.pixels.map(values => Array.from(values)),
    [
      [0, 1],
      [1, 0],
    ]
  );
});

test('overlapping whole-series operations are rejected until the first completes', async () => {
  const f = setup();
  const source = images.get('ref-0');
  images.delete('ref-0');
  let release;
  f.load = () =>
    new Promise(resolve => {
      release = () => resolve(source);
    });
  const first = f.commands.thresholdMaskSeries({ lower: 150, upper: 300 });
  await assert.rejects(f.commands.thresholdMaskSeries({ lower: 150, upper: 300 }), /正在处理/);
  release();
  await first;
  assert.equal(history.length, 1);
});

test('three-dimensional split preview does not mutate pixels or metadata', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const result = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  assert.equal(result.preview.components.length, 2);
  assert.equal(result.preview.components[0].volumeMm3, 2);
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 1],
    ]
  );
  assert.deepEqual(Object.keys(f.active.segments), ['1']);
  assert.equal(history.length, 0);
});

test('global split undo and redo restore both labels and metadata in one step', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  await f.commands.applyMaskSplit({ previewId: preview.id });
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 2],
    ]
  );
  assert.equal(f.active.segments[2].label, 'Mask 1 / 2');
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 1],
    ]
  );
  assert.equal(f.active.segments[2], undefined);
  history[0].restoreMemo(false);
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 2],
    ]
  );
  assert.equal(f.active.segments[2].label, 'Mask 1 / 2');
});

test('global split protects other labels and never reuses their IDs', async () => {
  const f = setup([
    [1, 2],
    [0, 1],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  await f.commands.applyMaskSplit({ previewId: preview.id });
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 2],
      [0, 3],
    ]
  );
});

test('a modified mask invalidates its preview before any metadata is created', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  f.pixels[0][1] = 1;
  await assert.rejects(f.commands.applyMaskSplit({ previewId: preview.id }), /重新分析/);
  assert.deepEqual(Object.keys(f.active.segments), ['1']);
  assert.equal(history.length, 0);
});

test('closed previews cannot later modify the mask', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  f.commands.discardMaskSplitPreview({ previewId: preview.id });
  await assert.rejects(f.commands.applyMaskSplit({ previewId: preview.id }), /失效/);
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 1],
    ]
  );
});

test('failed global split writes roll back pixels and all newly created segments', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  f.onWrite = () => {
    f.locked = true;
  };
  await assert.rejects(f.commands.applyMaskSplit({ previewId: preview.id }), /锁定/);
  assert.deepEqual(
    f.pixels.map(values => [...values]),
    [
      [1, 0],
      [0, 1],
    ]
  );
  assert.deepEqual(Object.keys(f.active.segments), ['1']);
  assert.equal(history.length, 0);
});

test('one connected volume is not split into artificial empty segments', async () => {
  const f = setup([
    [1, 0],
    [1, 0],
  ]);
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  assert.equal(preview.components.length, 1);
  assert.equal((await f.commands.applyMaskSplit({ previewId: preview.id })).changed, 0);
  assert.equal(history.length, 0);
  assert.deepEqual(Object.keys(f.active.segments), ['1']);
});

test('new split labels never consume the SDK temporary brush-preview label', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  for (let index = 2; index < 255; index++)
    f.active.segments[index] = { label: `Reserved ${index}` };
  const { preview } = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  await assert.rejects(f.commands.applyMaskSplit({ previewId: preview.id }), /编号不足/);
  assert.equal(f.active.segments[255], undefined);
  assert.equal(history.length, 0);
});

test('an old preview token cannot discard or apply a newer analysis', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const first = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  const second = await f.commands.analyzeMaskSplit({ minimumVoxels: 1 });
  await assert.rejects(f.commands.applyMaskSplit({ previewId: first.preview.id }), /失效/);
  assert.equal((await f.commands.applyMaskSplit({ previewId: second.preview.id })).applied, true);
});

test('whole-series filling applies each slice and restores all slices in one undo', async () => {
  const ring = [1, 1, 1, 1, 0, 1, 1, 1, 1];
  const f = setup([ring, ring]);
  for (const id of ['label-0', 'label-1']) Object.assign(images.get(id), { columns: 3, rows: 3 });
  assert.equal((await f.commands.fillMaskHolesSeries()).changed, 2);
  assert.equal(f.pixels[0][4], 1);
  assert.equal(f.pixels[1][4], 1);
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.equal(f.pixels[0][4], 0);
  assert.equal(f.pixels[1][4], 0);
  history[0].restoreMemo(false);
  assert.equal(f.pixels[0][4], 1);
  assert.equal(f.pixels[1][4], 1);
});

test('whole-series filling preserves a different mask inside a closed boundary', async () => {
  const f = setup([
    [1, 1, 1, 1, 2, 1, 1, 1, 1],
    [1, 1, 1, 1, 0, 1, 1, 1, 1],
  ]);
  for (const id of ['label-0', 'label-1']) Object.assign(images.get(id), { columns: 3, rows: 3 });
  assert.equal((await f.commands.fillMaskHolesSeries()).changed, 1);
  assert.equal(f.pixels[0][4], 2);
});

test('whole-series filling rolls back earlier slices if the mask becomes locked', async () => {
  const ring = [1, 1, 1, 1, 0, 1, 1, 1, 1];
  const f = setup([ring, ring]);
  for (const id of ['label-0', 'label-1']) Object.assign(images.get(id), { columns: 3, rows: 3 });
  f.onWrite = () => {
    f.locked = true;
  };
  await assert.rejects(f.commands.fillMaskHolesSeries(), /锁定/);
  assert.equal(f.pixels[0][4], 0);
  assert.equal(f.pixels[1][4], 0);
  assert.equal(history.length, 0);
});

test('reading keyframe layers is read-only and ignores other Mask pixels', async () => {
  const f = setup([
    [1, 0],
    [2, 0],
  ]);
  assert.deepEqual((await f.commands.getMaskInterpolationKeyframes()).keyframes, [1]);
  f.segmentIndex = 2;
  assert.deepEqual((await f.commands.getMaskInterpolationKeyframes()).keyframes, [2]);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [2, 0],
    ]
  );
  assert.equal(history.length, 0);
});
test('keyframe discovery rejects more than 64 layers without truncation or edits', async () => {
  const f = setup(Array.from({ length: 65 }, () => [1, 0]));
  f.volume.dimensions[2] = 65;
  await assert.rejects(f.commands.getMaskInterpolationKeyframes(), /超过 64/);
  assert.equal(history.length, 0);
});
test('multiple keyframe interpolation publishes statistics and applies as one undoable edit', async () => {
  const f = setup([
    [1, 0],
    [0, 0],
    [1, 0],
    [0, 0],
    [1, 0],
  ]);
  f.volume.dimensions[2] = 5;
  const original = f.pixels.map(v => [...v]);
  const { preview } = await f.commands.previewMaskRefinement({
    operation: 'interpolate',
    keyframes: [1, 3, 5],
  });
  assert.deepEqual(preview.keyframes, [1, 3, 5]);
  assert.equal(preview.interpolatedSlices, 2);
  assert.equal(preview.skippedSlices, 0);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    original
  );
  await f.commands.applyMaskRefinement({ previewId: preview.id });
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    Array.from({ length: 5 }, () => [1, 0])
  );
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    original
  );
});
test('3D morphology preview is read-only and applying it protects other masks with one undo/redo', async () => {
  const f = setup([
    [1, 0],
    [2, 0],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
  assert.equal(preview.added, 1);
  assert.equal(preview.removed, 0);
  assert.equal(history.length, 0);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [2, 0],
    ]
  );
  await f.commands.applyMaskRefinement({ previewId: preview.id });
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 1],
      [2, 0],
    ]
  );
  assert.equal(history.length, 1);
  history[0].restoreMemo(true);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [2, 0],
    ]
  );
  history[0].restoreMemo(false);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 1],
      [2, 0],
    ]
  );
});
test('mask changes invalidate the refinement result before any writes', async () => {
  const f = setup([
    [1, 0],
    [0, 0],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
  f.pixels[0][1] = 2;
  await assert.rejects(f.commands.applyMaskRefinement({ previewId: preview.id }), /已发生修改/);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 2],
      [0, 0],
    ]
  );
  assert.equal(history.length, 0);
});
test('old refinement tokens cannot discard or apply a more recent preview', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const first = await f.commands.previewMaskRefinement({ operation: 'largest' });
  const second = await f.commands.previewMaskRefinement({
    operation: 'removeSmall',
    minimumVolumeMm3: 3,
  });
  f.commands.discardMaskRefinementPreview({ previewId: first.preview.id });
  await assert.rejects(f.commands.applyMaskRefinement({ previewId: first.preview.id }), /失效/);
  assert.ok(f.commands.getMaskRefinementPreviewData({ previewId: second.preview.id }));
  await f.commands.applyMaskRefinement({ previewId: second.preview.id });
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [0, 0],
      [0, 0],
    ]
  );
});
test('a no-op refinement does not add a history entry; locked masks reject previews', async () => {
  const f = setup([
    [1, 0],
    [0, 0],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({
    operation: 'dilate',
    radiusMm: 0.1,
  });
  assert.equal((await f.commands.applyMaskRefinement({ previewId: preview.id })).changed, 0);
  assert.equal(history.length, 0);
  f.locked = true;
  await assert.rejects(f.commands.previewMaskRefinement({ operation: 'largest' }), /锁定/);
});
test('locking during refinement application rolls back all pixels', async () => {
  const f = setup([
    [1, 0],
    [0, 0],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 3 });
  f.onWrite = () => {
    f.locked = true;
  };
  await assert.rejects(f.commands.applyMaskRefinement({ previewId: preview.id }), /锁定/);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [0, 0],
    ]
  );
  assert.equal(history.length, 0);
});
test('physical volume cleanup and seed deletion keep source masks unchanged until application', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({
    operation: 'removeSeed',
    worldPoint: [0, 0, 0],
  });
  assert.equal(preview.removed, 1);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [0, 1],
    ]
  );
  await f.commands.applyMaskRefinement({ previewId: preview.id });
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [0, 0],
      [0, 1],
    ]
  );
});
test('cancelling a calculation before publication leaves pixels and history unchanged', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const computation = f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
  assert.equal(f.commands.cancelMaskRefinementCalculation().cancelled, true);
  const result = await computation;
  assert.equal(result.cancelled, true);
  assert.equal(result.preview, undefined);
  assert.deepEqual(
    f.pixels.map(v => [...v]),
    [
      [1, 0],
      [0, 1],
    ]
  );
  assert.equal(history.length, 0);
  const next = await f.commands.previewMaskRefinement({ operation: 'largest' });
  assert.ok(next.preview, 'cancellation must release batch exclusion');
});
test('worker progress is not a final result; cancellation terminates the worker and ignores late replies', async () => {
  const previousWorker = global.Worker,
    previousDispatch = globalThis.__volumeMaskSdk.eventTarget.dispatchEvent;
  const events = [];
  let worker;
  globalThis.__volumeMaskSdk.eventTarget.dispatchEvent = event => {
    events.push(event);
    return true;
  };
  global.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const f = setup([
      [1, 0],
      [0, 1],
    ]);
    const computation = f.commands.previewMaskRefinement({ operation: 'smooth', radiusMm: 1 });
    const task = events.find(event => event.type === 'OHIF_MASK_REFINEMENT_TASK').detail;
    const reply = worker.onmessage;
    reply({ data: { type: 'progress', completed: 1, total: 4 } });
    assert.ok(!worker.terminated);
    assert.equal(
      f.commands.cancelMaskRefinementCalculation({ taskId: 'stale-task' }).cancelled,
      false
    );
    assert.equal(f.commands.cancelMaskRefinementCalculation({ taskId: task.id }).cancelled, true);
    assert.ok(worker.terminated);
    reply({ data: { mask: new Uint8Array(4).fill(1) } });
    assert.equal((await computation).cancelled, true);
    assert.deepEqual(
      f.pixels.map(v => [...v]),
      [
        [1, 0],
        [0, 1],
      ]
    );
    assert.equal(history.length, 0);
    assert.equal(
      events.filter(event => event.type === 'OHIF_MASK_REFINEMENT_TASK').at(-1).detail.phase,
      'cancelled'
    );
  } finally {
    global.Worker = previousWorker;
    globalThis.__volumeMaskSdk.eventTarget.dispatchEvent = previousDispatch;
  }
});
test('discarding during computation cancels it while an old preview token cannot cancel a newer task', async () => {
  const f = setup([
    [1, 0],
    [0, 1],
  ]);
  const { preview } = await f.commands.previewMaskRefinement({ operation: 'largest' });
  const previousWorker = global.Worker;
  let worker;
  global.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const computation = f.commands.previewMaskRefinement({ operation: 'smooth', radiusMm: 1 });
    f.commands.discardMaskRefinementPreview({ previewId: preview.id });
    assert.ok(!worker.terminated);
    f.commands.discardMaskRefinementPreview();
    assert.ok(worker.terminated);
    assert.equal((await computation).cancelled, true);
    assert.equal(history.length, 0);
  } finally {
    global.Worker = previousWorker;
  }
});
test('worker failure terminates computation and allows another operation without partial edits', async () => {
  const f = setup([
      [1, 0],
      [0, 1],
    ]),
    previousWorker = global.Worker;
  let worker;
  global.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const computation = f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
    worker.onerror({ preventDefault() {} });
    await assert.rejects(computation, /计算失败/);
    assert.ok(worker.terminated);
    assert.deepEqual(
      f.pixels.map(v => [...v]),
      [
        [1, 0],
        [0, 1],
      ]
    );
    assert.equal(history.length, 0);
  } finally {
    global.Worker = previousWorker;
  }
  assert.equal((await f.commands.thresholdMaskSeries({ lower: 1000, upper: 2000 })).changed, 2);
});
test('cancellation at final progress cannot publish a preview, and a published preview is no longer cancellable', async () => {
  const f = setup([
      [1, 0],
      [0, 1],
    ]),
    previousDispatch = globalThis.__volumeMaskSdk.eventTarget.dispatchEvent;
  let cancelAtCompletion = true,
    publishedCancellation;
  globalThis.__volumeMaskSdk.eventTarget.dispatchEvent = event => {
    if (
      event.type === 'OHIF_MASK_REFINEMENT_TASK' &&
      event.detail.phase === 'running' &&
      event.detail.percent === 100 &&
      cancelAtCompletion
    ) {
      cancelAtCompletion = false;
      f.commands.cancelMaskRefinementCalculation({ taskId: event.detail.id });
    }
    if (event.type === 'OHIF_MASK_REFINEMENT_PREVIEW' && event.detail.preview)
      publishedCancellation = f.commands.cancelMaskRefinementCalculation();
    return true;
  };
  try {
    const cancelled = await f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.preview, undefined);
    const completed = await f.commands.previewMaskRefinement({ operation: 'dilate', radiusMm: 1 });
    assert.ok(completed.preview);
    assert.equal(publishedCancellation.cancelled, false);
    assert.deepEqual(
      f.pixels.map(v => [...v]),
      [
        [1, 0],
        [0, 1],
      ]
    );
    assert.equal(history.length, 0);
  } finally {
    globalThis.__volumeMaskSdk.eventTarget.dispatchEvent = previousDispatch;
  }
});
test('ROI morphology preserves outside labels and refuses an outdated ROI snapshot', async () => {
  const {
    maskRoiSettings,
  } = require('../../extensions/cornerstone/src/utils/maskEditing/maskRoi.ts');
  const f = setup([
      [1, 0],
      [0, 0],
    ]),
    roi = {
      seriesInstanceUID: 'series',
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      min: [0, 0, 0],
      max: [1, 0, 0],
    };
  globalThis.__volumeMaskSdk.metadata = () => ({ SeriesInstanceUID: 'series' });
  // Existing display set fixture only requires a source image identity for ROI resolution.
  fixture.displaySet.imageIds = ['ref-0', 'ref-1'];
  maskRoiSettings.set('series', roi);
  try {
    let { preview } = await f.commands.previewMaskRefinement({
      operation: 'dilate',
      radiusMm: 3,
      useRoi: true,
    });
    assert.equal(preview.added, 1);
    await f.commands.applyMaskRefinement({ previewId: preview.id });
    assert.deepEqual(
      f.pixels.map(v => [...v]),
      [
        [1, 1],
        [0, 0],
      ]
    );
    history[0].restoreMemo(true);
    ({ preview } = await f.commands.previewMaskRefinement({
      operation: 'dilate',
      radiusMm: 3,
      useRoi: true,
    }));
    maskRoiSettings.set('series', { ...roi, max: [0, 0, 0] });
    await assert.rejects(f.commands.applyMaskRefinement({ previewId: preview.id }), /ROI 已改变/);
    assert.deepEqual(
      f.pixels.map(v => [...v]),
      [
        [1, 0],
        [0, 0],
      ]
    );
  } finally {
    maskRoiSettings.clear();
    delete globalThis.__volumeMaskSdk.metadata;
  }
});
test('HU grow resolves source geometry and applies rescale exactly once for raw or pre-scaled pixels', async () => {
  try {
    for (const scaled of [false, true]) {
      const f = setup(
        [
          [0, 0],
          [0, 0],
        ],
        scaled
          ? [
              [100, -1000],
              [100, -1000],
            ]
          : [
              [1100, 0],
              [1100, 0],
            ]
      );
      fixture.displaySet.imageIds = ['ref-0', 'ref-1'];
      fixture.volume.imageData.worldToIndex = point => [point[0], point[1], point[2] / 2];
      globalThis.__volumeMaskSdk.metadata = id => ({
        SeriesInstanceUID: 'series',
        NumberOfFrames: 1,
        Rows: 1,
        Columns: 2,
        ImagePositionPatient: [0, 0, id === 'ref-1' ? 2 : 0],
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        PixelSpacing: [1, 1],
      });
      for (const id of ['ref-0', 'ref-1'])
        Object.assign(images.get(id), { isPreScaled: scaled, slope: 1, intercept: -1000 });
      const { preview } = await f.commands.previewMaskRefinement({
        operation: 'huGrow',
        lower: 50,
        upper: 150,
        worldPoint: [0, 0, 0],
      });
      assert.equal(preview.added, 2);
      assert.deepEqual(
        f.pixels.map(v => [...v]),
        [
          [0, 0],
          [0, 0],
        ]
      );
      await f.commands.applyMaskRefinement({ previewId: preview.id });
      assert.deepEqual(
        f.pixels.map(v => [...v]),
        [
          [1, 0],
          [1, 0],
        ]
      );
      history[0].restoreMemo(true);
      assert.deepEqual(
        f.pixels.map(v => [...v]),
        [
          [0, 0],
          [0, 0],
        ]
      );
    }
  } finally {
    delete globalThis.__volumeMaskSdk.metadata;
  }
});

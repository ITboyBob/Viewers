const { test } = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
function compiled(name, dependencies = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(
    fs.readFileSync(
      path.resolve(__dirname, '../../extensions/cornerstone/src/utils/maskEditing/' + name + '.ts'),
      'utf8'
    ),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }
  ).outputText;
  new Function('require', 'module', 'exports', output)(
    key => dependencies[key] || require(key),
    module,
    module.exports
  );
  return module.exports;
}
const { MaskProgressStore, trackMaskProgress, maskProgress } = compiled('maskProgress', {
  './maskRoiStore': { MASK_ROI_EVENT: 'roi-event' },
  './maskRoi': { maskRoiSettings: new Map() },
  '@cornerstonejs/core': { eventTarget: new EventTarget() },
  '@cornerstonejs/tools': {
    Enums: { SegmentationRepresentations: { Labelmap: 'Labelmap' } },
    segmentation: { config: { visibility: { getSegmentIndexVisibility: () => true } } },
  },
});
test('automatic backup waits until drawing ends and the idle interval passes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  global.window = new EventTarget();
  let calls = 0;
  const current = { label: 'Set', representationData: { Labelmap: {} }, segments: {} };
  const EVENTS = Object.fromEntries(
    [
      'SEGMENTATION_MODIFIED',
      'SEGMENTATION_REPRESENTATION_MODIFIED',
      'SEGMENTATION_DATA_MODIFIED',
      'SEGMENTATION_REMOVED',
    ].map(key => [key, key])
  );
  const service = {
    EVENTS,
    subscribe: () => ({ unsubscribe() {} }),
    getSegmentation: () => current,
    getSegmentations: () => [{ segmentationId: 'a' }],
    getViewportIdsWithSegmentation: () => [],
  };
  const stop = trackMaskProgress(
    {
      services: {
        segmentationService: service,
        cornerstoneViewportService: {
          getRenderingEngine: () => ({
            getViewports: () => [{ element: { contains: () => true } }],
          }),
        },
      },
    },
    {
      async run() {
        calls++;
        maskProgress.drafted('a', maskProgress.get('a').revision, 'date');
      },
    }
  );
  try {
    const down = new Event('pointerdown');
    Object.defineProperty(down, 'pointerId', { value: 1 });
    window.dispatchEvent(down);
    context.mock.timers.tick(6000);
    assert.equal(calls, 0);
    const up = new Event('pointerup');
    Object.defineProperty(up, 'pointerId', { value: 1 });
    window.dispatchEvent(up);
    context.mock.timers.tick(4999);
    assert.equal(calls, 0);
    context.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    stop();
    delete global.window;
  }
});
test('a slow manual save does not clear newer edits', () => {
  const store = new MaskProgressStore();
  store.change('a');
  const token = store.get('a').revision;
  store.change('a');
  store.saved('a', token);
  assert.equal(store.dirty('a'), true);
  store.saved('a', store.get('a').revision);
  assert.equal(store.dirty('a'), false);
});
test('identical logical content clears false dirty notifications without clearing edits made during verification', () => {
  const store = new MaskProgressStore();
  store.change('a');
  store.saved('a', 1, 'original');
  store.change('a');
  store.drafted('a', 2, 'date', 'original');
  assert.equal(store.dirty('a'), false);
  store.change('a');
  const snapshotRevision = store.get('a').revision;
  store.change('a');
  store.drafted('a', snapshotRevision, 'date', 'original');
  assert.equal(store.dirty('a'), true);
});
test('automatic draft keeps the manual unsaved warning and detects later edits', () => {
  const store = new MaskProgressStore();
  store.change('a');
  store.drafted('a', 1, '2026-11-02');
  assert.equal(store.dirty('a'), true);
  store.change('a');
  assert.notEqual(store.get('a').draftRevision, store.get('a').revision);
});
test('draft failures preserve the last successful checkpoint revision', () => {
  const store = new MaskProgressStore();
  store.change('a');
  store.drafted('a', 1, 'date');
  store.change('a');
  store.failed('a', 'quota');
  assert.equal(store.get('a').draftRevision, 1);
  assert.equal(store.get('a').error, 'quota');
  store.change('a');
  assert.equal(store.get('a').error, undefined);
});
test('dirty state tracks multiple sets and cleans up deleted sets', () => {
  const store = new MaskProgressStore();
  store.change('a');
  store.change('b');
  store.saved('a', 1);
  assert.deepEqual(store.dirtyIds(), ['b']);
  store.remove('b');
  assert.deepEqual(store.dirtyIds(), []);
});
test('statistics updates do not create new unsaved modifications; names and styles do', () => {
  global.window = new EventTarget();
  const listeners = {},
    current = {
      representationData: { Labelmap: {} },
      label: 'Set',
      segments: { 1: { segmentIndex: 1, label: 'Bone', locked: false, cachedStats: {} } },
    };
  const style = { fillAlpha: 0.5, outlineWidth: 3, renderFill: true, renderOutline: true };
  const EVENTS = Object.fromEntries(
    [
      'SEGMENTATION_MODIFIED',
      'SEGMENTATION_REPRESENTATION_MODIFIED',
      'SEGMENTATION_DATA_MODIFIED',
      'SEGMENTATION_REMOVED',
    ].map(key => [key, key])
  );
  const service = {
    EVENTS,
    subscribe: (name, callback) => {
      listeners[name] = callback;
      return { unsubscribe() {} };
    },
    getSegmentation: () => current,
    getSegmentations: () => [{ segmentationId: 'a' }],
    getViewportIdsWithSegmentation: () => ['v'],
    getStyle: () => style,
    getSegmentColor: () => [255, 0, 0, 255],
  };
  const stop = trackMaskProgress({ services: { segmentationService: service } }, { run() {} });
  try {
    const version = maskProgress.get('a').revision;
    current.segments[1].cachedStats = { volume: 100 };
    listeners.SEGMENTATION_MODIFIED({ segmentationId: 'a' });
    assert.equal(maskProgress.get('a').revision, version);
    current.segments[1].label = 'New';
    listeners.SEGMENTATION_MODIFIED({ segmentationId: 'a' });
    assert.equal(maskProgress.get('a').revision, version + 1);
    style.fillAlpha = 0.2;
    listeners.SEGMENTATION_REPRESENTATION_MODIFIED({ segmentationId: 'a' });
    assert.equal(maskProgress.get('a').revision, version + 2);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    maskProgress.saved('a', maskProgress.get('a').revision);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    assert.equal(clean.defaultPrevented, false);
  } finally {
    stop();
    delete global.window;
  }
});
const { roiContains, roiSelection, roiSelectionForInstance, validateRoi, roiPlanePolygon } =
  compiled('maskRoi');
const { thresholdSlice } = compiled('maskAlgorithms');
const roi = () => ({
  seriesInstanceUID: '1.2',
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  min: [1, 1, 1],
  max: [2, 2, 2],
});
test('3D ROI includes boundaries and excludes adjacent slices', () => {
  assert.equal(roiContains(roi(), [1, 1, 1]), true);
  assert.equal(roiContains(roi(), [2, 2, 2]), true);
  assert.equal(roiContains(roi(), [1, 1, 0]), false);
  assert.deepEqual(
    [...roiSelection(roi(), 3, 3, [0, 0, 1], [1, 0, 0], [0, 1, 0])],
    [0, 0, 0, 0, 1, 1, 0, 1, 1]
  );
});
test('ROI uses patient coordinates for oblique and unequal-spacing acquisitions', () => {
  const root = Math.SQRT1_2,
    axes = [
      [root, root, 0],
      [-root, root, 0],
      [0, 0, 1],
    ];
  const box = { ...roi(), axes, min: [2, 3, 1], max: [4, 3, 1] };
  const instance = {
    SeriesInstanceUID: '1.2',
    Columns: 3,
    Rows: 3,
    ImagePositionPatient: [0, 0, 1],
    ImageOrientationPatient: axes.slice(0, 2).flat(),
    PixelSpacing: [3, 2],
  };
  assert.deepEqual([...roiSelectionForInstance(box, instance)], [0, 0, 0, 0, 1, 1, 0, 0, 0]);
  instance.SeriesInstanceUID = '9';
  assert.throws(() => roiSelectionForInstance(box, instance), /不匹配/);
});
test('ROI replacement preserves everything outside the box and protects other Masks inside it', () => {
  const pixels = [1, 1, 2, 1, 0, 1],
    values = [0, 0, 200, 200, 200, 0],
    selection = [0, 1, 1, 1, 1, 0];
  assert.deepEqual(
    [...thresholdSlice(pixels, values, 3, 2, 1, 100, 300, true, selection)],
    [1, 0, 2, 1, 1, 1]
  );
  assert.deepEqual(
    [...thresholdSlice(pixels, values, 3, 2, 1, 100, 300, false, selection)],
    [1, 1, 2, 1, 1, 1]
  );
});
test('ROI outlines intersect axial and oblique slice planes', () => {
  assert.equal(roiPlanePolygon(roi(), [0, 0, 1.5], [0, 0, 1]).length, 4);
  assert.equal(roiPlanePolygon(roi(), [0, 0, 0], [0, 0, 1]).length, 0);
  const points = roiPlanePolygon(roi(), [1.5, 1.5, 1.5], [Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.ok(points.length >= 4);
  assert.ok(points.every(p => Math.abs(p[0] + p[2] - 3) < 1e-6));
});
test('reject malformed ROI and mismatched pixel selections', () => {
  const bad = roi();
  bad.axes[0] = [2, 0, 0];
  assert.throws(() => validateRoi(bad));
  assert.throws(() => thresholdSlice([0], [200], 1, 1, 1, 100, 300, true, [1, 1]), /ROI/);
});

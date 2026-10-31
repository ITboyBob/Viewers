const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const images = new Map();
let fixture;
globalThis.__segExport = {
  cache: { getImage: id => images.get(id), getVolume: () => fixture.volume },
  imageLoader: { loadAndCacheImage: id => fixture.load(id) },
  metaData: {
    get: (_, id) =>
      fixture.geometry?.[id] || {
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        ImagePositionPatient: [0, 0, Number(id.split('-').pop()) || 0],
        SeriesInstanceUID: 'series',
        StudyInstanceUID: 'study',
        FrameOfReferenceUID: 'frame',
        SOPInstanceUID: id,
      },
  },
  segmentation: {
    state: { getSegmentation: () => fixture.current },
    getLabelmapImageIds: () => fixture.ids,
  },
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@cornerstonejs/core') return { url: 'seg-export:core', shortCircuit: true };
    if (specifier === '@cornerstonejs/tools')
      return { url: 'seg-export:tools', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'seg-export:core')
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const {cache,imageLoader,metaData}=globalThis.__segExport;',
      };
    if (url === 'seg-export:tools')
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const {segmentation}=globalThis.__segExport;',
      };
    return next(url, context);
  },
});
const prepare =
  require('../../extensions/cornerstone-dicom-seg/src/utils/prepareSegmentationExport.ts').default;
hooks.deregister();
function setup(values = [0, 1, 0, 2]) {
  images.clear();
  const pixels = Uint8Array.from(values);
  images.set('mask', {
    rows: 2,
    columns: 2,
    referencedImageId: 'source',
    getPixelData: () => pixels,
  });
  images.set('source', { imageId: 'source', rows: 2, columns: 2 });
  fixture = {
    current: {
      representationData: { Labelmap: { imageIds: ['mask'] } },
      segments: { 1: {}, 2: {} },
    },
    ids: ['mask'],
    load: () => {
      throw Error('Unexpected load');
    },
  };
  return pixels;
}
test('export preserves every registered mask including hidden or locked masks', async () => {
  setup();
  fixture.current.segments[2] = { locked: true, visible: false };
  const result = await prepare('seg');
  assert.deepEqual(result.segmentsOnLabelmap, [1, 2]);
  assert.deepEqual([...result.labelmaps2D[0].pixelData], [0, 1, 0, 2]);
});
test('volume-only labelmaps use SDK image resolution and volume source references', async () => {
  setup();
  fixture.current.representationData.Labelmap = { volumeId: 'mask-volume' };
  fixture.volume = { referencedImageIds: ['source'] };
  delete images.get('mask').referencedImageId;
  const result = await prepare('seg');
  assert.equal(result.referencedImages[0].imageId, 'source');
});
test('source loading cannot change the captured label pixels', async () => {
  const pixels = setup();
  const source = images.get('source');
  images.delete('source');
  fixture.load = async () => {
    pixels.fill(2);
    return source;
  };
  const result = await prepare('seg');
  assert.deepEqual([...result.labelmaps2D[0].pixelData], [0, 1, 0, 2]);
});
test('missing source images are loaded in bounded batches and retain frame correspondence', async () => {
  setup();
  fixture.ids = Array.from({ length: 9 }, (_, i) => `mask-${i}`);
  let active = 0,
    maximum = 0;
  fixture.ids.forEach((id, i) =>
    images.set(id, {
      rows: 1,
      columns: 1,
      referencedImageId: `source-${i}`,
      getPixelData: () => new Uint8Array([1]),
    })
  );
  fixture.load = async id => {
    maximum = Math.max(maximum, ++active);
    await new Promise(r => setTimeout(r, 1));
    active--;
    return { imageId: id, rows: 1, columns: 1 };
  };
  const result = await prepare('seg');
  assert.equal(maximum, 4);
  assert.deepEqual(
    result.referencedImages.map(i => i.imageId),
    fixture.ids.map((_, i) => `source-${i}`).reverse()
  );
});
test('an empty annotation never emits an empty SEG or starts source loading', async () => {
  setup([0, 0, 0, 0]);
  images.delete('source');
  await assert.rejects(prepare('seg'), /没有选区/);
});
test('temporary brush preview labels are rejected without altering pixels', async () => {
  const pixels = setup([0, 255, 0, 1]);
  await assert.rejects(prepare('seg'), /笔刷预览/);
  assert.deepEqual([...pixels], [0, 255, 0, 1]);
});
test('orphan mask labels cannot silently disappear in exported metadata', async () => {
  setup([0, 3, 0, 1]);
  await assert.rejects(prepare('seg'), /编号 3 缺少图层/);
});
test('inconsistent source geometry fails before export', async () => {
  setup();
  images.get('source').columns = 4;
  await assert.rejects(prepare('seg'), /原始切片加载失败/);
});
test('a failed source read is reported after all in-flight loads settle', async () => {
  setup();
  images.delete('source');
  fixture.load = async () => {
    throw Error('offline');
  };
  await assert.rejects(prepare('seg'), /原始切片加载失败/);
});
test('a segmentation deleted during source loading cannot produce a stale export', async () => {
  setup();
  const source = images.get('source');
  images.delete('source');
  fixture.load = async () => {
    fixture.current = undefined;
    return source;
  };
  await assert.rejects(prepare('seg'), /已被删除/);
});

test('normalizer sorting keeps oblique source positions paired with their own mask pixels', async () => {
  setup();
  fixture.ids = ['low', 'high'];
  fixture.geometry = {};
  for (const [name, position, value] of [
    ['low', 2, 1],
    ['high', 7, 2],
  ]) {
    images.set(name, {
      rows: 1,
      columns: 1,
      referencedImageId: `source-${name}`,
      getPixelData: () => new Uint8Array([value]),
    });
    images.set(`source-${name}`, { imageId: `source-${name}`, rows: 1, columns: 1 });
    fixture.geometry[`source-${name}`] = {
      ImageOrientationPatient: [0, 1, 0, 0, 0, 1],
      ImagePositionPatient: [position, 0, 0],
      SeriesInstanceUID: 'series',
      StudyInstanceUID: 'study',
      FrameOfReferenceUID: 'frame',
      SOPInstanceUID: name,
    };
  }
  const result = await prepare('seg');
  assert.deepEqual(
    result.referencedImages.map(i => i.imageId),
    ['source-high', 'source-low']
  );
  assert.deepEqual(
    result.labelmaps2D.map(f => f.pixelData[0]),
    [2, 1]
  );
});
test('missing orientation prevents an export with guessed geometry', async () => {
  setup();
  fixture.geometry = {
    source: {
      ImagePositionPatient: [0, 0, 0],
      StudyInstanceUID: 'study',
      SeriesInstanceUID: 'series',
      FrameOfReferenceUID: 'frame',
    },
  };
  await assert.rejects(prepare('seg'), /方向信息不完整/);
});

test('missing source identifiers cannot produce an untraceable SEG', async () => {
  setup();
  fixture.geometry = {
    source: { ImageOrientationPatient: [1, 0, 0, 0, 1, 0], ImagePositionPatient: [0, 0, 0] },
  };
  await assert.rejects(prepare('seg'), /标识不完整/);
});
test('repeated source plane positions cannot generate a zero-spacing multiframe', async () => {
  setup();
  fixture.ids = ['mask', 'mask-2'];
  images.set('mask-2', { ...images.get('mask'), referencedImageId: 'another-source' });
  images.set('another-source', { imageId: 'another-source', rows: 2, columns: 2 });
  await assert.rejects(prepare('seg'), /重复空间位置/);
});

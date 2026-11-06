const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { zipSync, unzipSync, strToU8 } = require('fflate');
const moduleObject = { exports: {} };
const output = ts.transpileModule(
  fs.readFileSync(
    path.resolve(
      __dirname,
      '../../extensions/cornerstone/src/utils/maskEditing/maskProjectCodec.ts'
    ),
    'utf8'
  ),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }
).outputText;
new Function('require', 'module', 'exports', output)(
  key =>
    key === './maskRoi'
      ? require('../../extensions/cornerstone/src/utils/maskEditing/maskRoi.ts')
      : require(key),
  moduleObject,
  moduleObject.exports
);
const {
  encodeMaskProject,
  decodeMaskProject,
  matchProjectFrames,
  validateManifest,
  MAX_PROJECT_VOXELS,
  maskProjectFingerprint,
} = moduleObject.exports;
const testRoi = () => ({
  seriesInstanceUID: '1.3',
  axes: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  min: [0, 0, 0],
  max: [2, 2, 3],
});
test('collection-level visibility is serialized separately from per-Mask visibility and affects content identity', async () => {
  const manifest = fixture();
  manifest.version = 2;
  const before = await maskProjectFingerprint(manifest, labels());
  manifest.representationVisible = false;
  assert.notEqual(await maskProjectFingerprint(manifest, labels()), before);
  const decoded = await decodeMaskProject(await encodeMaskProject(manifest, labels()));
  assert.equal(decoded.manifest.representationVisible, false);
  assert.equal(decoded.manifest.segments[0].visible, true);
  manifest.representationVisible = 'false';
  assert.throws(() => validateManifest(manifest), /显隐/);
});
test('version 2 preserves ROI and remains able to decode legacy files', async () => {
  const m = fixture();
  m.version = 2;
  m.roi = testRoi();
  assert.deepEqual(
    (await decodeMaskProject(await encodeMaskProject(m, labels()))).manifest.roi,
    m.roi
  );
  assert.equal(
    (await decodeMaskProject(await encodeMaskProject(fixture(), labels()))).manifest.version,
    1
  );
});
test('ROI is included in content identity and mismatched or malformed ROI is rejected', async () => {
  const m = fixture();
  m.version = 2;
  const before = await maskProjectFingerprint(m, labels());
  m.roi = testRoi();
  assert.notEqual(await maskProjectFingerprint(m, labels()), before);
  m.roi.seriesInstanceUID = '9.1';
  assert.throws(() => validateManifest(m), /ROI/);
  m.roi = testRoi();
  m.roi.axes[0] = [NaN, 0, 0];
  assert.throws(() => validateManifest(m), /ROI/);
  m.roi = testRoi();
  m.version = 1;
  assert.throws(() => validateManifest(m), /版本 2/);
});

test('content identity follows SOP UIDs across reversed frame storage', async () => {
  const original = fixture(),
    reversed = structuredClone(original);
  reversed.source.frames.reverse();
  const pixels = labels(),
    reordered = Uint8Array.from([...pixels.slice(4), ...pixels.slice(0, 4)]);
  assert.equal(
    await maskProjectFingerprint(original, pixels),
    await maskProjectFingerprint(reversed, reordered)
  );
});
test('content identity ignores timestamps and selection but detects pixels and editing metadata', async () => {
  const m = fixture(),
    pixels = labels(),
    before = await maskProjectFingerprint(m, pixels);
  m.createdAt = '2026-11-03T00:00:00Z';
  m.activeSegmentIndex = 1;
  assert.equal(await maskProjectFingerprint(m, pixels), before);
  m.segments[0].visible = false;
  assert.notEqual(await maskProjectFingerprint(m, pixels), before);
  m.segments[0].visible = true;
  pixels[0] = 0;
  assert.notEqual(await maskProjectFingerprint(m, pixels), before);
});
function fixture() {
  return {
    format: 'OHIF_MASK_PROJECT',
    version: 1,
    createdAt: '2026-11-02T00:00:00Z',
    label: '骨组织',
    source: {
      studyInstanceUID: '1.2',
      seriesInstanceUID: '1.3',
      frameOfReferenceUID: '1.4',
      frames: [0, 1].map(z => ({
        sopInstanceUID: `1.5.${z}`,
        rows: 2,
        columns: 2,
        position: [0, 0, z * 3],
        orientation: [1, 0, 0, 0, 1, 0],
        spacing: [0.7, 0.7],
      })),
    },
    segments: [1, 3].map(index => ({
      index,
      label: `Mask ${index}`,
      color: [40, 120, 220, 255],
      visible: index === 1,
      locked: index === 3,
      style: { fillAlpha: 0.4, outlineWidth: 4, renderFill: true, renderOutline: false },
    })),
    activeSegmentIndex: 3,
    labelmap: { encoding: 'uint8', byteLength: 8, sha256: '0'.repeat(64) },
  };
}
const labels = () => Uint8Array.from([1, 0, 3, 0, 0, 1, 0, 0]);

test('lossless compressed roundtrip preserves sparse/empty masks and all editing state', async () => {
  const m = fixture();
  m.segments.push({ ...structuredClone(m.segments[0]), index: 254, label: '空 Mask' });
  const bytes = await encodeMaskProject(m, labels());
  const decoded = await decodeMaskProject(bytes);
  assert.deepEqual(decoded.manifest, m);
  assert.deepEqual(decoded.labels, labels());
});
test('empty annotation set can be saved without inventing a Mask', async () => {
  const m = fixture();
  m.segments = [];
  m.activeSegmentIndex = null;
  const decoded = await decodeMaskProject(await encodeMaskProject(m, new Uint8Array(8)));
  assert.deepEqual(decoded.manifest.segments, []);
});
test('frame identity mapping is independent of import order', () => {
  const saved = fixture().source,
    current = structuredClone(saved);
  current.frames.reverse();
  assert.deepEqual(matchProjectFrames(saved, current), [1, 0]);
});
for (const [name, mutate] of [
  [
    'wrong series',
    s => {
      s.seriesInstanceUID = '9.1';
    },
  ],
  [
    'missing slice',
    s => {
      s.frames.pop();
    },
  ],
  [
    'wrong SOP',
    s => {
      s.frames[0].sopInstanceUID = '9.2';
    },
  ],
  [
    'different position',
    s => {
      s.frames[0].position[2] += 0.01;
    },
  ],
  [
    'different spacing',
    s => {
      s.frames[0].spacing[0] += 0.01;
    },
  ],
  [
    'different orientation',
    s => {
      s.frames[0].orientation = [0, 1, 0, 1, 0, 0];
    },
  ],
  [
    'duplicate SOP',
    s => {
      s.frames[1].sopInstanceUID = s.frames[0].sopInstanceUID;
    },
  ],
])
  test(`reject ${name} before any application state changes`, () => {
    const saved = fixture().source,
      current = structuredClone(saved);
    mutate(current);
    assert.throws(() => matchProjectFrames(saved, current));
  });
for (const [name, mutate] of [
  [
    'future format version',
    m => {
      m.version = 3;
    },
  ],
  [
    'duplicate Mask',
    m => {
      m.segments[1].index = 1;
    },
  ],
  [
    'preview label',
    m => {
      m.segments[1].index = 255;
    },
  ],
  [
    'background Mask',
    m => {
      m.segments[1].index = 0;
    },
  ],
  [
    'nonexistent active Mask',
    m => {
      m.activeSegmentIndex = 2;
    },
  ],
  [
    'invalid color',
    m => {
      m.segments[0].color[0] = 256;
    },
  ],
  [
    'nonfinite opacity',
    m => {
      m.segments[0].style.fillAlpha = NaN;
    },
  ],
  [
    'nonboolean visibility',
    m => {
      m.segments[0].visible = 'false';
    },
  ],
  [
    'wrong declared length',
    m => {
      m.labelmap.byteLength = 9;
    },
  ],
  [
    'oversized volume',
    m => {
      m.source.frames[0].rows = 16384;
      m.source.frames[0].columns = 16384;
    },
  ],
])
  test(`reject invalid manifest: ${name}`, () => {
    const m = fixture();
    mutate(m);
    assert.throws(() => validateManifest(m));
  });
test('reject orphaned labels and uncommitted preview pixels', async () => {
  for (const value of [2, 255]) {
    const pixels = labels();
    pixels[0] = value;
    await assert.rejects(encodeMaskProject(fixture(), pixels));
  }
});
test('reject corrupted pixels using SHA256 even for a valid ZIP', async () => {
  const files = unzipSync(await encodeMaskProject(fixture(), labels()));
  files['labels.bin'][0] = 0;
  await assert.rejects(decodeMaskProject(zipSync(files)), /校验失败/);
});
test('reject truncated pixel arrays and missing archive entries', async () => {
  const files = unzipSync(await encodeMaskProject(fixture(), labels()));
  files['labels.bin'] = files['labels.bin'].slice(0, 7);
  await assert.rejects(decodeMaskProject(zipSync(files)), /长度/);
  delete files['labels.bin'];
  await assert.rejects(decodeMaskProject(zipSync(files)), /缺少/);
});
test('reject extra files, malformed JSON and invalid ZIP archives', async () => {
  await assert.rejects(decodeMaskProject(zipSync({ 'bad.txt': strToU8('bad') })), /条目/);
  await assert.rejects(
    decodeMaskProject(zipSync({ 'manifest.json': strToU8('{'), 'labels.bin': labels() }))
  );
  await assert.rejects(decodeMaskProject(strToU8('not a zip')));
});
test('reject oversized ZIP entries before inflation', async () => {
  const bytes = zipSync({ 'labels.bin': labels() });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Forge the central directory uncompressed size without allocating a giant payload.
  for (let i = 0; i < bytes.length - 24; i++)
    if (view.getUint32(i, true) === 0x02014b50)
      view.setUint32(i + 24, MAX_PROJECT_VOXELS + 1, true);
  await assert.rejects(decodeMaskProject(bytes), /解压后过大/);
});

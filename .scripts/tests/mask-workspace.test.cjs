const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
const { zipSync, unzipSync, strToU8 } = require('fflate');
const cache = new Map();
function compiled(name) {
  if (cache.has(name)) return cache.get(name);
  const m = { exports: {} };
  const file = path.resolve(
    __dirname,
    '../../extensions/cornerstone/src/utils/maskEditing',
    name + '.ts'
  );
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(
    key => (key.startsWith('./') ? compiled(key.slice(2)) : require(key)),
    m,
    m.exports
  );
  cache.set(name, m.exports);
  return m.exports;
}
const { encodeMaskWorkspace, decodeMaskWorkspace } = compiled('maskWorkspaceCodec');
function fixture() {
  return ['set-000', 'set-001'].map((key, index) => ({
    key,
    labels: Uint8Array.from(index ? [1, 0, 0, 1, 0, 0, 0, 0] : [1, 1, 0, 0, 0, 0, 0, 0]),
    manifest: {
      format: 'OHIF_MASK_PROJECT',
      version: 2,
      createdAt: '2026-11-04T00:00:00Z',
      label: '独立 Mask ' + index,
      source: {
        studyInstanceUID: '1.2',
        seriesInstanceUID: '1.3',
        frameOfReferenceUID: '1.4',
        frames: [0, 1].map(z => ({
          sopInstanceUID: `1.5.${z}`,
          rows: 2,
          columns: 2,
          position: [0, 0, z * 2],
          orientation: [1, 0, 0, 0, 1, 0],
          spacing: [1, 1],
        })),
      },
      roi: {
        seriesInstanceUID: '1.3',
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        min: [0, 0, 0],
        max: [1, 1, 2],
      },
      segments: [
        {
          index: 1,
          label: '骨组织 ' + index,
          color: [255, index * 80, 40, 255],
          visible: index === 0,
          locked: index === 1,
          style: { fillAlpha: 0.3, outlineWidth: 2, renderFill: true, renderOutline: false },
        },
      ],
      activeSegmentIndex: 1,
      labelmap: { encoding: 'uint8', byteLength: 8, sha256: '0'.repeat(64) },
    },
  }));
}
test('complete project preserves independent overlapping labels and every collection state', async () => {
  const input = fixture(),
    encoded = await encodeMaskWorkspace(input, 'set-001'),
    decoded = await decodeMaskWorkspace(encoded.archive);
  assert.equal(decoded.manifest.activeKey, 'set-001');
  assert.equal(decoded.collections.length, 2);
  decoded.collections.forEach((item, i) => {
    assert.deepEqual(item.labels, input[i].labels);
    assert.deepEqual(item.manifest, input[i].manifest);
    assert.equal(item.fingerprint, encoded.fingerprints[item.key]);
  });
  assert.equal(decoded.collections[0].labels[0], 1);
  assert.equal(decoded.collections[1].labels[0], 1);
});
test('empty annotation collections remain part of a project', async () => {
  const input = fixture();
  input[1].labels.fill(0);
  input[1].manifest.segments = [];
  input[1].manifest.activeSegmentIndex = null;
  const result = await decodeMaskWorkspace((await encodeMaskWorkspace(input, 'set-000')).archive);
  assert.deepEqual(result.collections[1].manifest.segments, []);
});
test('reject empty, excessive, duplicate and invalid collection keys and missing active collection', async () => {
  await assert.rejects(encodeMaskWorkspace([], 'set-000'));
  await assert.rejects(
    encodeMaskWorkspace(
      Array.from({ length: 33 }, () => fixture()[0]),
      'set-000'
    )
  );
  const duplicate = fixture();
  duplicate[1].key = duplicate[0].key;
  await assert.rejects(encodeMaskWorkspace(duplicate, 'set-000'), /重复/);
  const invalid = fixture();
  invalid[1].key = '../bad';
  await assert.rejects(encodeMaskWorkspace(invalid, 'set-000'), /编号/);
  await assert.rejects(encodeMaskWorkspace(fixture(), 'missing'), /不存在/);
});
test('reject source-series, geometry and ROI inconsistencies between collections', async () => {
  const cases = [
    v => (v[1].manifest.source.seriesInstanceUID = '9.1'),
    v => (v[1].manifest.source.frames[0].position[0] = 1),
    v => (v[1].manifest.roi.max[2] = 3),
  ];
  for (const change of cases) {
    const input = fixture();
    change(input);
    await assert.rejects(encodeMaskWorkspace(input, 'set-000'));
  }
});
test('whole-archive and nested collection checks detect corruption before application', async () => {
  const { archive } = await encodeMaskWorkspace(fixture(), 'set-000'),
    files = unzipSync(archive);
  files['collections/set-000.ohifmask'][20] ^= 1;
  await assert.rejects(decodeMaskWorkspace(zipSync(files)), /校验失败/);
  await assert.rejects(decodeMaskWorkspace(strToU8('bad zip')));
});
test('reject missing and extra collection entries and malformed descriptors', async () => {
  for (const change of [
    f => delete f['collections/set-001.ohifmask'],
    f => (f['collections/set-002.ohifmask'] = f['collections/set-000.ohifmask']),
    f => (f['workspace.json'] = strToU8('{}')),
  ]) {
    const files = unzipSync((await encodeMaskWorkspace(fixture(), 'set-000')).archive);
    change(files);
    await assert.rejects(decodeMaskWorkspace(zipSync(files)));
  }
});
test('declared label budgets and uncompressed ZIP entry bounds are checked', async () => {
  const files = unzipSync((await encodeMaskWorkspace(fixture(), 'set-000')).archive),
    manifest = JSON.parse(Buffer.from(files['workspace.json']).toString());
  manifest.collections[0].labelBytes = 1024;
  files['workspace.json'] = strToU8(JSON.stringify(manifest));
  await assert.rejects(decodeMaskWorkspace(zipSync(files)), /描述/);
  const bytes = zipSync({ 'workspace.json': strToU8('{}') }),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 28; i++)
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 5 * 1024 * 1024, true);
  await assert.rejects(decodeMaskWorkspace(bytes), /过大/);
});
test('oversized aggregate label metadata is rejected without allocating the declared image volumes', async () => {
  const source = fixture()[0].manifest.source;
  source.frames = [{ ...source.frames[0], rows: 4096, columns: 4096 }];
  const manifest = {
    format: 'OHIF_MASK_WORKSPACE',
    version: 1,
    createdAt: '2026-11-04T00:00:00Z',
    source,
    activeKey: 'set-000',
    collections: Array.from({ length: 17 }, (_, i) => ({
      key: `set-${String(i).padStart(3, '0')}`,
      bytes: 1,
      labelBytes: 4096 * 4096,
      sha256: '0'.repeat(64),
    })),
  };
  await assert.rejects(
    decodeMaskWorkspace(zipSync({ 'workspace.json': strToU8(JSON.stringify(manifest)) })),
    /256 MiB/
  );
});

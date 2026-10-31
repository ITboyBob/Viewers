const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  markSeedComponent,
  analyzeMaskComponents,
} = require('../../extensions/cornerstone/src/utils/maskEditing/volumeAlgorithms.ts');

test('region grow follows connectivity across adjacent slices', () => {
  const mask = new Uint8Array([1, 0, 1, 1, 0, 0]);
  const result = markSeedComponent(mask, [3, 1, 2], [0, 0, 0]);
  assert.equal(result.kept, 2);
  assert.deepEqual([...result.mask], [2, 0, 1, 2, 0, 0]);
});

test('separate regions on the same slice remain outside the seed component', () => {
  const result = markSeedComponent(new Uint8Array([1, 0, 1, 1, 0, 1]), [3, 2, 1], [2, 0, 0]);
  assert.equal(result.kept, 2);
  assert.deepEqual([...result.mask], [1, 0, 2, 1, 0, 2]);
});

test('diagonal contact does not merge anatomically separate islands', () => {
  const result = markSeedComponent(new Uint8Array([1, 0, 0, 1]), [2, 2, 1], [0, 0, 0]);
  assert.equal(result.kept, 1);
  assert.deepEqual([...result.mask], [2, 0, 0, 1]);
});

test('a one-voxel gap between slices prevents growth', () => {
  const result = markSeedComponent(new Uint8Array([1, 0, 1]), [1, 1, 3], [0, 0, 0]);
  assert.equal(result.kept, 1);
  assert.deepEqual([...result.mask], [2, 0, 1]);
});

test('opposite edges of rows cannot wrap around and connect', () => {
  const result = markSeedComponent(new Uint8Array([0, 0, 1, 1, 0, 0]), [3, 2, 1], [2, 0, 0]);
  assert.equal(result.kept, 1);
});

test('opposite edges of planes cannot wrap around and connect', () => {
  const result = markSeedComponent(new Uint8Array([0, 1, 1, 0]), [1, 2, 2], [0, 1, 0]);
  assert.equal(result.kept, 1);
});

test('single-slice data supports the same operation in two dimensions', () => {
  const result = markSeedComponent(new Uint8Array([1, 1, 0]), [3, 1, 1], [1, 0, 0]);
  assert.equal(result.kept, 2);
});

test('a seed outside the selected mask is rejected before modifying the copy', () => {
  const mask = new Uint8Array([1, 0]);
  assert.throws(() => markSeedComponent(mask, [2, 1, 1], [1, 0, 0]), /已着色区域/);
  assert.deepEqual([...mask], [1, 0]);
});

test('out-of-bounds seeds and inconsistent dimensions are rejected', () => {
  assert.throws(() => markSeedComponent(new Uint8Array([1]), [1, 1, 1], [1, 0, 0]));
  assert.throws(() => markSeedComponent(new Uint8Array([1]), [2, 1, 1], [0, 0, 0]));
});

test('the frontier queue grows and wraps without losing connected voxels', () => {
  const result = markSeedComponent(new Uint8Array(8 * 8 * 8).fill(1), [8, 8, 8], [4, 4, 4], 2);
  assert.equal(result.kept, 512);
  assert.ok(result.mask.every(value => value === 2));
});

test('three-dimensional split keeps a connection through a neighboring slice', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 0, 1, 1, 1, 1]), [3, 1, 2]);
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].voxelCount, 5);
});

test('independent columns are split consistently across the complete volume', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 0, 1, 1, 0, 1, 1, 0, 1]), [3, 1, 3]);
  assert.deepEqual(
    result.components.map(item => item.voxelCount),
    [3, 3]
  );
  assert.deepEqual([...result.mask], [2, 0, 3, 2, 0, 3, 2, 0, 3]);
});

test('the largest component is retained independently of scan order', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 0, 1, 1, 1]), [5, 1, 1]);
  assert.equal(result.components[0].code, 3);
  assert.equal(result.components[0].voxelCount, 3);
});

test('small regions are explicitly retained in the original mask rather than deleted', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 1, 0, 1, 0, 1, 1]), [7, 1, 1], 2);
  assert.equal(result.components.length, 2);
  assert.equal(result.ignoredRegions, 1);
  assert.equal(result.ignoredVoxels, 1);
  assert.equal(result.mask[3], 255);
});

test('a volume consisting only of small islands does not lose voxels', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 0, 1]), [3, 1, 1], 2);
  assert.equal(result.components.length, 0);
  assert.equal(result.ignoredVoxels, 2);
  assert.deepEqual([...result.mask], [255, 0, 255]);
});

test('three-dimensional split does not connect diagonal contacts', () => {
  const result = analyzeMaskComponents(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1]), [2, 2, 2]);
  assert.equal(result.components.length, 2);
});

test('excessive component counts and invalid minimum sizes are rejected', () => {
  assert.throws(
    () => analyzeMaskComponents(new Uint8Array([1, 0, 1, 0, 1]), [5, 1, 1], 1, 2),
    /超过/
  );
  assert.throws(() => analyzeMaskComponents(new Uint8Array([1]), [1, 1, 1], 0));
  assert.throws(() => analyzeMaskComponents(new Uint8Array([1]), [1, 1, 1], 1.5));
});

test('the component-analysis frontier grows without dropping large regions', () => {
  const result = analyzeMaskComponents(new Uint8Array(512).fill(1), [8, 8, 8], 1, 32, 2);
  assert.equal(result.components[0].voxelCount, 512);
});

const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  refineMask,
} = require('../../extensions/cornerstone/src/utils/maskEditing/refinementAlgorithms.ts');
const { refinementReference } = require('../refinement-reference.cjs');
const at = (dims, x, y, z) => x + dims[0] * (y + dims[1] * z);
function carve(state, dims, from, to, value = 0) {
  for (let z = from[2]; z <= to[2]; z++)
    for (let y = from[1]; y <= to[1]; y++)
      for (let x = from[0]; x <= to[0]; x++) state[at(dims, x, y, z)] = value;
}
function check(state, dims, spacing = [1, 1, 1], options = {}) {
  options = { operation: 'fillCavities', ...options };
  const before = state.slice(),
    result = refineMask(state, dims, spacing, options),
    reference = refinementReference(state, dims, spacing, options);
  assert.deepEqual(state, before, 'source snapshot was mutated');
  assert.deepEqual(
    result.mask,
    Uint8Array.from(reference.output, v => Number(v === 1))
  );
  assert.equal(result.cavities, reference.cavities);
  assert.equal(result.eligibleCavities, reference.eligibleCavities);
  for (let i = 0; i < state.length; i++) {
    if (state[i] === 1) assert.equal(result.mask[i], 1, 'accepted target was removed');
    if (state[i] === 2) assert.equal(result.mask[i], 0, 'protected label was overwritten');
  }
  return result;
}
test('3D cavities fill a closed hollow object across every enclosed layer', () => {
  const dims = [7, 7, 7],
    state = new Uint8Array(343).fill(1);
  carve(state, dims, [2, 2, 2], [4, 4, 4]);
  const result = check(state, dims);
  assert.equal(result.cavities, 1);
  assert.equal(result.eligibleCavities, 1);
  assert.equal(
    result.mask.reduce((a, b) => a + b, 0),
    state.length
  );
});
test('3D cavities retain a tube open through the first and last slice', () => {
  const dims = [7, 7, 7],
    state = new Uint8Array(343).fill(1);
  carve(state, dims, [3, 3, 0], [3, 3, 6]);
  assert.deepEqual(check(state, dims).mask, state);
});
test('3D cavities preserve exits on all six faces of the acquired volume', () => {
  const dims = [5, 5, 5];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 4]) {
      const state = new Uint8Array(125).fill(1),
        from = [2, 2, 2],
        to = [2, 2, 2];
      from[axis] = Math.min(2, side);
      to[axis] = Math.max(2, side);
      carve(state, dims, from, to);
      assert.equal(check(state, dims).cavities, 0);
    }
});
test('26-connected diagonal and edge-only background routes remain open', () => {
  const dims = [5, 5, 5];
  for (const route of [
    [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ],
    [
      [0, 0, 2],
      [1, 1, 2],
      [2, 2, 2],
    ],
  ]) {
    const state = new Uint8Array(125).fill(1);
    for (const p of route) state[at(dims, ...p)] = 0;
    assert.equal(check(state, dims).cavities, 0);
  }
});
test('cavity maximum uses physical volume and includes the exact volume boundary', () => {
  const dims = [12, 8, 8],
    state = new Uint8Array(768).fill(1),
    spacing = [0.5, 0.8, 3];
  carve(state, dims, [2, 2, 2], [2, 2, 2]);
  carve(state, dims, [6, 2, 2], [7, 3, 3]);
  assert.equal(check(state, dims, spacing, { maximumCavityVolumeMm3: 9.6 }).eligibleCavities, 2);
  const smaller = check(state, dims, spacing, { maximumCavityVolumeMm3: 9.599 });
  assert.equal(smaller.cavities, 2);
  assert.equal(smaller.eligibleCavities, 1);
  assert.equal(smaller.mask[at(dims, 6, 2, 2)], 0);
  assert.equal(check(state, dims, spacing, { maximumCavityVolumeMm3: 0.1 }).eligibleCavities, 0);
});
test('other Masks are traversable for topology and cannot falsely seal an exterior route', () => {
  const dims = [5, 5, 5],
    state = new Uint8Array(125).fill(1);
  carve(state, dims, [2, 2, 0], [2, 2, 2], 2);
  state[at(dims, 2, 2, 2)] = 0;
  assert.equal(check(state, dims).cavities, 0);
});
test('protected labels inside a cavity count toward volume but are never filled', () => {
  const dims = [7, 7, 7],
    state = new Uint8Array(343).fill(1);
  carve(state, dims, [2, 2, 2], [4, 4, 4]);
  state[at(dims, 3, 3, 3)] = 2;
  assert.equal(check(state, dims, [1, 1, 2], { maximumCavityVolumeMm3: 52 }).eligibleCavities, 0);
  const result = check(state, dims, [1, 1, 2], { maximumCavityVolumeMm3: 54 });
  assert.equal(result.eligibleCavities, 1);
  assert.equal(
    result.mask.reduce((a, b) => a + b, 0),
    state.length - 1
  );
});
test('cavity fill handles empty, full, protected-only and degenerate volumes without creating holes', () => {
  for (const dims of [
    [1, 1, 1],
    [5, 5, 1],
    [2, 2, 2],
    [5, 4, 3],
  ]) {
    for (const value of [0, 1, 2]) {
      const result = check(new Uint8Array(dims.reduce((a, b) => a * b, 1)).fill(value), dims);
      assert.equal(result.cavities, 0);
      assert.equal(result.eligibleCavities, 0);
    }
  }
});
test('invalid cavity limits are rejected even when the Mask is empty', () => {
  for (const maximumCavityVolumeMm3 of [0, -1, NaN, Infinity, 1e9 + 1, null, '10'])
    assert.throws(
      () =>
        refineMask(new Uint8Array(27), [3, 3, 3], [1, 1, 1], {
          operation: 'fillCavities',
          maximumCavityVolumeMm3,
        }),
      /空腔最大体积/
    );
});
test('cavity scan reports bounded monotonic progress during a large exterior component', () => {
  const dims = [80, 80, 40],
    state = new Uint8Array(80 * 80 * 40),
    values = [];
  const result = refineMask(state, dims, [1, 1, 1], { operation: 'fillCavities' }, (done, total) =>
    values.push(done / total)
  );
  assert.deepEqual(result.mask, state);
  assert.ok(values.length > 10, 'no progress was sent inside the flood');
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 1);
  assert.ok(values.every((v, i) => v >= 0 && v <= 1 && (!i || v >= values[i - 1])));
});
test('random multi-label 3D cavity results match an independent dense traversal', () => {
  let seed = 17017;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 30; run++) {
    const dims = [5 + (run % 4), 6, 7],
      state = Uint8Array.from({ length: dims[0] * dims[1] * dims[2] }, () =>
        random() < 0.8 ? 1 : random() < 0.8 ? 0 : 2
      );
    check(state, dims, [0.6, 0.8, 2.5], { maximumCavityVolumeMm3: run % 2 ? 4.8 : undefined });
  }
});

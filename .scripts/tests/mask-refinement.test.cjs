const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  refineMask,
} = require('../../extensions/cornerstone/src/utils/maskEditing/refinementAlgorithms.ts');

function brute(state, dims, spacing, operation, radius) {
  const pad = dims.map((n, i) => (n === 1 ? 0 : Math.ceil(radius / spacing[i]) * 3 + 1));
  const size = dims.map((n, i) => n + 2 * pad[i]),
    count = size.reduce((a, b) => a * b, 1);
  const position = (i, d) => [i % d[0], Math.floor(i / d[0]) % d[1], Math.floor(i / (d[0] * d[1]))];
  const at = (x, y, z) => x + size[0] * (y + size[1] * z);
  let mask = new Uint8Array(count);
  for (let i = 0; i < state.length; i++) {
    const p = position(i, dims).map((v, k) => v + pad[k]),
      j = at(...p);
    mask[j] = state[i] === 1;
  }
  const offsets = [];
  const r = dims.map((n, i) => (n === 1 ? 0 : Math.floor(radius / spacing[i] + 1e-8)));
  for (let z = -r[2]; z <= r[2]; z++)
    for (let y = -r[1]; y <= r[1]; y++)
      for (let x = -r[0]; x <= r[0]; x++)
        if (
          (x * spacing[0]) ** 2 + (y * spacing[1]) ** 2 + (z * spacing[2]) ** 2 <=
          radius * radius + 1e-7
        )
          offsets.push([x, y, z]);
  const steps = {
    dilate: ['dilate'],
    erode: ['erode'],
    open: ['erode', 'dilate'],
    close: ['dilate', 'erode'],
    smooth: ['erode', 'dilate', 'dilate', 'erode'],
  }[operation];
  for (const step of steps) {
    const next = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const p = position(i, size);
      let selected = step === 'erode';
      for (const delta of offsets) {
        const q = p.map((v, k) => v + delta[k]),
          value = q.every((v, k) => v >= 0 && v < size[k]) ? mask[at(...q)] : 0;
        if (step === 'dilate' && value) {
          selected = true;
          break;
        }
        if (step === 'erode' && !value) {
          selected = false;
          break;
        }
      }
      next[i] = selected;
    }
    mask = next;
  }
  return Uint8Array.from(state, (_, i) => {
    const p = position(i, dims).map((v, k) => v + pad[k]);
    return state[i] === 2 ? 0 : mask[at(...p)];
  });
}
for (const operation of ['dilate', 'erode', 'open', 'close', 'smooth'])
  test(`${operation} agrees with an independent spherical-neighborhood reference`, () => {
    const dims = [5, 4, 3],
      spacing = [0.7, 1.2, 2.5];
    const state = Uint8Array.from({ length: 60 }, (_, i) =>
      i % 11 === 0 ? 2 : (i * 17) % 23 < 14 ? 1 : 0
    );
    const before = state.slice();
    for (const radius of [0.4, 1.3, 2.6])
      assert.deepEqual(
        refineMask(state, dims, spacing, { operation, radiusMm: radius }).mask,
        brute(state, dims, spacing, operation, radius)
      );
    assert.deepEqual(state, before, 'production algorithm must not mutate the source snapshot');
  });
test('physical radius respects thick slices and includes exact sphere boundaries', () => {
  const dims = [5, 5, 3],
    state = new Uint8Array(75);
  state[37] = 1;
  const result = refineMask(state, dims, [1, 1, 5], { operation: 'dilate', radiusMm: 1 }).mask;
  assert.equal(
    result.reduce((a, b) => a + b, 0),
    5
  );
  assert.equal(result[12], 0);
  assert.equal(result[62], 0);
});
test('closing does not artificially erode a solid object touching the image boundary', () => {
  const state = new Uint8Array(64).fill(1);
  assert.deepEqual(
    refineMask(state, [4, 4, 4], [1, 1, 1], { operation: 'close', radiusMm: 1 }).mask,
    state
  );
});
test('all morphology steps preserve other masks as protected background', () => {
  const state = new Uint8Array(125).fill(1);
  state[62] = 2;
  for (const operation of ['dilate', 'erode', 'open', 'close', 'smooth']) {
    const output = refineMask(state, [5, 5, 5], [1, 1, 1], { operation, radiusMm: 1 }).mask;
    assert.equal(output[62], 0);
  }
});
test('closing never removes accepted voxels beside a protected Mask; opening never adds outside the original Mask', () => {
  const state = Uint8Array.from({ length: 125 }, (_, i) => (i % 9 === 0 ? 2 : i % 7 < 4 ? 1 : 0));
  const closed = refineMask(state, [5, 5, 5], [1, 1, 1], {
    operation: 'close',
    radiusMm: 1.1,
  }).mask;
  const opened = refineMask(state, [5, 5, 5], [1, 1, 1], { operation: 'open', radiusMm: 1.1 }).mask;
  for (let i = 0; i < state.length; i++) {
    if (state[i] === 1) assert.equal(closed[i], 1);
    if (opened[i]) assert.equal(state[i], 1);
  }
});
test('largest component uses 6-connectivity, retains deterministic ties, and has no split-region cap', () => {
  const dims = [17, 17, 17],
    state = new Uint8Array(17 ** 3);
  for (let z = 0; z < 17; z += 2)
    for (let y = 0; y < 17; y += 2)
      for (let x = 0; x < 17; x += 2) state[x + 17 * (y + 17 * z)] = 1;
  const result = refineMask(state, dims, [1, 1, 1], { operation: 'largest' });
  assert.equal(result.components, 729);
  assert.equal(result.removedComponents, 728);
  assert.equal(
    result.mask.reduce((a, b) => a + b, 0),
    1
  );
  assert.equal(result.mask[0], 1);
});
test('minimum volume is measured in mm3 and keeps components exactly at the boundary', () => {
  const row = Uint8Array.from([1, 0, 1, 1, 0, 2]);
  assert.deepEqual(
    [
      ...refineMask(row, [6, 1, 1], [1, 1, 2], { operation: 'removeSmall', minimumVolumeMm3: 4 })
        .mask,
    ],
    [0, 0, 1, 1, 0, 0]
  );
});
test('seed deletion removes its entire 3D component, leaving disconnected and protected voxels', () => {
  const state = Uint8Array.from([1, 0, 1, 1, 0, 2]);
  const result = refineMask(state, [3, 1, 2], [1, 1, 2], {
    operation: 'removeSeed',
    seed: [0, 0, 0],
  });
  assert.deepEqual([...result.mask], [0, 0, 1, 0, 0, 0]);
  assert.equal(result.removedComponents, 1);
  assert.throws(
    () => refineMask(state, [3, 1, 2], [1, 1, 2], { operation: 'removeSeed', seed: [2, 0, 1] }),
    /已着色/
  );
});
test('empty masks are no-ops and invalid geometry, state and options are rejected', () => {
  assert.equal(
    refineMask(new Uint8Array(8), [2, 2, 2], [1, 1, 1], { operation: 'largest' }).components,
    0
  );
  const state = new Uint8Array(8).fill(1);
  for (const radiusMm of [0, NaN, 11])
    assert.throws(() => refineMask(state, [2, 2, 2], [1, 1, 1], { operation: 'dilate', radiusMm }));
  assert.throws(() =>
    refineMask(state, [2, 2, 2], [1, 1, 0], { operation: 'dilate', radiusMm: 1 })
  );
  assert.throws(() =>
    refineMask(Uint8Array.from([255]), [1, 1, 1], [1, 1, 1], { operation: 'largest' })
  );
  assert.throws(() =>
    refineMask(state, [2, 2, 2], [1, 1, 1], { operation: 'removeSmall', minimumVolumeMm3: -1 })
  );
});
test('all refinement operations report bounded monotonic progress without changing their results', () => {
  const state = new Uint8Array(27).fill(1);
  state[13] = 2;
  for (const operation of [
    'dilate',
    'erode',
    'open',
    'close',
    'smooth',
    'largest',
    'removeSmall',
    'removeSeed',
  ]) {
    const options = { operation, radiusMm: 1, minimumVolumeMm3: 4, seed: [0, 0, 0] };
    const values = [];
    const result = refineMask(state, [3, 3, 3], [1, 1, 2], options, (completed, total) =>
      values.push(completed / total)
    );
    assert.deepEqual(result, refineMask(state, [3, 3, 3], [1, 1, 2], options));
    assert.ok(values.length > 0);
    assert.equal(values.at(-1), 1);
    assert.ok(
      values.every((value, i) => value >= 0 && value <= 1 && (!i || value >= values[i - 1]))
    );
  }
});

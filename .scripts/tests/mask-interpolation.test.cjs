const { test } = require('node:test'),
  assert = require('node:assert/strict');
const {
  refineMask,
  parseInterpolationKeyframes,
  interpolationKeyframes,
} = require('../../extensions/cornerstone/src/utils/maskEditing/refinementAlgorithms.ts');
const { interpolationReference } = require('../interpolation-reference.cjs');
function fixture() {
  const dims = [9, 9, 9],
    plane = 81,
    state = new Uint8Array(729);
  for (const [z, low, high] of [
    [1, 2, 4],
    [4, 1, 6],
    [7, 3, 5],
  ])
    for (let y = low; y <= high; y++)
      for (let x = low; x <= high; x++) state[z * plane + y * 9 + x] = 1;
  return { dims, state, spacing: [0.6, 1.4, 3] };
}
function check(f, options) {
  options = { operation: 'interpolate', keyframes: [2, 5, 8], ...options };
  const original = f.state.slice(),
    expected = interpolationReference(f.state, f.dims, f.spacing, options);
  const actual = refineMask(f.state, f.dims, f.spacing, options);
  assert.deepEqual(f.state, original);
  assert.deepEqual(
    actual.mask,
    Uint8Array.from(expected.output, value => Number(value === 1))
  );
  assert.equal(actual.interpolatedSlices, expected.interpolatedSlices);
  assert.equal(actual.skippedSlices, expected.skippedSlices);
  return actual;
}
test('multiple changing keyframes match independent physical nearest-point interpolation', () => {
  const f = fixture(),
    actual = check(f);
  assert.equal(actual.interpolatedSlices, 4);
  assert.equal(actual.skippedSlices, 0);
  for (const z of [0, 1, 4, 7, 8])
    assert.deepEqual(
      actual.mask.subarray(z * 81, (z + 1) * 81),
      f.state.subarray(z * 81, (z + 1) * 81)
    );
});
test('multiple interpolation preserves manual intermediate layers unless replacement is explicit', () => {
  const f = fixture();
  f.state[3 * 81] = 1;
  f.state[6 * 81 + 40] = 2;
  assert.equal(check(f).skippedSlices, 1);
  const replaced = check(f, { replaceIntermediate: true });
  assert.equal(replaced.interpolatedSlices, 4);
  assert.equal(replaced.mask[3 * 81], 0);
  assert.equal(replaced.mask[6 * 81 + 40], 0);
});
test('adjacent keyframes remain unchanged while other intervals interpolate', () => {
  const f = fixture();
  f.state.set(f.state.subarray(81, 162), 2 * 81);
  const result = check(f, { keyframes: [2, 3, 5, 8], replaceIntermediate: true });
  assert.equal(result.interpolatedSlices, 3);
  assert.deepEqual(result.mask.subarray(2 * 81, 3 * 81), f.state.subarray(2 * 81, 3 * 81));
});
test('every explicit keyframe must contain target pixels, including an adjacent-only endpoint', () => {
  const f = fixture();
  for (const keyframes of [
    [2, 3, 5, 8],
    [2, 5, 8, 9],
  ])
    assert.throws(
      () => refineMask(f.state, f.dims, f.spacing, { operation: 'interpolate', keyframes }),
      /关键层没有/
    );
});
test('invalid, duplicate, descending and excessive keyframe lists are rejected', () => {
  const f = fixture();
  for (const keyframes of [
    [],
    [2],
    [2, 2, 8],
    [8, 5, 2],
    [0, 5, 8],
    [2, 5, 10],
    [2, 3],
    [2, 4.5, 8],
    [2, NaN, 8],
    null,
    '2,5,8',
    Array.from({ length: 65 }, (_, i) => i + 1),
  ])
    assert.throws(() =>
      refineMask(f.state, f.dims, f.spacing, { operation: 'interpolate', keyframes })
    );
});
test('keyframe text supports Chinese and ASCII separators without silently accepting invalid numbers', () => {
  assert.deepEqual(parseInterpolationKeyframes(' 2，5; 8；10\n12 '), [2, 5, 8, 10, 12]);
  for (const text of ['', '2, 5.5, 8', '2, -5, 8', '2, NaN, 8', '2, 5e1, 8'])
    assert.throws(() => parseInterpolationKeyframes(text));
  assert.throws(() =>
    parseInterpolationKeyframes(Array.from({ length: 65 }, (_, i) => i + 1).join(','))
  );
});
test('multi-keyframe progress is monotonic and accounts for skipped layers', () => {
  const f = fixture(),
    values = [];
  f.state[3 * 81] = 1;
  const options = { operation: 'interpolate', keyframes: [2, 5, 8] },
    before = [...options.keyframes];
  const result = refineMask(f.state, f.dims, f.spacing, options, (done, total) =>
    values.push([done, total])
  );
  assert.equal(result.interpolatedSlices + result.skippedSlices, 4);
  assert.deepEqual(values.at(-1), [4, 4]);
  assert.ok(values.every(([done, total], i) => done <= total && (!i || done >= values[i - 1][0])));
  assert.deepEqual(options.keyframes, before);
});
test('legacy two-keyframe options remain identical to an explicit list', () => {
  const f = fixture(),
    legacy = { operation: 'interpolate', startSlice: 2, endSlice: 8 };
  assert.deepEqual(
    refineMask(f.state, f.dims, f.spacing, legacy),
    refineMask(f.state, f.dims, f.spacing, { operation: 'interpolate', keyframes: [2, 8] })
  );
  const keys = [2, 5, 8],
    copy = interpolationKeyframes({ operation: 'interpolate', keyframes: keys }, 9);
  copy[0] = 1;
  assert.deepEqual(keys, [2, 5, 8]);
});
test('piecewise interpolation matches the independent reference for randomized small contours', () => {
  let seed = 61017;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 12; run++) {
    const f = fixture();
    f.state.fill(0);
    for (const z of [1, 4, 7]) {
      const x = 1 + Math.floor(random() * 4),
        y = 1 + Math.floor(random() * 4);
      for (let b = y; b < y + 3; b++)
        for (let a = x; a < x + 3; a++) f.state[z * 81 + b * 9 + a] = 1;
    }
    check(f);
  }
});

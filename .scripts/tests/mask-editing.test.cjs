const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  thresholdSlice,
  fillHolesSlice,
  splitMaskSlice,
  createSliceMapping,
  getAlignedPlaneAxis,
} = require('../../extensions/cornerstone/src/utils/maskEditing/maskAlgorithms.ts');

test('threshold uses inclusive raw intensity bounds and preserves another mask', () => {
  const labels = new Uint8Array([0, 0, 2, 0, 0]);
  const result = thresholdSlice(labels, [-1000, 150, 500, 2000, 2001], 5, 1, 1, 150, 2000);
  assert.deepEqual([...result], [0, 1, 2, 1, 0]);
  assert.deepEqual([...labels], [0, 0, 2, 0, 0]);
});

test('additive threshold preserves existing pixels outside the range', () => {
  assert.deepEqual([...thresholdSlice([1, 0], [-500, 200], 2, 1, 1, 150, 300, false)], [1, 1]);
});

test('replacement clears only the active mask outside the range', () => {
  assert.deepEqual([...thresholdSlice([1, 2, 0], [-500, -500, 200], 3, 1, 1, 150, 300)], [0, 2, 1]);
});

test('invalid threshold ranges and mismatched data are rejected', () => {
  assert.throws(() => thresholdSlice([0], [0], 1, 1, 1, 20, 10));
  assert.throws(() => thresholdSlice([0], [0], 1, 1, 1, NaN, 10));
  assert.throws(() => thresholdSlice([0], [], 1, 1, 1, 0, 10));
});

test('non-finite intensities never become selected', () => {
  assert.deepEqual([...thresholdSlice([0, 0], [NaN, Infinity], 2, 1, 1, -1000, 1000)], [0, 0]);
});

test('fill closes an enclosed hole and preserves the original input', () => {
  const labels = new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);
  assert.deepEqual([...fillHolesSlice(labels, 3, 3, 1)], Array(9).fill(1));
  assert.equal(labels[4], 0);
});

test('fill leaves an opening connected to the outer border unfilled', () => {
  const labels = [1, 0, 1, 1, 0, 1, 1, 1, 1];
  assert.deepEqual([...fillHolesSlice(labels, 3, 3, 1)], labels);
});

test('fill does not seal an opening connected diagonally to the border', () => {
  const labels = [0, 1, 1, 1, 0, 1, 1, 1, 1];
  assert.deepEqual([...fillHolesSlice(labels, 3, 3, 1)], labels);
});

test('fill preserves another segment enclosed in the selected mask', () => {
  const labels = [1, 1, 1, 1, 2, 1, 1, 1, 1];
  assert.deepEqual([...fillHolesSlice(labels, 3, 3, 1)], labels);
});

test('another mask cannot act as a closing wall for the selected mask', () => {
  const labels = [1, 2, 1, 1, 0, 1, 1, 1, 1];
  assert.deepEqual([...fillHolesSlice(labels, 3, 3, 1)], labels);
});

test('fill is a no-op on empty masks and single-row images', () => {
  assert.deepEqual([...fillHolesSlice(new Uint8Array(9), 3, 3, 1)], Array(9).fill(0));
  assert.deepEqual([...fillHolesSlice([1, 0, 1], 3, 1, 1)], [1, 0, 1]);
});

test('split retains the largest region, creates another label and preserves foreign masks', () => {
  const labels = new Uint8Array([1, 1, 0, 1, 2]);
  const result = splitMaskSlice(labels, 5, 1, 1, [1, 2]);
  assert.equal(result.componentCount, 2);
  assert.deepEqual(result.created, [{ segmentIndex: 3, pixelCount: 1 }]);
  assert.deepEqual([...result.pixels], [1, 1, 0, 3, 2]);
  assert.deepEqual([...labels], [1, 1, 0, 1, 2]);
});

test('split treats diagonal contacts as separate regions', () => {
  const result = splitMaskSlice([1, 0, 0, 1], 2, 2, 1, [1]);
  assert.equal(result.componentCount, 2);
  assert.deepEqual([...result.pixels], [1, 0, 0, 2]);
});

test('split reserves labels present outside the current slice', () => {
  const result = splitMaskSlice([1, 0, 1], 3, 1, 1, [1, 2, 3]);
  assert.equal(result.created[0].segmentIndex, 4);
});

test('split cannot overflow a uint8 labelmap and leaves input untouched on failure', () => {
  const labels = new Uint8Array([1, 0, 1]);
  assert.throws(() =>
    splitMaskSlice(
      labels,
      3,
      1,
      1,
      Array.from({ length: 255 }, (_, i) => i + 1)
    )
  );
  assert.deepEqual([...labels], [1, 0, 1]);
});

test('split supports uint16 labels without truncating them', () => {
  const result = splitMaskSlice([300, 0, 300], 3, 1, 300, [1, 300], 65535);
  assert.deepEqual([...result.pixels], [300, 0, 2]);
});

test('split refuses excessive noise instead of creating hundreds of masks', () => {
  const labels = Array.from({ length: 65 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  assert.throws(() => splitMaskSlice(labels, 65, 1, 1, [1]), /32/);
});

test('connected and empty masks do not create spurious segments', () => {
  assert.equal(splitMaskSlice([1, 1], 2, 1, 1, [1]).created.length, 0);
  assert.equal(splitMaskSlice([0, 0], 2, 1, 1, [1]).componentCount, 0);
});

test('axial, coronal and sagittal planes map to the correct volume indices', () => {
  const dimensions = [2, 3, 4];
  const axial = createSliceMapping(dimensions, 2, 2);
  assert.deepEqual([axial.width, axial.height], [2, 3]);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => axial.toIndex(i)),
    [12, 13, 14, 15, 16, 17]
  );
  const coronal = createSliceMapping(dimensions, 1, 1);
  assert.deepEqual([coronal.width, coronal.height], [2, 4]);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, i) => coronal.toIndex(i)),
    [2, 3, 8, 9, 14, 15, 20, 21]
  );
  const sagittal = createSliceMapping(dimensions, 0, 1);
  assert.deepEqual([sagittal.width, sagittal.height], [3, 4]);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => sagittal.toIndex(i)),
    [1, 3, 5, 7]
  );
});

test('plane mapping rejects out-of-bounds slices and invalid dimensions', () => {
  assert.throws(() => createSliceMapping([2, 3, 4], 2, 4));
  assert.throws(() => createSliceMapping([2, 3, 4], 2, -1));
  assert.throws(() => createSliceMapping([2, 3, 4], 3, 1));
  assert.throws(() => createSliceMapping([2, 0, 4], 2, 1));
});

test('plane matching respects the DICOM direction rather than world axes', () => {
  const rotated = [0, 1, 0, -1, 0, 0, 0, 0, 1];
  assert.equal(getAlignedPlaneAxis(rotated, [0, -1, 0]), 0);
  assert.equal(getAlignedPlaneAxis(rotated, [1, 0, 0]), 1);
  assert.throws(() => getAlignedPlaneAxis(rotated, [1, 1, 0]), /斜切面/);
});

test('pixel algorithms reject incorrect dimensions and background as an active mask', () => {
  assert.throws(() => fillHolesSlice([0], 2, 2, 1));
  assert.throws(() => fillHolesSlice([0], 1, 1, 0));
  assert.throws(() => splitMaskSlice([0], 1, 1, -1, []));
});

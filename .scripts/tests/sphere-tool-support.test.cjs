const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getCircleTool,
  isSphereTool,
  supportsSphereTools,
} = require('../../extensions/cornerstone/src/utils/maskEditing/sphereToolSupport.ts');

test('a single DICOM slice cannot enter a sphere strategy', () => {
  let called = false;
  assert.equal(
    supportsSphereTools(['slice-1'], false, () => {
      called = true;
      return true;
    }),
    false
  );
  assert.equal(called, false);
});

test('missing or empty image lists are unsupported', () => {
  assert.equal(
    supportsSphereTools(undefined, undefined, () => true),
    false
  );
  assert.equal(
    supportsSphereTools([], undefined, () => true),
    false
  );
});

test('complete reconstructable geometry preserves sphere support', () => {
  assert.equal(
    supportsSphereTools(['slice-1', 'slice-2'], true, () => true),
    true
  );
});

test('OHIF rejection takes precedence over the looser Cornerstone geometry check', () => {
  assert.equal(
    supportsSphereTools(['slice-1', 'slice-2'], false, () => true),
    false
  );
});

test('Cornerstone geometry rejection prevents late strategy failures', () => {
  assert.equal(
    supportsSphereTools(['slice-1', 'slice-2'], true, () => false),
    false
  );
});

test('missing geometry metadata is handled as unavailable instead of throwing', () => {
  assert.equal(
    supportsSphereTools(['slice-1', 'slice-2'], true, () => {
      throw Error('metadata unavailable');
    }),
    false
  );
});

test('all supported sphere tools have the correct two-dimensional fallback', () => {
  const cases = {
    SphereBrush: 'CircularBrush',
    SphereEraser: 'CircularEraser',
    ThresholdSphereBrush: 'ThresholdCircularBrush',
    ThresholdSphereBrushDynamic: 'ThresholdCircularBrushDynamic',
    SphereScissor: 'CircleScissor',
  };
  for (const [sphere, circle] of Object.entries(cases)) {
    assert.equal(isSphereTool(sphere), true);
    assert.equal(getCircleTool(sphere), circle);
  }
});

test('ordinary tools are not rewritten', () => {
  for (const tool of ['CircularBrush', 'CircularEraser', 'WindowLevel', 'Pan', 'Zoom']) {
    assert.equal(isSphereTool(tool), false);
    assert.equal(getCircleTool(tool), tool);
  }
});

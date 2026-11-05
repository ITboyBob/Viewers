import normalize from './normalizeImagePlaneGeometry';
test('合法缺省值与工作台旧规则一致，纯计算不修改来源', () => {
  const value = {};
  expect(normalize(value)).toEqual({
    position: [0, 0, 0],
    orientation: [1, 0, 0, 0, 1, 0],
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    pixelSpacing: [1, 1],
  });
  expect(value).toEqual({});
});
test('显式几何、数值字符串与校准间距完整保留', () => {
  const value = {
    ImagePositionPatient: ['1', '2', '3'],
    ImageOrientationPatient: new Float32Array([0, 1, 0, 1, 0, 0]),
  };
  expect(normalize(value, [2, 0.5])).toMatchObject({
    position: [1, 2, 3],
    rowCosines: [0, 1, 0],
    pixelSpacing: [2, 0.5],
  });
});
test.each([
  { ImagePositionPatient: 'bad' },
  { ImagePositionPatient: new DataView(new ArrayBuffer(8)) },
  { ImagePositionPatient: [1] },
  { ImagePositionPatient: [0, 0, NaN] },
])('损坏几何不伪造默认值：%p', value => {
  expect(() => normalize(value)).toThrow('几何');
});
test.each([[0, 1], [-1, 1], [1], ['bad', 1]])('非法显式间距被拒绝：%p', (...spacing) => {
  expect(() => normalize({}, spacing)).toThrow();
});

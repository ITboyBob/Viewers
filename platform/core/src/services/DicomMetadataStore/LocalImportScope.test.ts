import store from './DicomMetadataStore';
const image = (sop = '1.2.3', series = '1.2', study = '1') => ({
  StudyInstanceUID: study,
  SeriesInstanceUID: series,
  SOPInstanceUID: sop,
  imageId: `dicomfile:${sop}`,
  url: `dicomfile:${sop}`,
  PatientName: { Alphabetic: '合成' },
});
let active: ReturnType<typeof store.prepareLocalImportScope> | undefined;
afterEach(() => {
  active?.release();
  active = undefined;
});
test('准备不广播不改base，激活后所有读只见本批次，释放恢复同一个base对象', () => {
  store.addInstance(image('old', 'old-series'));
  store.addInstance(image('old-sop'));
  const base = store.getStudy('1');
  const original = JSON.stringify(base);
  const broadcast = jest.spyOn(store, '_broadcastEvent');
  active = store.prepareLocalImportScope('batch-a', [image()]);
  expect(broadcast).not.toHaveBeenCalled();
  broadcast.mockRestore();
  expect(store.getStudy('1')).toBe(base);
  active.activate();
  expect(store.getStudyInstanceUIDs()).toEqual(['1']);
  expect(store.getStudy('1').series).toHaveLength(1);
  expect(store.getSeries('1', '1.2').instances).toHaveLength(1);
  expect(store.getSeries(undefined, '1.2').instances).toHaveLength(1);
  expect(store.getInstance('1', '1.2', 'old-sop')).toBeUndefined();
  expect(store.getInstanceByImageId('dicomfile:old-sop')).toBeUndefined();
  expect(store.getInstanceByImageId('dicomfile:1.2.3').SOPInstanceUID).toBe('1.2.3');
  expect(store.getSeries('missing', '1.2')).toBeUndefined();
  active.release();
  expect(store.getStudy('1')).toBe(base);
  expect(JSON.stringify(base)).toBe(original);
});
test('作用域内所有写方法和派生SR、SEG保持原模型能力，不污染base', () => {
  const base = JSON.stringify(store.getStudy('1'));
  active = store.prepareLocalImportScope('batch-b', [image()]);
  active.activate();
  store.addInstance(image('generated', 'seg-series'));
  store.addInstances([image('generated2', 'sr-series')], true);
  store.addSeriesMetadata([
    { StudyInstanceUID: '1', SeriesInstanceUID: 'summary', Modality: 'SEG' },
  ]);
  store.updateSeriesMetadata({
    StudyInstanceUID: '1',
    SeriesInstanceUID: '1.2',
    SeriesDescription: '派生',
  });
  store.updateMetadataForSeries('1', '1.2', {
    PatientName: { Ideographic: '合成更新' },
    SeriesDescription: '新描述',
  });
  store.addStudy({ StudyInstanceUID: 'new', PatientID: 'synthetic' });
  store.addInstances([image('n', 's', 'created-by-instances')]);
  store.addSeriesMetadata([
    { StudyInstanceUID: 'created-by-summary', SeriesInstanceUID: 's', Modality: 'CT' },
  ]);
  store.addStudy({ StudyInstanceUID: 'new' });
  store.addSeriesMetadata([]);
  store.updateSeriesMetadata({ StudyInstanceUID: 'none', SeriesInstanceUID: 'none' });
  store.updateMetadataForSeries('none', 'none', {});
  expect(store.getStudy('1').series).toHaveLength(4);
  expect(store.getInstance('1', '1.2', '1.2.3').PatientName.Ideographic).toBe('合成更新');
  expect(store.getInstance('1', '1.2', '1.2.3').SeriesDescription).toBe('新描述');
  active.release();
  expect(JSON.stringify(store.getStudy('1'))).toBe(base);
  expect(store.getStudy('new')).toBeUndefined();
  expect(store.getStudy('created-by-summary')).toBeUndefined();
});
test('重复SOP折叠取原数组首次项，深层metadata不能污染输入', () => {
  const first = image();
  const second = { ...image(), InstanceNumber: 99 };
  active = store.prepareLocalImportScope('duplicate', [first, second]);
  active.activate();
  expect(store.getSeries('1', '1.2').instances).toHaveLength(1);
  expect(store.getInstance('1', '1.2', '1.2.3').InstanceNumber).toBeUndefined();
  store.getInstance('1', '1.2', '1.2.3').PatientName.Alphabetic = 'changed';
  expect(first.PatientName.Alphabetic).toBe('合成');
});
test('重复release和旧handle不释放新scope，已释放的handle不得再激活', () => {
  const old = store.prepareLocalImportScope('old', [image()]);
  old.activate();
  old.release();
  old.release();
  active = store.prepareLocalImportScope('new', [image('new', 's', '2')]);
  active.activate();
  old.release();
  expect(store.getStudyInstanceUIDs()).toEqual(['2']);
  expect(() => old.activate()).toThrow();
});
test('同一时刻只有一个活跃作用域，尚未激活handle释放不改变当前模型', () => {
  active = store.prepareLocalImportScope('active', [image()]);
  active.activate();
  active.activate();
  const pending = store.prepareLocalImportScope('pending', [image('x', 's', '3')]);
  expect(() => pending.activate()).toThrow();
  pending.release();
  expect(store.getStudyInstanceUIDs()).toEqual(['1']);
});
test.each([
  { datasets: [] },
  { datasets: [{}] },
  { datasets: [{ StudyInstanceUID: '', SeriesInstanceUID: '1', SOPInstanceUID: '1' }] },
])('无效准备输入不切换模型 %#', ({ datasets }) => {
  const base = store.getStudy('1');
  expect(() => store.prepareLocalImportScope('invalid', datasets)).toThrow();
  expect(store.getStudy('1')).toBe(base);
});

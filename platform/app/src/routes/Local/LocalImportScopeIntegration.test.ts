import { getStudiesfromDisplaySets } from '../Mode/studiesList';
// 仅将Jest不可解析的UMD入口映射到同一工作树真实源码；不替换数据源或路由行为。
import { DicomMetadataStore as store, DisplaySetService } from '@ohif/core';
import { createDicomLocalApi } from '../../../../../extensions/default/src/DicomLocalDataSource';
import { defaultRouteInit } from '../Mode/defaultRouteInit';
jest.mock('@ohif/core', () => jest.requireActual('../../../../core/src/index'), { virtual: true });
jest.mock(
  '@cornerstonejs/core',
  () => ({ utilities: {}, Enums: {}, metaData: { addProvider: jest.fn() } }),
  { virtual: true }
);
const image = (sop, series = '1.2') => ({
  StudyInstanceUID: '1',
  SeriesInstanceUID: series,
  SOPInstanceUID: sop,
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  Modality: 'CT',
  url: `dicomfile:${sop}`,
  PatientName: { Alphabetic: 'Synthetic' },
});
test('真实local source和defaultRouteInit不把同Study额外Series或同Series旧SOP送入makeDisplaySets', async () => {
  store.addInstance(image('old'));
  store.addInstance(image('old-series-sop', '1.9'));
  const base = store.getStudy('1');
  const scope = store.prepareLocalImportScope('batch', [image('new'), image('new')]);
  const source = createDicomLocalApi({ name: 'dicomlocal' });
  const displaySetService = new DisplaySetService();
  const handlerId = 'synthetic-display-hardware';
  // SOP handler是显示硬件边界，存储／数据源／displaySet容器／默认路由均使用真实实现。
  const handler = {
    sopClassUids: [image('x').SOPClassUID],
    getDisplaySetsFromSeries: instances => [
      {
        displaySetInstanceUID: 'synthetic-display',
        SOPClassHandlerId: handlerId,
        StudyInstanceUID: '1',
        SeriesInstanceUID: instances[0].SeriesInstanceUID,
        images: instances,
        instances,
      },
    ],
  };
  displaySetService.init({ getModuleEntry: () => handler }, [handlerId]);
  const make = jest.spyOn(displaySetService, 'makeDisplaySets');
  let unsubscribe = [];
  try {
    scope.activate();
    expect(source.query.studies.search({})[0].NumInstances).toBe(1);
    expect(source.query.series.search('1')).toHaveLength(1);
    unsubscribe = await defaultRouteInit(
      {
        servicesManager: {
          services: {
            displaySetService,
            hangingProtocolService: { run: jest.fn() },
            uiNotificationService: { show: jest.fn() },
            customizationService: { getCustomization: jest.fn() },
          },
        },
        studyInstanceUIDs: ['1'],
        dataSource: source,
        filters: {},
        appConfig: {},
      } as unknown as Parameters<typeof defaultRouteInit>[0],
      'synthetic',
      0
    );
    expect(make).toHaveBeenCalledTimes(1);
    expect(make.mock.calls[0][0].map(item => item.SOPInstanceUID)).toEqual(['new']);
    const sets = displaySetService.getActiveDisplaySets();
    expect(sets.flatMap(set => set.instances.map(item => item.SOPInstanceUID))).toEqual(['new']);
    expect(source.getImageIdsForDisplaySet(sets[0])).toEqual(['dicomfile:new']);
  } finally {
    unsubscribe.forEach(stop => stop());
    scope.release();
    displaySetService.getDisplaySetCache().clear();
  }
  expect(store.getStudy('1')).toBe(base);
  expect(source.query.series.search('1')).toHaveLength(2);
  await source.retrieve.series.metadata({ StudyInstanceUID: '1' });
  expect(store.getSeries('1', '1.2').instances.map(item => item.SOPInstanceUID)).toEqual(['old']);
});

test('没有UID列表时，真实原生displaySet回退仍能从当前模型读取Study', () => {
  const study = store.getStudy('1');
  expect(
    getStudiesfromDisplaySets([
      { StudyInstanceUID: '1' },
      { StudyInstanceUID: '1' },
    ] as unknown as Parameters<typeof getStudiesfromDisplaySets>[0])
  ).toEqual([study]);
});

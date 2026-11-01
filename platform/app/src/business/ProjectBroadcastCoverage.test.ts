import MeasurementService, {
  EVENTS as MEASUREMENT,
} from '../../../core/src/services/MeasurementService/MeasurementService';
import SegmentationService, {
  EVENTS as SEGMENTATION,
} from '../../../../extensions/cornerstone/src/services/SegmentationService/SegmentationService';
import getSegModule from '../../../../extensions/cornerstone-dicom-seg/src/getSopClassHandlerModule';
import getPmapModule from '../../../../extensions/cornerstone-dicom-pmap/src/getSopClassHandlerModule';
import { eventTarget } from '@cornerstonejs/core';
import { Enums } from '@cornerstonejs/tools';
import { ProjectUpdateBridge } from './ProjectUpdateBridge';
import type { LocalProject } from '@ohif/core';

// 真实OHIF服务与真实SEG／PMAP处理器；仅替换Cornerstone解码、缓存和渲染依赖。
jest.mock(
  '@ohif/core',
  () => ({
    PubSubService: jest.requireActual('../../../core/src/services/_shared/pubSubServiceInterface')
      .PubSubService,
    utils: { guid: () => `synthetic-${++mockId}` },
  }),
  { virtual: true }
);
jest.mock('@ohif/i18n', () => ({ __esModule: true, default: { t: value => value } }), {
  virtual: true,
});
jest.mock(
  '@cornerstonejs/core',
  () => ({
    eventTarget: new EventTarget(),
    metaData: { get: () => ({}) },
    cache: {
      getVolumeLoadObject: () => undefined,
      putVolumeLoadObject: async () => undefined,
      getVolume: () => ({ imageIds: ['dicomfile:0'] }),
    },
    utilities: { windowLevel: { toWindowLevel: () => ({ windowWidth: 1, windowCenter: 1 }) } },
    volumeLoader: {
      createAndCacheDerivedVolume: async () => ({
        voxelManager: { setCompleteScalarDataArray: jest.fn() },
        imageIds: [],
        metadata: {},
      }),
    },
  }),
  { virtual: true }
);
jest.mock(
  '@cornerstonejs/tools',
  () => ({
    Enums: {
      SegmentationRepresentations: { Labelmap: 'Labelmap', Contour: 'Contour' },
      Events: Object.fromEntries(
        [
          'SEGMENTATION_MODIFIED',
          'SEGMENTATION_REMOVED',
          'SEGMENTATION_DATA_MODIFIED',
          'SEGMENTATION_REPRESENTATION_MODIFIED',
          'SEGMENTATION_REPRESENTATION_ADDED',
          'SEGMENTATION_REPRESENTATION_REMOVED',
          'SEGMENTATION_ADDED',
        ].map(name => [name, `source:${name}`])
      ),
    },
    segmentation: { state: { getSegmentations: () => [], getSegmentation: () => undefined } },
    CONSTANTS: {
      COLOR_LUT: [
        [0, 0, 0, 0],
        [255, 0, 0, 255],
      ],
    },
  }),
  { virtual: true }
);
jest.mock(
  '@cornerstonejs/adapters',
  () => ({
    Enums: { Events: { SEGMENTATION_LOAD_PROGRESS: 'source:seg-progress' } },
    adaptersSEG: {
      Cornerstone3D: {
        Segmentation: {
          createFromDICOMSegBuffer: async () => {
            const { eventTarget: target } = jest.requireMock('@cornerstonejs/core');
            target.dispatchEvent(
              new CustomEvent('source:seg-progress', { detail: { percentComplete: 0.5 } })
            );
            return { segMetadata: { data: [null] } };
          },
        },
      },
    },
    adaptersPMAP: {
      Cornerstone3D: {
        ParametricMap: { generateToolState: async () => ({ pixelData: new Float32Array([1]) }) },
      },
    },
  }),
  { virtual: true }
);
jest.mock(
  '@ohif/extension-cornerstone',
  () => ({
    dicomLoaderService: { findDicomDataPromise: async () => new ArrayBuffer(0) },
    VOLUME_LOADER_SCHEME: 'synthetic',
  }),
  { virtual: true }
);
jest.mock('../../../../extensions/cornerstone/src/utils/transitions', () => ({}));
jest.mock(
  '../../../../extensions/cornerstone/src/services/SegmentationService/RTSTRUCT/mapROIContoursToRTStructData',
  () => ({})
);
jest.mock(
  '@cornerstonejs/tools/enums',
  () => ({ SegmentationRepresentations: { Labelmap: 'Labelmap' } }),
  { virtual: true }
);
jest.mock('@cornerstonejs/core/enums', () => ({ ViewportType: {} }), { virtual: true });
jest.mock('@cornerstonejs/tools/segmentation/addColorLUT', () => ({}), { virtual: true });
jest.mock('@cornerstonejs/tools/segmentation/getNextColorLUTIndex', () => ({}), { virtual: true });
jest.mock(
  '@cornerstonejs/tools/segmentation/updateLabelmapSegmentationImageReferences',
  () => ({}),
  { virtual: true }
);
jest.mock('@cornerstonejs/tools/segmentation/triggerSegmentationEvents', () => ({}), {
  virtual: true,
});
jest.mock('@cornerstonejs/tools/segmentation/helpers/convertStackToVolumeLabelmap', () => ({}), {
  virtual: true,
});
jest.mock('@cornerstonejs/tools/segmentation', () => ({}), { virtual: true });
let mockId = 0;
const flush = async () => {
  for (let n = 0; n < 60; n++) {
    await Promise.resolve();
  }
};

test('真实方法／源回调与SEG／PMAP加载共12类；3个仅声明项独立统计', async () => {
  const measurement = new MeasurementService();
  const displaySet = { displaySetInstanceUID: 'original', imageIds: ['dicomfile:0'] };
  const manager = {
    services: {
      displaySetService: {
        getDisplaySetsForSeries: () => [displaySet],
        getDisplaySetByUID: () => displaySet,
      },
      uiNotificationService: { show: jest.fn() },
    },
  };
  const segmentation = new SegmentationService({ servicesManager: manager });
  manager.services['segmentationService'] = segmentation;
  const project = {
    batch_id: 'batch',
    task_id: 'real',
    title: '合成.dcm',
    phase: 'registered',
    study_uids: ['1'],
    successes: [{ study_uid: '1', series_uid: '1.2', sop_uid: '1.2.3', image_id: 'dicomfile:0' }],
  } as LocalProject;
  const observed: string[] = [];
  [measurement, segmentation].forEach(service =>
    Object.values(service.EVENTS).forEach(event =>
      service.subscribe(event, () => observed.push(event))
    )
  );
  const touch = jest
    .fn()
    .mockResolvedValue({ task_id: 'real', updated_at: '2026-11-01T00:00:01Z' });
  const bridge = new ProjectUpdateBridge({
    project,
    projects: { isCurrent: () => true, updateTimestamp: jest.fn() } as never,
    tasks: { touch } as never,
    measurementService: measurement,
    segmentationService: segmentation,
    isActive: () => true,
    notify: jest.fn(),
  });
  const stop = bridge.start();
  const source = measurement.createSource('synthetic', '1');
  measurement.addMapping(
    source,
    'Length',
    () => true,
    value => value,
    detail => ({
      uid: detail.uid,
      referenceStudyUID: '1',
      referenceSeriesUID: '1.2',
      SOPInstanceUID: '1.2.3',
    })
  );
  source.annotationToMeasurement('Length', { uid: 'm' }); // 初次创建只入状态，完成后才广播ADDED。
  source.annotationToMeasurement('Length', { uid: 'm' });
  measurement.update('m', measurement.getMeasurement('m'));
  measurement.jumpToMeasurement('viewport', 'm');
  measurement.remove('m');
  measurement.addRawMeasurement(source, 'Length', { uid: 'raw', annotation: { data: {} } }, () => ({
    referenceStudyUID: '1',
  }));
  measurement.clearMeasurements();
  segmentation.onModeEnter();
  const sourceEvents = [
    Enums.Events.SEGMENTATION_ADDED,
    Enums.Events.SEGMENTATION_MODIFIED,
    Enums.Events.SEGMENTATION_DATA_MODIFIED,
    Enums.Events.SEGMENTATION_REPRESENTATION_MODIFIED,
  ];
  sourceEvents.forEach(name =>
    eventTarget.dispatchEvent(new CustomEvent(name, { detail: { segmentationId: 's' } }))
  );
  const extensionManager = {
    getModuleEntry: () => ({
      exports: { dicomLoaderService: { findDicomDataPromise: async () => new ArrayBuffer(0) } },
    }),
  };
  const instance = {
    StudyInstanceUID: '1',
    SeriesInstanceUID: '1.2',
    SOPInstanceUID: '1.2.3',
    ReferencedSeriesSequence: [{ SeriesInstanceUID: '1.2' }],
  };
  // SEG进度经过真实处理器；分割几何创建不在此事件链测试内。
  jest.spyOn(segmentation, 'createSegmentationForSEGDisplaySet').mockResolvedValue('s');
  const [seg] = getSegModule({
    servicesManager: manager,
    extensionManager,
  } as never)[0].getDisplaySetsFromSeries([instance]);
  await seg.load({ headers: {} });
  const [pmap] = getPmapModule({
    servicesManager: manager,
    extensionManager,
  } as never)[0].getDisplaySetsFromSeries([instance]);
  await pmap.load({ headers: {} });
  await flush();
  const actual = new Set(observed);
  expect(actual).toEqual(
    new Set([
      MEASUREMENT.MEASUREMENT_ADDED,
      MEASUREMENT.MEASUREMENT_UPDATED,
      MEASUREMENT.RAW_MEASUREMENT_ADDED,
      MEASUREMENT.MEASUREMENT_REMOVED,
      MEASUREMENT.MEASUREMENTS_CLEARED,
      MEASUREMENT.JUMP_TO_MEASUREMENT,
      SEGMENTATION.SEGMENTATION_ADDED,
      SEGMENTATION.SEGMENTATION_MODIFIED,
      SEGMENTATION.SEGMENTATION_DATA_MODIFIED,
      SEGMENTATION.SEGMENTATION_REPRESENTATION_MODIFIED,
      SEGMENTATION.SEGMENT_LOADING_COMPLETE,
      SEGMENTATION.SEGMENTATION_LOADING_COMPLETE,
    ])
  );
  expect(touch).toHaveBeenCalledTimes(observed.length);
  expect(
    [...Object.values(MEASUREMENT), ...Object.values(SEGMENTATION)].filter(
      event => !actual.has(event)
    )
  ).toEqual([
    MEASUREMENT.INTERNAL_MEASUREMENT_UPDATED,
    SEGMENTATION.SEGMENTATION_REMOVED,
    SEGMENTATION.SEGMENTATION_REPRESENTATION_REMOVED,
  ]);
  stop();
  segmentation.destroy();
});

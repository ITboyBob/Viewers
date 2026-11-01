import { ProjectUpdateBridge } from './ProjectUpdateBridge';
import { BusinessApiError } from './BusinessApiClient';
import { PubSubService } from '../../../core/src/services/_shared/pubSubServiceInterface';
import { EVENTS as MEASUREMENT } from '../../../core/src/services/MeasurementService/MeasurementService';
import type { LocalProject } from '@ohif/core';

const SEGMENTATION = {
  SEGMENTATION_MODIFIED: 'event::segmentation_modified',
  SEGMENTATION_ADDED: 'event::segmentation_added',
  SEGMENTATION_DATA_MODIFIED: 'event::segmentation_data_modified',
  SEGMENTATION_REMOVED: 'event::segmentation_removed',
  SEGMENTATION_REPRESENTATION_MODIFIED: 'event::segmentation_representation_modified',
  SEGMENTATION_REPRESENTATION_REMOVED: 'event::segmentation_representation_removed',
  SEGMENT_LOADING_COMPLETE: 'event::segment_loading_complete',
  SEGMENTATION_LOADING_COMPLETE: 'event::segmentation_loading_complete',
};
const flush = async () => {
  for (let n = 0; n < 40; n++) {
    await Promise.resolve();
  }
};
const deferred = () => {
  let resolve: (value: unknown) => void, reject: (error: unknown) => void;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve: value => resolve(value), reject: error => reject(error) };
};
let project: LocalProject, active: boolean, current: boolean, tick: number;
let measurement, segmentation, touch: jest.Mock, invalidate: jest.Mock, notify: jest.Mock;
let measurements: Map<string, unknown>,
  segmentations: Map<string, unknown>,
  bridge: ProjectUpdateBridge;
const measurementRecord = (uid = 'm', study = '1') => ({
  uid,
  referenceStudyUID: study,
  referenceSeriesUID: `${study}.2`,
  SOPInstanceUID: `${study}.2.3`,
});
const segmentationRecord = (id = 's', image = 'dicomfile:0') => ({
  segmentationId: id,
  representationData: { Labelmap: { referencedImageIds: [image] } },
});
beforeEach(() => {
  active = true;
  current = true;
  tick = 0;
  project = {
    batch_id: 'batch',
    importer_uid: 'u',
    team_id: 't',
    title: '合成.dcm',
    phase: 'registered',
    task_id: 'real',
    updated_at: '2026-11-01T00:00:00Z',
    study_uids: ['1'],
    successes: [{ study_uid: '1', series_uid: '1.2', sop_uid: '1.2.3', image_id: 'dicomfile:0' }],
  } as LocalProject;
  measurements = new Map();
  segmentations = new Map();
  measurement = Object.assign(new PubSubService({ ...MEASUREMENT }), {
    getMeasurements: () => [...measurements.values()],
    getMeasurement: uid => measurements.get(uid),
  });
  segmentation = Object.assign(new PubSubService(SEGMENTATION), {
    getSegmentations: () => [...segmentations.values()],
    getSegmentation: id => segmentations.get(id),
  });
  touch = jest.fn().mockImplementation(async () => ({
    task_id: 'real',
    updated_at: `2026-11-01T00:00:00.${String(++tick).padStart(3, '0')}Z`,
  }));
  invalidate = jest.fn(() => {
    project.phase = 'invalid';
    current = false;
  });
  notify = jest.fn();
  bridge = new ProjectUpdateBridge({
    project,
    projects: {
      isCurrent: () => current,
      invalidate,
      updateTimestamp: (p, timestamp) => {
        p.updated_at = timestamp.updated_at;
      },
    },
    tasks: { touch },
    measurementService: measurement,
    segmentationService: segmentation,
    isActive: () => active,
    notify,
  });
});
const listeners = service =>
  Object.values(service.listeners).reduce((n: number, items: unknown[]) => n + items.length, 0);
test('去重订阅测量7、分割8字典项；对象退订幂等且最终监听数归零', () => {
  measurement.EVENTS.ALIAS = MEASUREMENT.JUMP_TO_MEASUREMENT;
  const stop = bridge.start();
  expect(listeners(measurement)).toBe(7);
  expect(listeners(segmentation)).toBe(8);
  stop();
  stop();
  expect(listeners(measurement)).toBe(0);
  expect(listeners(segmentation)).toBe(0);
  delete measurement.EVENTS.ALIAS;
});
test.each([
  ...Object.values(MEASUREMENT).map(event => ['measurement', event]),
  ...Object.values(SEGMENTATION).map(event => ['segmentation', event]),
])('字典项%s %s均触发，含展示及仅声明项；DOM转发不双计', async (kind, event) => {
  const stop = bridge.start();
  (kind === 'measurement' ? measurement : segmentation)._broadcastEvent(event, {});
  await flush();
  expect(touch).toHaveBeenCalledTimes(1);
  stop();
});
test('突发事件每个一次FIFO请求，每请求独立AbortSignal，不合并或并发', async () => {
  const pending = [deferred(), deferred(), deferred()];
  pending.forEach(item => touch.mockImplementationOnce(() => item.promise));
  const stop = bridge.start();
  for (let n = 0; n < 3; n++) {
    measurement._broadcastEvent(MEASUREMENT.JUMP_TO_MEASUREMENT, {});
  }
  expect(touch).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 3; n++) {
    pending[n].resolve({ task_id: 'real', updated_at: `2026-11-01T00:00:0${n + 1}Z` });
    await flush();
    expect(touch).toHaveBeenCalledTimes(Math.min(n + 2, 3));
  }
  expect(new Set(touch.mock.calls.map(call => call[1])).size).toBe(3);
  expect(project.updated_at).toBe('2026-11-01T00:00:03Z');
  expect(project.title).toBe('合成.dcm');
  expect(project.task_id).toBe('real');
  stop();
});
test.each(['inactive', 'identity', 'unregistered', 'invalid'])(
  '%s资格无效不订阅或发送',
  async reason => {
    if (reason === 'inactive') {
      active = false;
    }
    if (reason === 'identity') {
      current = false;
    }
    if (reason === 'unregistered') {
      project.task_id = undefined;
    }
    if (reason === 'invalid') {
      project.phase = 'invalid';
    }
    const stop = bridge.start();
    measurement._broadcastEvent(MEASUREMENT.MEASUREMENTS_CLEARED, {});
    await flush();
    expect(touch).not.toHaveBeenCalled();
    expect(listeners(measurement)).toBe(0);
    stop();
  }
);
test.each([
  { measurement: measurementRecord('old', '9') },
  { measurement: { referenceSeriesUID: '9.2' } },
  { measurement: { SOPInstanceUID: '9.2.3' } },
  { measurement: { referencedImageId: 'dicomfile:9' } },
  { scope_id: 'previous' },
  { batch_id: 'previous' },
  { segDisplaySet: { StudyInstanceUID: '9' } },
  { pmapDisplaySet: { StudyInstanceUID: '9' } },
])('明确跨Study、Series、SOP、image或scope的payload被拒绝 %#', async payload => {
  const stop = bridge.start();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_UPDATED, payload);
  await flush();
  expect(touch).not.toHaveBeenCalled();
  stop();
});
test('预先记录measurement和segmentation归属，源移除后仍识别合法／旧资源', async () => {
  measurements.set('m', measurementRecord());
  measurements.set('old', measurementRecord('old', '9'));
  segmentations.set('s', segmentationRecord());
  segmentations.set('old', segmentationRecord('old', 'dicomfile:9'));
  const stop = bridge.start();
  measurements.clear();
  segmentations.clear();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_REMOVED, { measurement: 'old' });
  segmentation._broadcastEvent(SEGMENTATION.SEGMENTATION_REMOVED, { segmentationId: 'old' });
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_REMOVED, { measurement: 'm' });
  segmentation._broadcastEvent(SEGMENTATION.SEGMENTATION_REMOVED, { segmentationId: 's' });
  await flush();
  expect(touch).toHaveBeenCalledTimes(2);
  stop();
});
test('加载、空清理、无资源payload正例；可识别旧分割和全旧清理不串项目', async () => {
  segmentations.set('old', segmentationRecord('old', 'dicomfile:9'));
  const stop = bridge.start();
  segmentation._broadcastEvent(SEGMENTATION.SEGMENTATION_MODIFIED, { segmentationId: 'old' });
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENTS_CLEARED, {
    measurements: [measurementRecord('old', '9')],
  });
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENTS_CLEARED, { measurements: [] });
  segmentation._broadcastEvent(SEGMENTATION.SEGMENT_LOADING_COMPLETE, { percentComplete: 0.5 });
  await flush();
  expect(touch).toHaveBeenCalledTimes(2);
  stop();
});
test('停止先失活、退订、中止并丢弃未发队列，晚响应不改内存时间', async () => {
  const pending = deferred();
  touch.mockReturnValue(pending.promise);
  const stop = bridge.start();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  const signal = touch.mock.calls[0][1];
  stop();
  expect(signal.aborted).toBe(true);
  expect(listeners(measurement)).toBe(0);
  pending.resolve({ task_id: 'real', updated_at: '2026-11-01T00:00:05Z' });
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENTS_CLEARED, {});
  await flush();
  expect(touch).toHaveBeenCalledTimes(1);
  expect(project.updated_at).toBe('2026-11-01T00:00:00Z');
});
test.each([401, 403, 404])('%s失效清队列、退订、不无限重试', async status => {
  touch.mockRejectedValue(new BusinessApiError(status, 'DENIED', '拒绝'));
  bridge.start();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  await flush();
  expect(invalidate).toHaveBeenCalledWith(project);
  expect(project.phase).toBe('invalid');
  expect(touch).toHaveBeenCalledTimes(1);
  expect(listeners(measurement)).toBe(0);
  expect(notify).toHaveBeenCalled();
});
test.each([0, 500, 502])('暂时失败%s提示未更新，下个合法事件可继续', async status => {
  touch.mockRejectedValueOnce(new BusinessApiError(status, 'TEMPORARY', '暂不可用'));
  const stop = bridge.start();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  await flush();
  expect(notify).toHaveBeenCalledWith('项目时间未更新，请在下次操作后重试');
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  await flush();
  expect(touch).toHaveBeenCalledTimes(2);
  expect(invalidate).not.toHaveBeenCalled();
  stop();
});
test('排队期间旧generation不得继续发，HTTP、通知或DOM本身均不能触发', async () => {
  const pending = deferred();
  touch.mockReturnValueOnce(pending.promise);
  const stop = bridge.start();
  document.body.dispatchEvent(new CustomEvent(MEASUREMENT.MEASUREMENT_ADDED, { detail: {} }));
  expect(touch).not.toHaveBeenCalled();
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  measurement._broadcastEvent(MEASUREMENT.MEASUREMENT_ADDED, {});
  active = false;
  pending.resolve({ task_id: 'real', updated_at: '2026-11-01T00:00:01Z' });
  await flush();
  expect(touch).toHaveBeenCalledTimes(1);
  expect(project.updated_at).toBe('2026-11-01T00:00:00Z');
  stop();
});

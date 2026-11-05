import { Blob as NodeBlob } from 'buffer';
import { TextEncoder, TextDecoder } from 'util';
import { encodeResult, decodeResult } from './TaskResultCodec';
Object.assign(global, { Blob: NodeBlob, TextEncoder, TextDecoder });
const project: any = {
  task_id: 'task',
  successes: [
    {
      image_id: 'dicomfile:0',
      study_uid: '1',
      series_uid: '2',
      sop_uid: '3',
      dataset: { NumberOfFrames: 2 },
    },
  ],
};
test('二进制像素及稳定UID引用在新原生ID下完整往返，不保存临时URL', async () => {
  const blob = encodeResult(project, 'SEG', {
    referenceId: 'dicomfile:0&frame=2',
    pixels: new Uint16Array([1, 0, 65535]),
    name: '测试Mask',
  });
  const reopened = {
    ...project,
    successes: [{ ...project.successes[0], image_id: 'dicomfile:99' }],
  };
  const result = await decodeResult(reopened, { type: 'SEG', blob });
  expect(result.referenceId).toBe('dicomfile:99&frame=2');
  expect([...result.pixels]).toEqual([1, 0, 65535]);
  expect(result.pixels).toBeInstanceOf(Uint16Array);
});
test('拒绝其他任务、类型不符及破损包', async () => {
  const blob = encodeResult(project, 'SR', { annotations: [] });
  await expect(
    decodeResult({ ...project, task_id: 'other' }, { type: 'SR', blob })
  ).rejects.toThrow();
  await expect(decodeResult(project, { type: 'SEG', blob })).rejects.toThrow();
  await expect(
    decodeResult(project, { type: 'SR', blob: new Blob([new Uint8Array([1])]) })
  ).rejects.toThrow();
});

test('统计缓存键不固化页面imageId或volumeId', async () => {
  const blob = encodeResult(project, 'SR', {
    cachedStats: {
      'stack:dicomfile:0': { length: 12 },
      'volumeId:temporary-volume': { length: 12 },
    },
  });
  const reopened = {
    ...project,
    successes: [{ ...project.successes[0], image_id: 'dicomfile:99' }],
  };
  const value = await decodeResult(reopened, { type: 'SR', blob });
  expect(value.cachedStats['stack:dicomfile:99']).toEqual({ length: 12 });
  expect(value.cachedStats['stored-volume-stats']).toEqual({ length: 12 });
});

test('只读解码保留稳定引用，不需要建立原生项目或改写全局状态', async () => {
  const { decodeResultState } = await import('./TaskResultCodec');
  const blob = encodeResult(project, 'SR', { referenceId: 'dicomfile:0', annotations: [] });
  expect(await decodeResultState('task', { type: 'SR', blob })).toEqual({
    referenceId: 'urn:colla:image:1/2/3',
    annotations: [],
  });
});

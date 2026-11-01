import { randomUUID } from 'crypto';
import filesToImportBatch, { releaseImportBatch } from './filesToImportBatch';
import FileLoaderService from './fileLoaderService';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID, configurable: true });

jest.mock('./fileLoaderService', () => jest.fn());
jest.mock(
  '@cornerstonejs/dicom-image-loader',
  () => ({ wadouri: { fileManager: { remove: jest.fn() } } }),
  { virtual: true }
);
const remove = dicomImageLoader.wadouri.fileManager.remove as jest.Mock;
const file = (name: string, path = '') =>
  Object.assign(new File(['synthetic'], name), { webkitRelativePath: path });
const dataset = (sop = '1.2.3') => ({
  StudyInstanceUID: '1',
  SeriesInstanceUID: '1.2',
  SOPInstanceUID: sop,
  Modality: 'CT',
});
let finish: Array<(value?: unknown) => void>;
beforeEach(() => {
  jest.clearAllMocks();
  finish = [];
  (FileLoaderService as jest.Mock).mockImplementation(() => {
    const index = finish.length;
    const pending = new Promise(resolve => {
      finish.push(resolve);
    });
    return {
      addFile: () => `dicomfile:${index}`,
      loadFile: () => pending,
      getDataset: value => {
        if (value instanceof Error) {
          throw value;
        }
        return value;
      },
    };
  });
});
test('乱序完成仍按选择顺序保存成功子集，不读取或写入全局缓存', async () => {
  const pending = filesToImportBatch({
    files: [file('坏.dcm'), file('首个.dcm'), file('第二.dcm')],
    kind: 'files',
  });
  finish[2](dataset('1.2.5'));
  finish[0](new Error('private path'));
  finish[1](dataset('1.2.4'));
  const batch = await pending;
  expect(batch.successes.map(item => [item.selection_index, item.file_name])).toEqual([
    [1, '首个.dcm'],
    [2, '第二.dcm'],
  ]);
  expect(batch.study_uids).toEqual(['1']);
  expect(batch.failures).toEqual([
    { selection_index: 0, file_name: '坏.dcm', reason: 'PARSE_FAILED' },
  ]);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(0);
});
test('单文件成功含真实loader image_id及dataset，重复SOP不丢失成功文件集合', async () => {
  const pending = filesToImportBatch({ files: [file('a'), file('b')], kind: 'files' });
  finish.forEach(done => done(dataset()));
  const batch = await pending;
  expect(batch.successes).toHaveLength(2);
  expect(batch.successes[0].image_id).toBe('dicomfile:0');
  expect(batch.successes[0].dataset.url).toBe('dicomfile:0');
  releaseImportBatch(batch);
  releaseImportBatch(batch);
  expect(remove.mock.calls).toEqual([[0], [1]]);
});
test.each(['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID'])(
  '无效%s不得成为成功项',
  async field => {
    const pending = filesToImportBatch({ files: [file('bad')], kind: 'files' });
    finish[0]({ ...dataset(), [field]: '' });
    const batch = await pending;
    expect(batch.successes).toHaveLength(0);
    expect(batch.failures[0].reason).toBe('INVALID_DATASET');
    expect(remove).toHaveBeenCalledWith(0);
  }
);
test('文件夹只取共同首级目录，不取嵌套目录', async () => {
  const pending = filesToImportBatch({ files: [file('a', '根目录/嵌套/a')], kind: 'folder' });
  finish[0](dataset());
  expect((await pending).folder_name).toBe('根目录');
});
test.each([
  ['a/x', 'b/y'],
  ['', ''],
])('多个根或无法确定的目录拒绝且不解析', async (a, b) => {
  await expect(
    filesToImportBatch({ files: [file('x', a), file('y', b)], kind: 'folder' })
  ).rejects.toThrow('单一文件夹');
  expect(FileLoaderService).not.toHaveBeenCalled();
});
test('drop明确给出目录名时可沿用，空输入不创建成功项', async () => {
  expect((await filesToImportBatch({ files: [], kind: 'files' })).successes).toEqual([]);
  const pending = filesToImportBatch({
    files: [file('a')],
    kind: 'folder',
    folderName: 'drop目录',
  });
  finish[0](dataset());
  expect((await pending).folder_name).toBe('drop目录');
});
test('只删除本次add成功返回的合法索引，不解析不可信image_id', async () => {
  (FileLoaderService as jest.Mock).mockImplementation(() => ({
    addFile: () => 'dicomfile:3evil',
    loadFile: () => Promise.reject(new Error('x')),
  }));
  const batch = await filesToImportBatch({ files: [file('bad')], kind: 'files' });
  expect(batch.failures).toHaveLength(1);
  expect(remove).not.toHaveBeenCalled();
});
test('清理失败可展示安全分类，不泄露原始异常也不全局purge', async () => {
  remove.mockImplementationOnce(() => {
    throw new Error('/private/patient');
  });
  const pending = filesToImportBatch({ files: [file('bad')], kind: 'files' });
  finish[0](new Error('bad'));
  expect((await pending).failures[0].reason).toBe('CLEANUP_FAILED');
});

test('调用入口冻结文件数组及kind，解析期间修改选择对象不改变本批次', async () => {
  const input = { files: [file('原选择')], kind: 'files' as 'files' | 'folder' };
  const pending = filesToImportBatch(input);
  input.files.push(file('后来追加'));
  input.kind = 'folder';
  finish[0](dataset());
  const batch = await pending;
  expect(batch.kind).toBe('files');
  expect(batch.successes.map(item => item.file_name)).toEqual(['原选择']);
});

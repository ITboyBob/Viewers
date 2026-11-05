import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { BusinessServices } from '@ohif/core';
import { cache, imageLoader } from '@cornerstonejs/core';
import filesToImportBatch, { releaseImportBatch } from '../Local/filesToImportBatch';
import TaskPreview from './TaskPreview';

jest.mock(
  '@cornerstonejs/core',
  () => ({
    imageLoader: { loadAndCacheImage: jest.fn() },
    cache: { getImageLoadObject: jest.fn(() => ({})), removeImageLoadObject: jest.fn() },
  }),
  {
    virtual: true,
  }
);
jest.mock('../Local/filesToImportBatch', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseImportBatch: jest.fn(),
}));

type PreviewImage = {
  columns: number;
  rows: number;
  getPixelData: () => Int16Array | Uint8Array;
  windowCenter?: number | number[];
  windowWidth?: number | number[];
  minPixelValue: number;
  maxPixelValue: number;
  slope?: number;
  intercept?: number;
  preScale?: { enabled?: boolean; scaled?: boolean };
  color: boolean;
  invert: boolean;
};
const request = jest.fn();
const services = { api: { request } } as unknown as BusinessServices;
const batch = {
  successes: [{ image_id: 'dicomfile:0', study_uid: '1', series_uid: '2', sop_uid: '3' }],
};
const results = { revision: 0, objects: [], access: { owner_uid: 'u', can_edit: true } };
const materials = {
  task: { task_id: 'task', team_id: 't' },
  access: { owner_uid: 'u', can_edit: true },
  source: {
    files: [
      { file_id: 'later', file_name: '第二.dcm', selection_index: 1 },
      {
        file_id: 'first',
        file_name: '首个.dcm',
        selection_index: 0,
        study_uid: '1',
        series_uid: '2',
        sop_uid: '3',
      },
    ],
  },
};
let image: PreviewImage;
let putImageData: jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  image = {
    columns: 2,
    rows: 1,
    getPixelData: () => new Int16Array([-1000, 100]),
    windowCenter: 40,
    windowWidth: 400,
    minPixelValue: -1000,
    maxPixelValue: 100,
    slope: 1,
    intercept: -1024,
    preScale: { enabled: true, scaled: true },
    color: false,
    invert: false,
  };
  putImageData = jest.fn();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData,
  } as unknown as CanvasRenderingContext2D);
  jest
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/png;base64,cHJldmlldw==');
  request.mockReset();
  request
    .mockResolvedValue(results)
    .mockResolvedValueOnce(materials)
    .mockResolvedValueOnce(new Blob(['合成影像']));
  (filesToImportBatch as jest.Mock).mockResolvedValue(batch);
  (releaseImportBatch as jest.Mock).mockReturnValue(true);
  (imageLoader.loadAndCacheImage as jest.Mock).mockImplementation(async () => image);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function renderPreview() {
  const view = render(
    React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' })
  );
  await screen.findByRole('img', { name: '任务来源影像首帧' });
  return view;
}

function renderedPixels() {
  expect(putImageData).toHaveBeenCalledTimes(1);
  return Array.from(putImageData.mock.calls[0][0].data);
}

test('已重标定CT不重复应用负截距，直接输出正确灰度而非全黑', async () => {
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 166, 166, 166, 255]);
  expect(request).toHaveBeenNthCalledWith(2, '/tasks/task/files/first', {
    responseType: 'blob',
    signal: expect.any(AbortSignal),
  });
  expect(releaseImportBatch).toHaveBeenCalledWith(batch);
});

test.each([
  ['显式未启用', { enabled: false, scaled: false }],
  ['启用但尚未重标定', { enabled: true, scaled: false }],
  ['仅有启用标志', { enabled: true }],
  ['缺少状态', undefined],
])('%s时仍应用一次非单位斜率与负截距', async (_name, preScale) => {
  image.preScale = preScale;
  image.slope = 2;
  image.getPixelData = () => new Int16Array([12, 562]);
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 166, 166, 166, 255]);
});

test('已重标定时也不重复应用非单位斜率', async () => {
  image.slope = 2;
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 166, 166, 166, 255]);
});

test('未重标定且缺少斜率截距时默认使用1和0', async () => {
  image.preScale = undefined;
  image.slope = undefined;
  image.intercept = undefined;
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 166, 166, 166, 255]);
});

test('数组窗宽窗位与灰度反转仍生效', async () => {
  image.windowCenter = [40];
  image.windowWidth = [400];
  image.invert = true;
  await renderPreview();
  expect(renderedPixels()).toEqual([255, 255, 255, 255, 89, 89, 89, 255]);
});

test('无窗宽窗位时沿用像素最小最大值', async () => {
  image.windowCenter = undefined;
  image.windowWidth = undefined;
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
});

test('零像素范围使用最小窗宽且不除零', async () => {
  image.windowCenter = undefined;
  image.windowWidth = 0;
  image.minPixelValue = 0;
  image.maxPixelValue = 0;
  image.getPixelData = () => new Int16Array([0, 1]);
  await renderPreview();
  expect(renderedPixels()).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
});

test('彩色像素不应用灰度重标定', async () => {
  image.color = true;
  image.getPixelData = () => new Uint8Array([10, 20, 30, 40, 50, 60]);
  await renderPreview();
  expect(renderedPixels()).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
});

test.each(['request', 'decode', 'emptyBatch'])('%s失败显示占位且不写入Canvas', async failure => {
  if (failure === 'request') {
    request.mockReset().mockRejectedValue(new Error('读取失败'));
  } else if (failure === 'decode') {
    (imageLoader.loadAndCacheImage as jest.Mock).mockRejectedValue(new Error('解码失败'));
  } else {
    (filesToImportBatch as jest.Mock).mockResolvedValue({ successes: [] });
  }
  await act(async () => {
    render(React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' }));
  });
  expect(screen.getByText('影像预览暂不可用')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
  expect(putImageData).not.toHaveBeenCalled();
  if (failure !== 'request') {
    expect(releaseImportBatch).toHaveBeenCalled();
  }
});

test('没有来源文件时保留占位，不下载或解码', async () => {
  request.mockReset().mockResolvedValue({ source: { files: [] } });
  await act(async () => {
    render(React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' }));
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(filesToImportBatch).not.toHaveBeenCalled();
  expect(screen.getByText('影像预览暂不可用')).toBeTruthy();
});

test('没有Canvas上下文时仍释放导入资源', async () => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  render(React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' }));
  await waitFor(() => expect(releaseImportBatch).toHaveBeenCalledWith(batch));
  expect(screen.queryByRole('img')).toBeNull();
});

test.each(['resolve', 'reject'])('卸载取消请求并忽略文件下载晚%s', async settlement => {
  const download = deferred<Blob>();
  request.mockReset().mockResolvedValueOnce(materials).mockReturnValueOnce(download.promise);
  const view = render(
    React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' })
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const signal = request.mock.calls[1][1].signal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    if (settlement === 'resolve') {
      download.resolve(new Blob());
    } else {
      download.reject(new Error('取消后失败'));
    }
  });
  expect(filesToImportBatch).not.toHaveBeenCalled();
  expect(putImageData).not.toHaveBeenCalled();
});

test('卸载后解析完成仍释放本批资源且不启动解码', async () => {
  const parsing = deferred<typeof batch>();
  (filesToImportBatch as jest.Mock).mockReturnValue(parsing.promise);
  const view = render(
    React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' })
  );
  await waitFor(() => expect(filesToImportBatch).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => parsing.resolve(batch));
  expect(releaseImportBatch).toHaveBeenCalledWith(batch);
  expect(imageLoader.loadAndCacheImage).not.toHaveBeenCalled();
});

test('已完成的预览卸载时取消请求并保持资源可幂等释放', async () => {
  const view = await renderPreview();
  view.unmount();
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  expect(releaseImportBatch).toHaveBeenCalledWith(batch);
});

test('预览解码资源使用本次独立imageId强制释放，不清除其他工作台缓存', async () => {
  await renderPreview();
  expect(cache.removeImageLoadObject).toHaveBeenCalledWith('dicomfile:0', { force: true });
  expect(cache.removeImageLoadObject).toHaveBeenCalledTimes(1);
});

test('源文件实际UID与后端索引不符时不得绘制错误切片', async () => {
  (filesToImportBatch as jest.Mock).mockResolvedValue({
    successes: [{ image_id: 'dicomfile:0', study_uid: '1', series_uid: '2', sop_uid: '999' }],
  });
  render(React.createElement(TaskPreview, { taskId: 'task', services, accountUid: 'u' }));
  await screen.findByText('源文件身份与任务索引不匹配');
  expect(imageLoader.loadAndCacheImage).not.toHaveBeenCalled();
  expect(putImageData).not.toHaveBeenCalled();
});

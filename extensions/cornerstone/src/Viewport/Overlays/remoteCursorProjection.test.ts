import type { SharedCursorPosition } from '@ohif/core';
import {
  frameNumberFromZeroBasedIndex,
  projectSharedCursor,
  sampleSharedCursor,
} from './remoteCursorProjection';
import type {
  CursorImageTransformPort,
  StackCursorProjectionContext,
} from './remoteCursorProjection';

const cursor: SharedCursorPosition = {
  selection_index: 2,
  study_uid: '1.2.3',
  series_uid: '1.2.3.4',
  sop_uid: '1.2.3.4.5',
  frame_number: 1,
  coordinate_space: 'image-pixel-center',
  column: 20.25,
  row: 30.5,
  columns: 128,
  rows: 96,
};

const transform: CursorImageTransformPort = {
  imageToCanvas: ({ column, row }) => ({ x: column * 2 + 10, y: row * 3 + 12 }),
  canvasToImage: ({ x, y }) => ({ column: (x - 10) / 2, row: (y - 12) / 3 }),
};

function context(
  overrides: Partial<StackCursorProjectionContext> = {}
): StackCursorProjectionContext {
  return {
    viewportType: 'stack',
    frame: cursor,
    viewportSize: { width: 400, height: 300 },
    transform,
    ...overrides,
  };
}

describe('共享光标纯投影', () => {
  it('从真实变换端口保留原图亚像素中心，发送和接收互逆', () => {
    const point = { x: 50.5, y: 103.5 };
    expect(sampleSharedCursor(point, context())).toEqual(cursor);
    expect(projectSharedCursor(cursor, context())).toEqual(point);
  });

  it('本窗 loader 标识不同不影响稳定文件及帧匹配', () => {
    const localFrame = { ...cursor, image_id: 'dicomfile:987' };
    expect(projectSharedCursor(cursor, context({ frame: localFrame }))).toEqual({
      x: 50.5,
      y: 103.5,
    });
    expect(sampleSharedCursor({ x: 50.5, y: 103.5 }, context({ frame: localFrame }))).toEqual(
      cursor
    );
    expect(
      sampleSharedCursor({ x: 50.5, y: 103.5 }, context({ frame: localFrame }))
    ).not.toHaveProperty('image_id');
  });

  it('旋转与非等比缩放同样消费显式双向变换，不依赖页面百分比', () => {
    const rotated: CursorImageTransformPort = {
      imageToCanvas: ({ column, row }) => ({ x: 200 - row * 2, y: column * 3 + 10 }),
      canvasToImage: ({ x, y }) => ({ column: (y - 10) / 3, row: (200 - x) / 2 }),
    };
    const point = { x: 139, y: 70.75 };
    expect(projectSharedCursor(cursor, context({ transform: rotated }))).toEqual(point);
    expect(sampleSharedCursor(point, context({ transform: rotated }))).toEqual(cursor);
  });

  it('缩放、平移和尺寸变化可以直接重投影同一有效样本', () => {
    const moved: CursorImageTransformPort = {
      imageToCanvas: ({ column, row }) => ({ x: column * 4 - 60, y: row * 2 - 10 }),
      canvasToImage: ({ x, y }) => ({ column: (x + 60) / 4, row: (y + 10) / 2 }),
    };
    expect(projectSharedCursor(cursor, context({ transform: moved }))).toEqual({ x: 21, y: 51 });
    expect(
      projectSharedCursor(cursor, context({ viewportSize: { width: 40, height: 300 } }))
    ).toBeNull();
  });

  it.each([
    ['selection_index', 3],
    ['study_uid', '1.9'],
    ['series_uid', '1.9'],
    ['sop_uid', '1.9'],
    ['frame_number', 2],
    ['columns', 127],
    ['rows', 95],
  ])('当前画面的 %s 不同则隐藏', (key, value) => {
    expect(projectSharedCursor(cursor, context({ frame: { ...cursor, [key]: value } }))).toBeNull();
  });

  it.each([
    ['selection_index', -1],
    ['selection_index', 1.5],
    ['study_uid', ''],
    ['series_uid', '错误 UID'],
    ['sop_uid', '1..2'],
    ['frame_number', 0],
    ['frame_number', 1.5],
    ['columns', 0],
    ['columns', Infinity],
    ['rows', 0.5],
    ['coordinate_space', 'canvas'],
    ['column', NaN],
    ['column', -0.01],
    ['column', 127.01],
    ['row', Infinity],
    ['row', -0.01],
    ['row', 95.01],
  ])('非法 %s=%s 不绘制', (key, value) => {
    expect(projectSharedCursor({ ...cursor, [key]: value }, context())).toBeNull();
  });

  it('包含原图左上与右下像素中心，拒绝原图区域外的画布采样', () => {
    expect(sampleSharedCursor({ x: 10, y: 12 }, context())).toMatchObject({ column: 0, row: 0 });
    expect(sampleSharedCursor({ x: 264, y: 297 }, context())).toMatchObject({
      column: 127,
      row: 95,
    });
    expect(sampleSharedCursor({ x: 9.99, y: 12 }, context())).toBeNull();
    expect(sampleSharedCursor({ x: 264.01, y: 297 }, context())).toBeNull();
  });

  it.each(['volume', 'orthographic', 'microscopy'])('不支持的 %s 视口双向隐藏', viewportType => {
    expect(projectSharedCursor(cursor, context({ viewportType }))).toBeNull();
    expect(sampleSharedCursor({ x: 50, y: 100 }, context({ viewportType }))).toBeNull();
  });

  it.each([
    { frame: null },
    { frame: { ...cursor, rows: -1 } },
    { transform: null },
    { viewportSize: { width: 0, height: 300 } },
    { viewportSize: { width: 400, height: NaN } },
  ])('缺失或无效的当前影像上下文不能采样或绘制：%p', overrides => {
    expect(sampleSharedCursor({ x: 50, y: 100 }, context(overrides))).toBeNull();
    expect(projectSharedCursor(cursor, context(overrides))).toBeNull();
  });

  it.each([
    { x: -1, y: 10 },
    { x: 400, y: 10 },
    { x: 10, y: 300 },
    { x: NaN, y: 10 },
    { x: 10, y: Infinity },
  ])('画布采样超出 CSS 视口或非有限数时隐藏：%p', point => {
    expect(sampleSharedCursor(point, context())).toBeNull();
  });

  it('接收 null 立即隐藏，不保留上次点', () => {
    expect(projectSharedCursor(null, context())).toBeNull();
  });

  it.each([
    { imageToCanvas: () => null, canvasToImage: () => null },
    { imageToCanvas: () => ({ x: NaN, y: 10 }), canvasToImage: () => ({ column: 1, row: 1 }) },
    {
      imageToCanvas: () => ({ x: 10, y: 10 }),
      canvasToImage: () => ({ column: Infinity, row: 1 }),
    },
    { imageToCanvas: () => ({ x: -1, y: 10 }), canvasToImage: transform.canvasToImage },
    { imageToCanvas: () => ({ x: 400, y: 10 }), canvasToImage: transform.canvasToImage },
    { imageToCanvas: () => ({ x: 50, y: 100 }), canvasToImage: () => ({ column: 0, row: 0 }) },
    {
      imageToCanvas: () => {
        throw new Error('影像已释放');
      },
      canvasToImage: transform.canvasToImage,
    },
    {
      imageToCanvas: transform.imageToCanvas,
      canvasToImage: () => {
        throw new Error('变换不可逆');
      },
    },
  ])('无法逆变换、往返不一致或点出画面时拒绝：%p', invalidTransform => {
    expect(projectSharedCursor(cursor, context({ transform: invalidTransform }))).toBeNull();
    expect(
      sampleSharedCursor({ x: 50.5, y: 103.5 }, context({ transform: invalidTransform }))
    ).toBeNull();
  });

  it.each([
    [-1, null],
    [0.5, null],
    [NaN, null],
    [Infinity, null],
    [Number.MAX_SAFE_INTEGER, null],
    [0, 1],
    [4, 5],
  ])('原生零基帧索引 %s 显式归一化为 %s', (index, expected) => {
    expect(frameNumberFromZeroBasedIndex(index)).toBe(expected);
  });
});

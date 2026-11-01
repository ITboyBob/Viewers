import type { SharedCursorPosition } from '@ohif/core';

export type CursorCanvasPoint = Readonly<{ x: number; y: number }>;
export type CursorImagePoint = Readonly<{ column: number; row: number }>;
export type CursorViewportSize = Readonly<{ width: number; height: number }>;
export type SharedCursorFrame = Pick<
  SharedCursorPosition,
  'selection_index' | 'study_uid' | 'series_uid' | 'sop_uid' | 'frame_number' | 'columns' | 'rows'
>;

/** 适配器须使用当前原始帧与 CSS 画布变换，无法逆变换时返回 null。 */
export interface CursorImageTransformPort {
  imageToCanvas(point: CursorImagePoint): CursorCanvasPoint | null;
  canvasToImage(point: CursorCanvasPoint): CursorImagePoint | null;
}

export type StackCursorProjectionContext = Readonly<{
  viewportType: string;
  frame: SharedCursorFrame | null;
  viewportSize: CursorViewportSize;
  transform: CursorImageTransformPort | null;
}>;

export function frameNumberFromZeroBasedIndex(index: number): number | null {
  return Number.isSafeInteger(index) && index >= 0 && index < Number.MAX_SAFE_INTEGER
    ? index + 1
    : null;
}

/** 画布坐标和尺寸均为 CSS 像素；右边界和下边界本身已在视口外。 */
export function isCursorCanvasPointVisible(
  point: CursorCanvasPoint,
  size: CursorViewportSize
): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0 &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < size.width &&
    point.y < size.height
  );
}

function isDicomUid(value: string): boolean {
  return typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(value);
}

function isValidFrame(frame: SharedCursorFrame): boolean {
  return (
    Number.isSafeInteger(frame.selection_index) &&
    frame.selection_index >= 0 &&
    isDicomUid(frame.study_uid) &&
    isDicomUid(frame.series_uid) &&
    isDicomUid(frame.sop_uid) &&
    Number.isSafeInteger(frame.frame_number) &&
    frame.frame_number > 0 &&
    Number.isSafeInteger(frame.columns) &&
    frame.columns > 0 &&
    Number.isSafeInteger(frame.rows) &&
    frame.rows > 0
  );
}

function isImagePointValid(point: CursorImagePoint | null, frame: SharedCursorFrame): boolean {
  return (
    point !== null &&
    Number.isFinite(point.column) &&
    Number.isFinite(point.row) &&
    point.column >= 0 &&
    point.row >= 0 &&
    point.column <= frame.columns - 1 &&
    point.row <= frame.rows - 1
  );
}

type ReadyProjectionContext = StackCursorProjectionContext & {
  frame: SharedCursorFrame;
  transform: CursorImageTransformPort;
};

export function isStackCursorProjectionReady(
  context: StackCursorProjectionContext
): context is ReadyProjectionContext {
  return (
    context.viewportType === 'stack' &&
    context.frame !== null &&
    isValidFrame(context.frame) &&
    context.transform !== null &&
    isCursorCanvasPointVisible({ x: 0, y: 0 }, context.viewportSize)
  );
}

function isSameFrame(cursor: SharedCursorPosition, frame: SharedCursorFrame): boolean {
  return (
    cursor.selection_index === frame.selection_index &&
    cursor.study_uid === frame.study_uid &&
    cursor.series_uid === frame.series_uid &&
    cursor.sop_uid === frame.sop_uid &&
    cursor.frame_number === frame.frame_number &&
    cursor.columns === frame.columns &&
    cursor.rows === frame.rows
  );
}

// 往返容差仅吸收浮点误差，不用于放宽原图边界或替代真实视口精度验收。
const ROUND_TRIP_EPSILON = 0.0001;

export function sampleSharedCursor(
  point: CursorCanvasPoint,
  context: StackCursorProjectionContext
): SharedCursorPosition | null {
  if (
    !isStackCursorProjectionReady(context) ||
    !isCursorCanvasPointVisible(point, context.viewportSize)
  ) {
    return null;
  }

  const { frame, transform } = context;
  try {
    const image = transform.canvasToImage(point);
    if (!isImagePointValid(image, frame)) {
      return null;
    }
    const roundTrip = transform.imageToCanvas(image);
    if (
      !roundTrip ||
      !isCursorCanvasPointVisible(roundTrip, context.viewportSize) ||
      Math.abs(roundTrip.x - point.x) > ROUND_TRIP_EPSILON ||
      Math.abs(roundTrip.y - point.y) > ROUND_TRIP_EPSILON
    ) {
      return null;
    }

    // 逐项构造传输位置，避免把本窗 image_id、dataset 或适配器附加字段带出去。
    return {
      selection_index: frame.selection_index,
      study_uid: frame.study_uid,
      series_uid: frame.series_uid,
      sop_uid: frame.sop_uid,
      frame_number: frame.frame_number,
      coordinate_space: 'image-pixel-center',
      column: image.column,
      row: image.row,
      columns: frame.columns,
      rows: frame.rows,
    };
  } catch {
    return null;
  }
}

export function projectSharedCursor(
  cursor: SharedCursorPosition | null,
  context: StackCursorProjectionContext
): CursorCanvasPoint | null {
  if (
    !cursor ||
    !isStackCursorProjectionReady(context) ||
    cursor.coordinate_space !== 'image-pixel-center' ||
    !isValidFrame(cursor) ||
    !isSameFrame(cursor, context.frame) ||
    !isImagePointValid(cursor, context.frame)
  ) {
    return null;
  }

  try {
    const point = context.transform.imageToCanvas({ column: cursor.column, row: cursor.row });
    if (!point || !isCursorCanvasPointVisible(point, context.viewportSize)) {
      return null;
    }
    const roundTrip = context.transform.canvasToImage(point);
    if (
      !isImagePointValid(roundTrip, context.frame) ||
      Math.abs(roundTrip.column - cursor.column) > ROUND_TRIP_EPSILON ||
      Math.abs(roundTrip.row - cursor.row) > ROUND_TRIP_EPSILON
    ) {
      return null;
    }
    return { x: point.x, y: point.y };
  } catch {
    return null;
  }
}

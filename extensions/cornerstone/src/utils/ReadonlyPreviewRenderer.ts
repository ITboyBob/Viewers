import type { SourceFileSpec } from '@ohif/core';
import type { Types } from '@cornerstonejs/tools';
import normalizeImagePlaneGeometry from '../../../../platform/core/src/utils/normalizeImagePlaneGeometry';

type Point = [number, number, number];
type Color = [number, number, number, number];
export type ReadonlyResultState = {
  annotations: Types.Annotation[];
  measurements: Array<{ uid?: string; label?: string; displayText?: { primary?: string[] } }>;
  presentation?: Record<string, { color: string; lineWidth: number }>;
  segmentations: Array<{
    segmentationId?: string;
    frames: Array<{
      referenceId: string;
      rows: number;
      columns: number;
      pixels: ArrayLike<number>;
    }>;
    colors: Record<number, Color>;
    contour?: unknown;
    geometries?: Array<{
      frameOfReferenceUID: string;
      color: Color;
      segmentIndex?: number;
      data: Array<{ points: Point[]; type?: string; color?: Color }>;
    }>;
  }>;
};
const stable = (file: SourceFileSpec) =>
  `urn:colla:image:${file.study_uid}/${file.series_uid}/${file.sop_uid}`;
const vector = (value: unknown, length: number): number[] => {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(v => !Number.isFinite(Number(v)))
  )
    throw new Error('封面几何数据不完整');
  return value.map(Number);
};
const dot = (a: number[], b: number[]) => a.reduce((n, v, i) => n + v * b[i], 0);
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const first = (value: unknown): Record<string, unknown> =>
  ((Array.isArray(value) ? value[0] : value) as Record<string, unknown>) ?? {};
function plane(dataset: Record<string, unknown>, calibratedSpacing?: unknown) {
  const perFrame = first(dataset.PerFrameFunctionalGroupsSequence),
    shared = first(dataset.SharedFunctionalGroupsSequence);
  const position = first(perFrame.PlanePositionSequence ?? shared.PlanePositionSequence);
  const orientation = first(perFrame.PlaneOrientationSequence ?? shared.PlaneOrientationSequence);
  const measures = first(perFrame.PixelMeasuresSequence ?? shared.PixelMeasuresSequence);
  const normalized = normalizeImagePlaneGeometry(
    {
      ImagePositionPatient: position.ImagePositionPatient ?? dataset.ImagePositionPatient,
      ImageOrientationPatient:
        orientation.ImageOrientationPatient ?? dataset.ImageOrientationPatient,
    },
    measures.PixelSpacing ?? calibratedSpacing ?? dataset.PixelSpacing
  );
  const origin = normalized.position,
    axes = normalized.orientation,
    spacing = normalized.pixelSpacing;
  const row = axes.slice(0, 3),
    column = axes.slice(3),
    normal = cross(row, column);
  // 只允许数值误差；采集层厚不是切片归属窗口，重叠重建不能跨片。
  const tolerance = 1e-3;
  return Object.assign(
    (value: unknown) => {
      const point = vector(value, 3),
        delta = point.map((v, i) => v - origin[i]);
      return {
        point: [dot(delta, row) / spacing[1], dot(delta, column) / spacing[0]],
        onPlane: Math.abs(dot(delta, normal)) < tolerance,
      };
    },
    { pixelSpacing: spacing }
  );
}
function color(value: Color | undefined) {
  const c = value ?? [255, 255, 0, 255];
  if (!Array.isArray(c) || c.length < 3 || c.some(v => !Number.isFinite(v)))
    throw new Error('成果颜色无效');
  return c;
}
/** 只使用传入数据和局部Canvas；不访问annotation/segmentation全局状态或工作台服务。 */
export function renderConfirmedOverlay(
  ctx: CanvasRenderingContext2D,
  image: { rows: number; columns: number },
  dataset: Record<string, unknown>,
  source: SourceFileSpec,
  files: SourceFileSpec[],
  states: ReadonlyResultState[],
  calibratedSpacing?: unknown
) {
  let projectPoint: ReturnType<typeof plane> | undefined;
  const projected = (points: unknown[]) => {
    projectPoint ??= plane(dataset, calibratedSpacing);
    const result = points.map(projectPoint);
    return result.every(p => p.onPlane) ? result.map(p => p.point) : null;
  };
  const matches = (reference: string) => {
    if (typeof reference !== 'string') throw new Error('成果缺少稳定切片引用');
    const match = files.find(
      file => reference === stable(file) || reference.startsWith(stable(file) + '&frame=')
    );
    if (
      !match ||
      (reference.includes('&frame=') && !/^[1-9]\d*$/.test(reference.split('&frame=')[1]))
    )
      throw new Error('成果引用不属于该任务');
    return (
      stable(match) === stable(source) &&
      (!reference.includes('&frame=') || reference.endsWith('&frame=1'))
    );
  };
  const path = (points: number[][], closed = false) => {
    if (!points.length) throw new Error('成果图形缺少坐标');
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const p of points.slice(1)) ctx.lineTo(p[0], p[1]);
    if (closed) ctx.closePath();
    ctx.stroke();
  };
  for (const state of states) {
    if (
      !Array.isArray(state?.annotations) ||
      !Array.isArray(state.measurements) ||
      !Array.isArray(state.segmentations)
    )
      throw new Error('成果结构不完整');
    for (const mask of state.segmentations) {
      if (!Array.isArray(mask.frames)) throw new Error('分割成果结构不完整');
      for (const frame of mask.frames) {
        if (!matches(frame.referenceId)) continue;
        if (
          frame.rows !== image.rows ||
          frame.columns !== image.columns ||
          frame.pixels?.length !== image.rows * image.columns
        )
          throw new Error('分割成果尺寸不匹配');
        const output = ctx.getImageData(0, 0, image.columns, image.rows);
        for (let i = 0; i < frame.pixels.length; i++) {
          const index = frame.pixels[i];
          if (!index) continue;
          const c = color(mask.colors?.[index]),
            alpha = (0.45 * (c[3] ?? 255)) / 255;
          for (let channel = 0; channel < 3; channel++)
            output.data[i * 4 + channel] =
              output.data[i * 4 + channel] * (1 - alpha) + c[channel] * alpha;
        }
        ctx.putImageData(output, 0, 0);
      }
      if (mask.contour && !Array.isArray(mask.geometries)) throw new Error('轮廓成果缺少几何');
      const hydrated = state.annotations.some(
        item =>
          (item.data.segmentation as { segmentationId?: string })?.segmentationId ===
            mask.segmentationId && !!mask.segmentationId
      );
      for (const geometry of hydrated ? [] : (mask.geometries ?? [])) {
        if (!geometry.frameOfReferenceUID) throw new Error('轮廓缺少参考坐标系');
        if (geometry.frameOfReferenceUID !== dataset.FrameOfReferenceUID) continue;
        for (const contour of geometry.data) {
          const points = projected(contour.points);
          if (!points) continue;
          const c = color(mask.colors?.[geometry.segmentIndex!] ?? contour.color ?? geometry.color);
          ctx.strokeStyle = `rgb(${c.slice(0, 3).join(',')})`;
          ctx.lineWidth = 1;
          path(points, contour.type !== 'OPEN_PLANAR');
        }
      }
    }
    for (const item of state.annotations) {
      if (!matches(item.metadata?.referencedImageId)) continue;
      const tool = item.metadata?.toolName;
      const raw = item.data?.contour?.polyline ?? item.data?.handles?.points;
      if (!Array.isArray(raw) || !raw.length) throw new Error('批注图形缺少坐标');
      const points = projected(raw);
      if (!points) continue;
      const style = state.presentation?.[item.annotationUID!];
      const binding = item.data.segmentation as
        | { segmentationId?: string; segmentIndex?: number; color?: Color }
        | undefined;
      const mask =
        binding && state.segmentations.find(mask => mask.segmentationId === binding.segmentationId);
      const segmentColor =
        mask?.colors?.[binding?.segmentIndex!] ??
        mask?.geometries?.find(geometry => geometry.segmentIndex === binding?.segmentIndex)
          ?.color ??
        binding?.color;
      ctx.strokeStyle = segmentColor
        ? `rgb(${color(segmentColor).slice(0, 3).join(',')})`
        : (style?.color ?? 'rgb(255,255,0)');
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = style?.lineWidth ?? 1;
      switch (tool) {
        case 'CircleROI': {
          if (points.length < 2) throw new Error('圆形成果不完整');
          const a = vector(raw[0], 3),
            b = vector(raw[1], 3);
          const radius = Math.hypot(...a.map((n, i) => n - b[i]));
          const spacing = projectPoint!.pixelSpacing;
          ctx.beginPath();
          ctx.ellipse(
            points[0][0],
            points[0][1],
            radius / spacing[1],
            radius / spacing[0],
            0,
            0,
            2 * Math.PI
          );
          ctx.stroke();
          break;
        }
        case 'EllipticalROI': {
          if (points.length !== 4) throw new Error('椭圆成果不完整');
          const cx = points.reduce((v, p) => v + p[0], 0) / 4,
            cy = points.reduce((v, p) => v + p[1], 0) / 4;
          // 原生椭圆四点依次为上、下、左、右；保留轴方向。
          const a = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) / 2;
          const b = Math.hypot(points[3][0] - points[2][0], points[3][1] - points[2][1]) / 2;
          ctx.beginPath();
          ctx.ellipse(
            cx,
            cy,
            b,
            a,
            Math.atan2(points[3][1] - points[2][1], points[3][0] - points[2][0]),
            0,
            2 * Math.PI
          );
          ctx.stroke();
          break;
        }
        case 'RectangleROI':
          if (points.length !== 4) throw new Error('矩形成果不完整');
          path([points[0], points[1], points[3], points[2]], true);
          break;
        case 'Bidirectional':
        case 'SegmentBidirectional':
        case 'CobbAngle':
          if (points.length !== 4) throw new Error('双线成果不完整');
          path(points.slice(0, 2));
          path(points.slice(2, 4));
          break;
        case 'ArrowAnnotate': {
          path(points);
          if (points.length < 2) throw new Error('箭头成果不完整');
          const [a, b] = points,
            angle = Math.atan2(b[1] - a[1], b[0] - a[0]),
            size = Math.max(3, image.columns / 70);
          path([
            [a[0] + Math.cos(angle - 0.5) * size, a[1] + Math.sin(angle - 0.5) * size],
            a,
            [a[0] + Math.cos(angle + 0.5) * size, a[1] + Math.sin(angle + 0.5) * size],
          ]);
          break;
        }
        case 'Probe':
        case 'SCOORD3DPoint':
          ctx.beginPath();
          ctx.arc(points[0][0], points[0][1], 2, 0, 2 * Math.PI);
          ctx.stroke();
          break;
        case 'Length':
        case 'Angle':
        case 'UltrasoundDirectional':
        case 'UltrasoundDirectionalTool':
        case 'UltrasoundPleuraBLine':
        case 'UltrasoundPleuraBLineTool':
          path(points);
          break;
        case 'PlanarFreehandROI':
        case 'SplineROI':
        case 'LivewireContour':
        case 'PlanarFreehandContourSegmentationTool':
        case 'PlanarFreehandContourSegmentation':
        case 'SplineContourSegmentation':
        case 'LivewireContourSegmentation':
          path(points, item.data.contour?.closed ?? false);
          break;
        default:
          throw new Error(`暂不支持该成果图形：${tool}`);
      }
      const measure = state.measurements.find(m => m.uid === item.annotationUID);
      const text =
        measure?.displayText?.primary?.join(' ') ||
        (typeof item.data.text === 'string' ? item.data.text : '') ||
        measure?.label;
      if (text) {
        ctx.font = `${Math.max(10, image.columns / 45)}px sans-serif`;
        ctx.fillText(
          text,
          Math.min(image.columns - 1, points[0][0] + 4),
          Math.max(10, points[0][1] - 4)
        );
      }
    }
  }
}

export type MaskRoi = { seriesInstanceUID: string; axes: number[][]; min: number[]; max: number[] };
export const maskRoiSettings = new Map<string, MaskRoi>();
export const dot = (a: readonly number[], b: readonly number[]) =>
  a.reduce((sum, v, i) => sum + v * b[i], 0);
export function validateRoi(roi: MaskRoi) {
  if (
    !roi ||
    typeof roi.seriesInstanceUID !== 'string' ||
    !roi.seriesInstanceUID ||
    roi.axes?.length !== 3 ||
    roi.min?.length !== 3 ||
    roi.max?.length !== 3 ||
    ![...roi.min, ...roi.max].every(Number.isFinite) ||
    roi.min.some((v, i) => v > roi.max[i]) ||
    roi.axes.some(
      axis =>
        axis.length !== 3 ||
        !axis.every(Number.isFinite) ||
        Math.abs(Math.hypot(...axis) - 1) > 0.0001
    ) ||
    Math.abs(dot(roi.axes[0], roi.axes[1])) > 0.0001 ||
    Math.abs(dot(roi.axes[0], roi.axes[2])) > 0.0001 ||
    Math.abs(dot(roi.axes[1], roi.axes[2])) > 0.0001
  )
    throw new Error('ROI 范围或空间方向无效，请重新框选。');
}
export function roiContains(roi: MaskRoi, world: readonly number[]) {
  return roi.axes.every((axis, i) => {
    const value = dot(axis, world);
    return value >= roi.min[i] - 0.0001 && value <= roi.max[i] + 0.0001;
  });
}
/** A patient-space oriented box handles oblique acquisition and unequal pixel spacing. */
export function roiSelection(
  roi: MaskRoi,
  width: number,
  height: number,
  origin: readonly number[],
  stepX: readonly number[],
  stepY: readonly number[]
) {
  validateRoi(roi);
  const base = roi.axes.map(axis => dot(axis, origin));
  const dx = roi.axes.map(axis => dot(axis, stepX));
  const dy = roi.axes.map(axis => dot(axis, stepY));
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (
        base.every(
          (v, i) =>
            v + dx[i] * x + dy[i] * y >= roi.min[i] - 0.0001 &&
            v + dx[i] * x + dy[i] * y <= roi.max[i] + 0.0001
        )
      )
        result[y * width + x] = 1;
    }
  return result;
}
export function validateRoiInstance(roi: MaskRoi, instance) {
  validateRoi(roi);
  const o = instance?.ImageOrientationPatient?.map(Number),
    spacing = instance?.PixelSpacing?.map(Number);
  const origin = instance?.ImagePositionPatient?.map(Number);
  if (
    instance?.SeriesInstanceUID !== roi.seriesInstanceUID ||
    o?.length !== 6 ||
    spacing?.length !== 2 ||
    !Number.isInteger(Number(instance?.Columns)) ||
    Number(instance.Columns) < 1 ||
    !Number.isInteger(Number(instance?.Rows)) ||
    Number(instance.Rows) < 1 ||
    origin?.length !== 3 ||
    ![...o, ...spacing, ...origin].every(Number.isFinite) ||
    spacing.some(v => v <= 0)
  )
    throw new Error('ROI 与当前序列不匹配或空间信息不完整，未修改选区。');
  return {
    origin,
    stepX: o.slice(0, 3).map(v => v * spacing[1]),
    stepY: o.slice(3).map(v => v * spacing[0]),
  };
}
export function roiSelectionForInstance(roi: MaskRoi, instance) {
  const { origin, stepX, stepY } = validateRoiInstance(roi, instance);
  return roiSelection(roi, Number(instance.Columns), Number(instance.Rows), origin, stepX, stepY);
}
/** Intersection of the 3D box with an arbitrary slice plane, for the visual outline. */
export function roiPlanePolygon(roi: MaskRoi, point: number[], normal: number[]): number[][] {
  const corners = Array.from({ length: 8 }, (_, code) =>
    [0, 1, 2].map(k =>
      roi.axes.reduce(
        (sum, axis, i) => sum + axis[k] * ((code >> i) & 1 ? roi.max[i] : roi.min[i]),
        0
      )
    )
  );
  const intersections: number[][] = [];
  for (let code = 0; code < 8; code++)
    for (let axis = 0; axis < 3; axis++) {
      const next = code ^ (1 << axis);
      if (next < code) continue;
      const a = corners[code],
        b = corners[next];
      const da = dot(normal, a) - dot(normal, point),
        db = dot(normal, b) - dot(normal, point);
      if (Math.abs(da) < 0.0001) intersections.push(a);
      if (da * db < 0) intersections.push(a.map((v, i) => v + ((b[i] - v) * da) / (da - db)));
    }
  return intersections.filter(
    (a, i) => intersections.findIndex(b => a.every((v, k) => Math.abs(v - b[k]) < 0.0001)) === i
  );
}

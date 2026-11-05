/** 工作台与离屏预览共用的纯几何归一化；不注册或修改任何全局元数据。 */
function numbers(value: unknown, fallback: number[], size: number): number[] {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView)))
    throw new Error('影像几何数据不完整');
  const result = Array.from(value as ArrayLike<unknown>, Number);
  if (result.length !== size || result.some(n => !Number.isFinite(n)))
    throw new Error('影像几何数据不完整');
  return result;
}
export default function normalizeImagePlaneGeometry(
  instance: { ImagePositionPatient?: unknown; ImageOrientationPatient?: unknown },
  pixelSpacing?: unknown
) {
  const position = numbers(instance.ImagePositionPatient, [0, 0, 0], 3);
  const orientation = numbers(instance.ImageOrientationPatient, [1, 0, 0, 0, 1, 0], 6);
  const spacing = numbers(pixelSpacing, [1, 1], 2);
  if (spacing.some(n => n <= 0)) throw new Error('影像像素间距无效');
  return {
    position,
    orientation,
    rowCosines: orientation.slice(0, 3),
    columnCosines: orientation.slice(3),
    pixelSpacing: spacing,
  };
}

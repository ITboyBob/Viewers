import { cache, imageLoader, metaData } from '@cornerstonejs/core';
import { segmentation } from '@cornerstonejs/tools';

/** Snapshot accepted label values before loading source images; never export a windowed screenshot. */
export default async function prepareSegmentationExport(segmentationId: string) {
  const current = segmentation.state.getSegmentation(segmentationId);
  const labelmap = current?.representationData.Labelmap as
    | { imageIds?: string[]; volumeId?: string; referencedImageIds?: string[] }
    | undefined;
  if (!labelmap) throw new Error('请先选择一个包含 Mask 的标注集。');
  // The 4.5.13 runtime also resolves image IDs for volume-backed labelmaps.
  const imageIds: unknown = segmentation.getLabelmapImageIds(segmentationId);
  if (!Array.isArray(imageIds) || !imageIds.length)
    throw new Error('Mask 数据尚未就绪，无法导出。');
  const volume = labelmap.volumeId ? cache.getVolume(labelmap.volumeId) : undefined;
  const usedSegments = new Set<number>();
  const frames = imageIds.map((id: string, index: number) => {
    const image = cache.getImage(id);
    const referenceId =
      image?.referencedImageId ||
      labelmap.referencedImageIds?.[index] ||
      volume?.referencedImageIds?.[index];
    if (!image || !referenceId) throw new Error('找不到 Mask 对应的原始切片，未生成导出文件。');
    const values = image.getPixelData();
    if (values.length !== image.rows * image.columns)
      throw new Error('Mask 的像素数量与切片尺寸不一致，无法导出。');
    const pixelData =
      values instanceof Uint8Array || values instanceof Uint8ClampedArray
        ? new Uint8Array(values.length)
        : new Uint16Array(values.length);
    const onFrame = new Set<number>();
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isInteger(value) || value < 0 || value > 65535)
        throw new Error('Mask 中存在无效标签值，无法导出。');
      if (value === 255) throw new Error('存在未提交的笔刷预览，请先确认或取消预览后再导出。');
      if (value && !current.segments[value])
        throw new Error(`Mask 编号 ${value} 缺少图层信息，无法导出。`);
      pixelData[i] = value;
      if (value) {
        usedSegments.add(value);
        onFrame.add(value);
      }
    }
    return {
      referenceId,
      labelmap: {
        pixelData,
        rows: image.rows,
        columns: image.columns,
        segmentsOnLabelmap: [...onFrame],
      },
    };
  });
  if (!usedSegments.size) throw new Error('当前标注集没有选区，请先完成标注后再导出。');

  const referencedImages = new Array<ReturnType<typeof cache.getImage>>(frames.length);
  let next = 0;
  const loaded = await Promise.allSettled(
    Array.from({ length: Math.min(4, frames.length) }, async () => {
      while (next < frames.length) {
        const index = next++;
        const frame = frames[index];
        const image =
          cache.getImage(frame.referenceId) ||
          (await imageLoader.loadAndCacheImage(frame.referenceId));
        if (
          !image ||
          image.color ||
          image.rows !== frame.labelmap.rows ||
          image.columns !== frame.labelmap.columns
        )
          throw new Error('原始影像未就绪或与 Mask 尺寸不一致，未生成导出文件。');
        referencedImages[index] = image;
      }
    })
  );
  const failed = loaded.find(item => item.status === 'rejected');
  if (failed?.status === 'rejected')
    throw new Error('原始切片加载失败，请确认影像仍可访问后重试。', { cause: failed.reason });
  if (!segmentation.state.getSegmentation(segmentationId))
    throw new Error('标注集已被删除，导出已取消。');
  const ordered = frames.map((frame, index) => ({
    frame,
    image: referencedImages[index],
    instance: metaData.get('instance', frame.referenceId),
  }));
  const reference = ordered[0].instance;
  if (
    !reference?.StudyInstanceUID ||
    !reference?.SeriesInstanceUID ||
    !reference?.FrameOfReferenceUID
  )
    throw new Error('原始影像的检查、序列或空间标识不完整，无法导出。');
  const orientation = reference?.ImageOrientationPatient?.map(Number);
  if (!orientation || orientation.length !== 6 || !orientation.every(Number.isFinite))
    throw new Error('原始切片方向信息不完整，无法可靠导出 DICOM SEG。');
  const normal = [
    orientation[1] * orientation[5] - orientation[2] * orientation[4],
    orientation[2] * orientation[3] - orientation[0] * orientation[5],
    orientation[0] * orientation[4] - orientation[1] * orientation[3],
  ];
  if (
    Math.abs(Math.hypot(...normal) - 1) > 0.0001 ||
    Math.abs(Math.hypot(...orientation.slice(0, 3)) - 1) > 0.0001 ||
    Math.abs(Math.hypot(...orientation.slice(3)) - 1) > 0.0001
  )
    throw new Error('原始切片方向无效，无法导出。');
  for (const item of ordered) {
    const instance = item.instance;
    if (!instance?.SOPInstanceUID && !instance?.SopInstanceUID)
      throw new Error('原始切片缺少 SOP Instance UID，无法可靠导出。');
    if (Number(instance?.NumberOfFrames || 1) > 1)
      throw new Error('当前导出暂不支持增强多帧影像，请使用静态单帧序列。');
    if (
      instance?.StudyInstanceUID !== reference.StudyInstanceUID ||
      instance?.SeriesInstanceUID !== reference.SeriesInstanceUID ||
      instance?.FrameOfReferenceUID !== reference.FrameOfReferenceUID ||
      instance?.ImageOrientationPatient?.length !== 6 ||
      instance.ImageOrientationPatient.some(
        (value, index) =>
          !Number.isFinite(Number(value)) || Math.abs(Number(value) - orientation[index]) > 0.0001
      ) ||
      instance?.ImagePositionPatient?.length !== 3 ||
      !instance.ImagePositionPatient.every(value => Number.isFinite(Number(value)))
    )
      throw new Error('源切片的序列或空间信息不一致，无法可靠导出。');
  }
  // dcmjs normalizes source images in descending scan-axis order. Move labels with their source,
  // otherwise a volume's ascending image order silently attaches mask pixels to the wrong SOP UID.
  const distance = item =>
    item.instance.ImagePositionPatient.reduce(
      (sum, value, index) => sum + Number(value) * normal[index],
      0
    );
  ordered.sort((a, b) => distance(b) - distance(a));
  for (let index = 1; index < ordered.length; index++)
    if (Math.abs(distance(ordered[index - 1]) - distance(ordered[index])) < 0.0001)
      throw new Error('原始切片存在重复空间位置，无法可靠导出。');
  return {
    referencedImages: ordered.map(item => item.image),
    labelmaps2D: ordered.map(item => item.frame.labelmap),
    segmentsOnLabelmap: [...usedSegments].sort((a, b) => a - b),
  };
}

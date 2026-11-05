import type { ReadonlyPreviewInput, ReadonlyPreviewResult, TaskMaterials } from '@ohif/core';
import { decodeResultState } from '../../../../../extensions/cornerstone/src/utils/TaskResultCodec';
import {
  renderConfirmedOverlay,
  ReadonlyResultState,
} from '../../../../../extensions/cornerstone/src/utils/ReadonlyPreviewRenderer';

/** 局部解码和Canvas组合，不创建原生标注或分割表示。 */
export async function composeReadonlyPreview(
  input: ReadonlyPreviewInput,
  materials: TaskMaterials,
  signal: AbortSignal
): Promise<ReadonlyPreviewResult> {
  const parser = await import('../Local/filesToImportBatch');
  const file = materials.source.files.find(file => file.file_id === input.source_file_id)!;
  const batch = await parser.default({
    files: [new File([input.sourceBlob], file.file_name, { type: 'application/dicom' })],
    kind: 'files',
  });
  let imageId: string | undefined;
  let removeImage: (() => void) | undefined;
  try {
    if (signal.aborted) throw new Error('预览读取已取消');
    const source = batch.successes[0];
    if (
      source &&
      (source.study_uid !== input.study_uid ||
        source.series_uid !== input.series_uid ||
        source.sop_uid !== input.sop_uid)
    )
      throw new Error('源文件身份与任务索引不匹配');
    imageId = source?.image_id;
    if (!imageId) throw new Error('无可用封面');
    const native = await import('@cornerstonejs/core');
    removeImage = () => {
      if (imageId && native.cache?.getImageLoadObject?.(imageId))
        native.cache.removeImageLoadObject(imageId, { force: true });
    };
    const image = await native.imageLoader.loadAndCacheImage(imageId);
    if (signal.aborted) throw new Error('预览读取已取消');
    const states: ReadonlyResultState[] = [];
    for (const object of input.objects) {
      const state = (await decodeResultState(input.task_id, object)) as ReadonlyResultState & {
        taskId: string;
      };
      if (state.taskId !== input.task_id) throw new Error('成果快照任务身份不匹配');
      states.push(state);
    }
    if (signal.aborted) throw new Error('预览读取已取消');
    const pixels = image.getPixelData(),
      canvas = document.createElement('canvas');
    canvas.width = image.columns;
    canvas.height = image.rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('封面画布不可用');
    const output = ctx.createImageData(canvas.width, canvas.height);
    // 解码器已完成重标定时，不能再次应用斜率和截距。
    const scaled = image.preScale?.scaled === true;
    const slope = scaled ? 1 : (image.slope ?? 1);
    const intercept = scaled ? 0 : (image.intercept ?? 0);
    const center = Number(
        Array.isArray(image.windowCenter) ? image.windowCenter[0] : image.windowCenter
      ),
      width =
        Number(Array.isArray(image.windowWidth) ? image.windowWidth[0] : image.windowWidth) ||
        Number(image.maxPixelValue - image.minPixelValue) ||
        1;
    const low = Number.isFinite(center) ? center - width / 2 : Number(image.minPixelValue) || 0;
    for (let i = 0; i < canvas.width * canvas.height; i++) {
      if (image.color) {
        const stride = pixels.length / (canvas.width * canvas.height);
        output.data[i * 4] = pixels[i * stride];
        output.data[i * 4 + 1] = pixels[i * stride + 1];
        output.data[i * 4 + 2] = pixels[i * stride + 2];
      } else {
        let value = Math.max(
          0,
          Math.min(255, ((pixels[i] * slope + intercept - low) / width) * 255)
        );
        if (image.invert) {
          value = 255 - value;
        }
        output.data.fill(value, i * 4, i * 4 + 3);
      }
      output.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(output, 0, 0);

    renderConfirmedOverlay(
      ctx,
      image,
      batch.successes[0].dataset ?? {},
      file,
      materials.source.files,
      states,
      native.utilities?.getPixelSpacingInformation?.(batch.successes[0].dataset ?? {})?.PixelSpacing
    );
    return {
      task_id: input.task_id,
      source_file_id: input.source_file_id,
      frame_index: input.frame_index,
      revision: input.revision,
      render_rule_version: input.render_rule_version,
      image: canvas.toDataURL('image/png'),
      status: 'ready',
    };
  } finally {
    // imageId仅来自本调用新分配的fileManager索引，从未加入任何volume。
    // DICOM加载器也会为单帧设置sharedCacheKey，需强制释放该局部图像。
    try {
      removeImage?.();
    } finally {
      parser.releaseImportBatch(batch);
    }
  }
}

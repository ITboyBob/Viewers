import React, { useEffect, useState } from 'react';
import type { BusinessServices, TaskMaterials } from '@ohif/core';

/** 单一来源文件首帧预览；独立释放本组件建立的原生文件资源。 */
export default function TaskPreview({
  taskId,
  services,
}: {
  taskId: string;
  services: BusinessServices;
}) {
  const [source, setSource] = useState('');
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const load = async () => {
      const materials = await services.api.request<TaskMaterials>(
        `/tasks/${encodeURIComponent(taskId)}/materials`,
        { signal: controller.signal }
      );
      const file = [...materials.source.files].sort(
        (a, b) => a.selection_index - b.selection_index
      )[0];
      if (!file) {
        return;
      }
      const blob = await services.api.request<Blob>(
        `/tasks/${encodeURIComponent(taskId)}/files/${file.file_id}`,
        { responseType: 'blob', signal: controller.signal }
      );
      if (!alive) {
        return;
      }
      const parser = await import('../Local/filesToImportBatch');
      const batch = await parser.default({
        files: [new File([blob], file.file_name, { type: 'application/dicom' })],
        kind: 'files',
      });
      release = () => parser.releaseImportBatch(batch);
      if (!alive) {
        release();
        return;
      }
      const imageId = batch.successes[0]?.image_id;
      if (!imageId) {
        throw new Error('无可用封面');
      }
      const { imageLoader } = await import('@cornerstonejs/core');
      const image = await imageLoader.loadAndCacheImage(imageId);
      const pixels = image.getPixelData(),
        canvas = document.createElement('canvas');
      canvas.width = image.columns;
      canvas.height = image.rows;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      const output = ctx.createImageData(canvas.width, canvas.height);
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
            Math.min(
              255,
              ((pixels[i] * (image.slope ?? 1) + (image.intercept ?? 0) - low) / width) * 255
            )
          );
          if (image.invert) {
            value = 255 - value;
          }
          output.data.fill(value, i * 4, i * 4 + 3);
        }
        output.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(output, 0, 0);
      if (alive) {
        setSource(canvas.toDataURL('image/png'));
      }
    };
    void load()
      .catch(() => {
        if (alive) {
          setSource('');
        }
      })
      .finally(() => release?.());
    return () => {
      alive = false;
      controller.abort();
      release?.();
    };
  }, [taskId, services]);
  return source ? (
    <img
      src={source}
      alt="任务来源影像首帧"
    />
  ) : (
    <span>影像预览暂不可用</span>
  );
}

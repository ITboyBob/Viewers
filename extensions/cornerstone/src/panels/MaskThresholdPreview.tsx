import React, { useEffect, useState } from 'react';
import { StackViewport, VolumeViewport, cache, metaData, Enums } from '@cornerstonejs/core';
import { segmentation, utilities as toolUtilities } from '@cornerstonejs/tools';
import { dot, roiContains, roiPlanePolygon } from '../utils/maskEditing/maskRoi';
import { maskDraftPauseReasons } from '../utils/maskEditing/maskProgress';

/** Read-only screen overlay: never writes labelmap pixels, metadata or undo history. */
export default function MaskThresholdPreview({
  servicesManager,
  viewportId,
  displaySetId,
  lower,
  upper,
  replace,
  enabled,
  preview,
  setPreview,
  roi,
  setRoi,
  busy,
}) {
  const { cornerstoneViewportService, segmentationService, displaySetService } =
    servicesManager.services;
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState('');
  const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
  const imageIds =
    (displaySetId && displaySetService.getDisplaySetByUID(displaySetId)?.imageIds) || [];
  const first = imageIds.length && metaData.get('instance', imageIds[0]);
  const orientation = first?.ImageOrientationPatient?.map(Number);
  const axes =
    orientation?.length === 6
      ? [
          orientation.slice(0, 3),
          orientation.slice(3),
          [
            orientation[1] * orientation[5] - orientation[2] * orientation[4],
            orientation[2] * orientation[3] - orientation[0] * orientation[5],
            orientation[0] * orientation[4] - orientation[1] * orientation[3],
          ],
        ]
      : undefined;
  const positions =
    axes &&
    imageIds
      .map(id =>
        dot(axes[2], metaData.get('instance', id)?.ImagePositionPatient?.map(Number) || [NaN])
      )
      .sort((a, b) => a - b);
  const firstLayer =
    roi && positions ? positions.findIndex(value => value >= roi.min[2] - 0.0001) + 1 : 1;
  const lastLayer =
    roi && positions
      ? positions.filter(value => value <= roi.max[2] + 0.0001).length
      : imageIds.length;

  useEffect(() => {
    setDrawing(false);
    setError('');
  }, [viewportId, displaySetId, busy]);
  useEffect(() => {
    if (drawing) maskDraftPauseReasons.add('roi');
    return () => {
      maskDraftPauseReasons.delete('roi');
    };
  }, [drawing]);
  useEffect(() => {
    if (
      busy ||
      !(viewport instanceof StackViewport || viewport instanceof VolumeViewport) ||
      (!preview && !roi && !drawing)
    )
      return;
    const canvas = document.createElement('canvas');
    canvas.dataset.maskThresholdPreview = 'true';
    if (roi) canvas.dataset.maskRoi = JSON.stringify(roi);
    canvas.setAttribute('aria-label', '阈值预览与 ROI');
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: drawing ? 'auto' : 'none',
      cursor: drawing ? 'crosshair' : 'default',
      zIndex: '8',
    });
    viewport.element.appendChild(canvas);
    let raf = 0,
      stopped = false,
      start: [number, number];
    const ctx = canvas.getContext('2d');
    function render() {
      if (stopped) return;
      try {
        const rect = viewport.element.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width)),
          height = Math.max(1, Math.round(rect.height));
        // Limit read-only screen sampling; accepted thresholding still visits every source voxel.
        const scale = Math.min(1, 384 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (
          preview &&
          enabled &&
          Number.isFinite(lower) &&
          Number.isFinite(upper) &&
          lower <= upper
        ) {
          const active = segmentationService.getActiveSegmentation(viewportId);
          const segment = segmentationService.getActiveSegment(viewportId);
          if (!active || !segment) return;
          const imageData = viewport.getImageData();
          if (!imageData?.imageData) return;
          const dimensions = imageData.dimensions;
          let getValue: (index: number) => number, getLabel: (index: number) => number;
          if (viewport instanceof StackViewport) {
            const sourceId = viewport.getCurrentImageId(),
              source = cache.getImage(sourceId);
            const labelIds: unknown = segmentation.getLabelmapImageIds(active.segmentationId);
            const label =
              Array.isArray(labelIds) &&
              labelIds
                .map(id => cache.getImage(id))
                .find(image => image?.referencedImageId === sourceId);
            if (!source || source.color || !label)
              throw new Error('当前切片数据尚未就绪，暂不能预览。');
            const raw = source.getPixelData(),
              labels = label.getPixelData();
            getValue = index =>
              source.isPreScaled || source.preScale?.scaled
                ? raw[index]
                : raw[index] * (source.slope ?? 1) + (source.intercept ?? 0);
            getLabel = index => labels[index];
          } else {
            const source = cache.getVolume(viewport.getVolumeId());
            const data = active.representationData.Labelmap;
            const label = data.volumeId
              ? cache.getVolume(data.volumeId)
              : toolUtilities.segmentation.getOrCreateSegmentationVolume(active.segmentationId);
            if (!source?.voxelManager || !label?.voxelManager)
              throw new Error('体数据尚未就绪，暂不能预览。');
            for (const key of ['dimensions', 'origin', 'spacing', 'direction'])
              if (source[key].some((v, i) => Math.abs(v - label[key][i]) > 0.0001))
                throw new Error('Mask 与当前影像空间不匹配。');
            getValue = index => {
              const image = cache.getImage(
                source.imageIds[Math.floor(index / (dimensions[0] * dimensions[1]))]
              );
              if (!image || image.color) return NaN;
              const raw = source.voxelManager.getAtIndex(index);
              if (typeof raw !== 'number') return NaN;
              return image.isPreScaled || image.preScale?.scaled
                ? raw
                : raw * (image.slope ?? 1) + (image.intercept ?? 0);
            };
            getLabel = index => {
              const value = label.voxelManager.getAtIndex(index);
              return typeof value === 'number' ? value : NaN;
            };
          }
          const sx = width / canvas.width,
            sy = height / canvas.height;
          const world = [
            [sx / 2, sy / 2],
            [sx * 1.5, sy / 2],
            [sx / 2, sy * 1.5],
          ].map(p => viewport.canvasToWorld(p));
          // Cornerstone's transformWorldToIndex rounds; screen sampling needs continuous increments.
          const origin = imageData.imageData.worldToIndex(world[0]);
          const dx = imageData.imageData.worldToIndex(world[1]).map((v, i) => v - origin[i]);
          const dy = imageData.imageData.worldToIndex(world[2]).map((v, i) => v - origin[i]);
          const output = ctx.createImageData(canvas.width, canvas.height);
          let candidates = 0;
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const point = origin.map((v, i) => Math.round(v + dx[i] * x + dy[i] * y));
              if (point.some((v, i) => v < 0 || v >= dimensions[i])) continue;
              const index = point[0] + dimensions[0] * (point[1] + dimensions[1] * point[2]);
              const label = getLabel(index);
              if (label !== 0 && label !== segment.segmentIndex) continue;
              if (
                roi &&
                !roiContains(
                  roi,
                  [0, 1, 2].map(
                    k =>
                      imageData.origin[k] +
                      point.reduce(
                        (sum, v, i) =>
                          sum + v * imageData.spacing[i] * imageData.direction[i * 3 + k],
                        0
                      )
                  )
                )
              )
                continue;
              const value = getValue(index);
              const selected = Number.isFinite(value) && value >= lower && value <= upper;
              // Cyan marks removals in replace mode, yellow marks the candidate selection.
              if (!selected && !(replace && label === segment.segmentIndex)) continue;
              const offset = (y * canvas.width + x) * 4;
              output.data.set(selected ? [255, 220, 0, 145] : [0, 220, 255, 160], offset);
              if (selected) candidates++;
            }
          canvas.dataset.candidates = String(candidates);
          ctx.putImageData(output, 0, 0);
        }
        if (roi) {
          const camera = viewport.getCamera();
          const points = roiPlanePolygon(
            roi,
            [...camera.focalPoint],
            [...camera.viewPlaneNormal]
          ).map(p => viewport.worldToCanvas(p).map(v => v * scale));
          if (points.length >= 3) {
            const center = points.reduce(
              (sum, p) => [sum[0] + p[0] / points.length, sum[1] + p[1] / points.length],
              [0, 0]
            );
            points.sort(
              (a, b) =>
                Math.atan2(a[1] - center[1], a[0] - center[0]) -
                Math.atan2(b[1] - center[1], b[0] - center[0])
            );
            ctx.beginPath();
            points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
            ctx.closePath();
            ctx.strokeStyle = '#ffe000';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.stroke();
          }
        }
        setError('');
      } catch (error) {
        setError(error instanceof Error ? error.message : '预览不可用，请等待影像加载。');
      }
    }
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };
    const events = [
      Enums.Events.IMAGE_RENDERED,
      Enums.Events.CAMERA_MODIFIED,
      Enums.Events.STACK_NEW_IMAGE,
    ];
    events.forEach(name => viewport.element.addEventListener(name, schedule));
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport.element);
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const point = (event: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    const down = (event: PointerEvent) => {
      if (!drawing) return;
      stop(event);
      start = point(event);
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drawing || !start) return;
      stop(event);
      render();
      const end = point(event),
        scaleX = canvas.width / canvas.clientWidth,
        scaleY = canvas.height / canvas.clientHeight;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffe000';
      ctx.strokeRect(
        start[0] * scaleX,
        start[1] * scaleY,
        (end[0] - start[0]) * scaleX,
        (end[1] - start[1]) * scaleY
      );
    };
    const up = (event: PointerEvent) => {
      if (!drawing || !start || !axes || !positions?.every(Number.isFinite)) return;
      stop(event);
      const end = point(event);
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 5) {
        start = undefined;
        return;
      }
      const a = viewport.canvasToWorld(start),
        b = viewport.canvasToWorld(end);
      const min = axes.map(axis => Math.min(dot(axis, a), dot(axis, b)));
      const max = axes.map(axis => Math.max(dot(axis, a), dot(axis, b)));
      min[2] = positions[0];
      max[2] = positions.at(-1);
      setRoi({ seriesInstanceUID: first.SeriesInstanceUID, axes, min, max });
      setDrawing(false);
    };
    if (drawing) {
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      ['mousedown', 'touchstart'].forEach(name =>
        viewport.element.addEventListener(name, stop, true)
      );
    }
    schedule();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.remove();
      events.forEach(name => viewport.element.removeEventListener(name, schedule));
      ['mousedown', 'touchstart'].forEach(name =>
        viewport.element.removeEventListener(name, stop, true)
      );
    };
  }, [viewport, viewportId, preview, enabled, lower, upper, replace, roi, drawing, busy]);

  function layer(value: number, end: boolean) {
    if (
      !roi ||
      !positions ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > positions.length ||
      (end ? value < firstLayer : value > lastLayer)
    )
      return;
    setRoi({
      ...roi,
      min: end ? roi.min : [roi.min[0], roi.min[1], positions[value - 1]],
      max: end ? [roi.max[0], roi.max[1], positions[value - 1]] : roi.max,
    });
  }
  return (
    <div className="space-y-2 border-t border-gray-700 pt-2 text-xs text-gray-300">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label="阈值实时预览"
          checked={preview}
          disabled={!enabled || busy}
          onChange={event => setPreview(event.target.checked)}
        />
        阈值实时预览（当前切片）
      </label>
      {preview && (
        <p className="text-gray-400">
          黄色为阈值候选区域，青色为替换时将清除的区域。点击应用才修改 Mask。
        </p>
      )}
      <button
        type="button"
        className="mask-action w-full"
        disabled={busy || !enabled || !(viewport instanceof StackViewport) || !axes}
        onClick={() => {
          setDrawing(!drawing);
          setError('');
        }}
      >
        {drawing ? '取消 ROI 框选' : '框选三维 ROI'}
      </button>
      {drawing && <p>在原始切片上拖动矩形；默认贯穿整组，可再调整起止层。</p>}
      {viewport instanceof VolumeViewport && (
        <p className="text-gray-400">框选 ROI 请先切换“轴向优先”；已有 ROI 可在 MPR 中使用。</p>
      )}
      {roi && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label>
              起始层
              <input
                type="number"
                aria-label="ROI 起始层"
                min="1"
                max={lastLayer}
                value={firstLayer}
                disabled={busy}
                onChange={event => layer(Number(event.target.value), false)}
                className="mask-input"
              />
            </label>
            <label>
              结束层
              <input
                type="number"
                aria-label="ROI 结束层"
                min={firstLayer}
                max={imageIds.length}
                value={lastLayer}
                disabled={busy}
                onChange={event => layer(Number(event.target.value), true)}
                className="mask-input"
              />
            </label>
          </div>
          <button
            type="button"
            className="mask-action w-full"
            disabled={busy}
            onClick={() => setRoi(undefined)}
          >
            清除 ROI 限制
          </button>
          <p className="text-gray-400">
            ROI 仅限制阈值和区域生长，范围外标注保留。层号按原始扫描方向排序。
          </p>
        </>
      )}
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}

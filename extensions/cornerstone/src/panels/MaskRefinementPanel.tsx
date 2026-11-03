import React, { useEffect, useState } from 'react';
import { eventTarget, StackViewport, VolumeViewport, Enums } from '@cornerstonejs/core';
import {
  MASK_REFINEMENT_EVENT,
  MASK_REFINEMENT_TASK_EVENT,
} from '../utils/maskEditing/maskRefinementEvents';
import type {
  MaskRefinementPreview,
  MaskRefinementTask,
} from '../utils/maskEditing/maskRefinementEvents';
import type { RefinementOperation } from '../utils/maskEditing/refinementAlgorithms';
import { refinementLabels } from '../utils/maskEditing/createMaskRefinementCommands';
import { maskDraftPauseReasons } from '../utils/maskEditing/maskProgress';

const descriptions = {
  dilate: '向外扩张，补厚或连接间隔小于邻域范围的选区。',
  erode: '向内收缩，可断开细小连接，也会缩小细结构。',
  open: '先腐蚀后膨胀，去除小突起和细小连接。',
  close: '先膨胀后腐蚀，填补小缝隙或小凹陷。',
  smooth: '先开运算再闭运算，平整边界；细小结构可能被去除。',
};

export default function MaskRefinementPanel({
  servicesManager,
  commandsManager,
  viewportId,
  segmentationId,
  segmentIndex,
  enabled,
  busy,
  visible,
  run,
}) {
  const [operation, setOperation] = useState<RefinementOperation>('dilate');
  const [radius, setRadius] = useState('1');
  const [minimumVolume, setMinimumVolume] = useState('100');
  const [preview, setPreview] = useState<MaskRefinementPreview>();
  const [task, setTask] = useState<MaskRefinementTask>();
  const [error, setError] = useState('');
  const viewport =
    servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
  function discard() {
    commandsManager.run('discardMaskRefinementPreview', { previewId: preview?.id });
    setPreview(undefined);
  }
  useEffect(() => {
    const onPreview = (event: CustomEvent<{ preview?: MaskRefinementPreview }>) => {
      const value = event.detail.preview;
      if (!value) setPreview(undefined);
      else if (
        visible &&
        value.segmentationId === segmentationId &&
        value.segmentIndex === segmentIndex
      ) {
        setPreview(value);
        setError('');
      }
    };
    eventTarget.addEventListener(MASK_REFINEMENT_EVENT, onPreview);
    const onTask = (event: CustomEvent<MaskRefinementTask>) => {
      const value = event.detail;
      if (['complete', 'cancelled', 'error'].includes(value.phase))
        setTask(current => (current?.id === value.id ? undefined : current));
      else if (
        visible &&
        value.segmentationId === segmentationId &&
        value.segmentIndex === segmentIndex
      )
        setTask(value);
    };
    eventTarget.addEventListener(MASK_REFINEMENT_TASK_EVENT, onTask);
    return () => {
      eventTarget.removeEventListener(MASK_REFINEMENT_EVENT, onPreview);
      eventTarget.removeEventListener(MASK_REFINEMENT_TASK_EVENT, onTask);
    };
  }, [visible, segmentationId, segmentIndex]);
  useEffect(() => {
    setPreview(undefined);
    setTask(undefined);
    commandsManager.run('discardMaskRefinementPreview');
    return () => {
      commandsManager.run('discardMaskRefinementPreview');
    };
  }, [visible, segmentationId, segmentIndex, commandsManager]);
  useEffect(() => {
    if (preview) maskDraftPauseReasons.add('mask-refinement');
    return () => {
      maskDraftPauseReasons.delete('mask-refinement');
    };
  }, [preview?.id]);

  useEffect(() => {
    if (
      !preview ||
      !visible ||
      busy ||
      !(viewport instanceof StackViewport || viewport instanceof VolumeViewport)
    )
      return;
    const data = commandsManager.run('getMaskRefinementPreviewData', { previewId: preview.id });
    if (!data) return;
    const canvas = document.createElement('canvas');
    canvas.dataset.maskRefinementPreview = 'true';
    canvas.setAttribute('aria-label', 'Mask 精修增删预览');
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '9',
    });
    viewport.element.appendChild(canvas);
    let raf = 0;
    function render() {
      const rectangle = viewport.element.getBoundingClientRect();
      const scale = Math.min(1, 384 / Math.max(rectangle.width, rectangle.height));
      canvas.width = Math.max(1, Math.round(rectangle.width * scale));
      canvas.height = Math.max(1, Math.round(rectangle.height * scale));
      const ctx = canvas.getContext('2d'),
        output = ctx.createImageData(canvas.width, canvas.height);
      const sx = rectangle.width / canvas.width,
        sy = rectangle.height / canvas.height;
      const world = [
        [sx / 2, sy / 2],
        [sx * 1.5, sy / 2],
        [sx / 2, sy * 1.5],
      ].map(point => viewport.canvasToWorld(point));
      const origin = data.imageData.worldToIndex(world[0]);
      const dx = data.imageData.worldToIndex(world[1]).map((v, i) => v - origin[i]);
      const dy = data.imageData.worldToIndex(world[2]).map((v, i) => v - origin[i]);
      const dims = data.dimensions;
      let shown = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const p = origin.map((v, i) => Math.round(v + dx[i] * x + dy[i] * y));
          if (p.some((v, i) => v < 0 || v >= dims[i])) continue;
          const index = p[0] + dims[0] * (p[1] + dims[1] * p[2]);
          const added = data.state[index] === 0 && data.result[index] === 1;
          const removed = data.state[index] === 1 && data.result[index] === 0;
          if (!added && !removed) continue;
          output.data.set(
            added ? [20, 255, 120, 190] : [255, 40, 210, 190],
            (y * canvas.width + x) * 4
          );
          shown++;
        }
      canvas.dataset.changedSamples = String(shown);
      ctx.putImageData(output, 0, 0);
    }
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          render();
          setError('');
        } catch {
          setError('当前视口尚未就绪，请等待影像加载，或重新生成预览。');
        }
      });
    };
    const events = [
      Enums.Events.IMAGE_RENDERED,
      Enums.Events.CAMERA_MODIFIED,
      Enums.Events.STACK_NEW_IMAGE,
    ];
    events.forEach(name => viewport.element.addEventListener(name, schedule));
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport.element);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.remove();
      events.forEach(name => viewport.element.removeEventListener(name, schedule));
    };
  }, [preview?.id, viewport, visible, busy, commandsManager]);

  function prepare(kind: RefinementOperation) {
    const options = {
      operation: kind,
      radiusMm: Number(radius),
      minimumVolumeMm3: Number(minimumVolume),
    };
    if (
      ['dilate', 'erode', 'open', 'close', 'smooth'].includes(kind) &&
      (!radius.trim() ||
        !Number.isFinite(options.radiusMm) ||
        options.radiusMm < 0.1 ||
        options.radiusMm > 10)
    ) {
      setError('半径应为 0.1 至 10 mm。');
      return;
    }
    if (
      kind === 'removeSmall' &&
      (!minimumVolume.trim() ||
        !Number.isFinite(options.minimumVolumeMm3) ||
        options.minimumVolumeMm3 <= 0 ||
        options.minimumVolumeMm3 > 1e9)
    ) {
      setError('请输入大于 0 的碎片体积门槛，单位 mm³。');
      return;
    }
    setError('');
    run('previewMaskRefinement', options);
  }
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div
      className="mt-4 space-y-3 border-t border-gray-700 pt-3"
      aria-label="三维精修与碎片清理"
    >
      <h4>三维形态学精修</h4>
      {task && (
        <div
          className="sticky top-0 z-10 space-y-2 rounded border border-gray-600 bg-gray-900 p-2 text-xs text-gray-300"
          aria-label="精修计算进度"
        >
          <p aria-live="polite">{task.message}</p>
          <div
            role="progressbar"
            aria-label="精修整体进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={task.percent}
            className="h-2 overflow-hidden rounded bg-gray-700"
          >
            <div
              className="h-full"
              style={{ width: `${task.percent}%`, backgroundColor: '#22d3ee' }}
            />
          </div>
          <p>整体 {task.percent}% · 正在准备只读预览，尚未修改选区</p>
          <button
            type="button"
            className="mask-action w-full"
            disabled={task.phase === 'cancelling'}
            onClick={() =>
              commandsManager.run('cancelMaskRefinementCalculation', { taskId: task.id })
            }
          >
            {task.phase === 'cancelling' ? '正在取消…' : '取消精修计算'}
          </button>
        </div>
      )}
      <p className="mask-help">
        处理整组当前 Mask；不受阈值 ROI 限制。其他 Mask 不会被覆盖。先预览，再应用。
      </p>
      <label className="mask-control-label">
        操作
        <select
          aria-label="三维形态学操作"
          className="mask-input"
          disabled={!enabled || busy}
          value={operation}
          onChange={event => {
            discard();
            setOperation(event.target.value as RefinementOperation);
          }}
        >
          {['dilate', 'erode', 'open', 'close', 'smooth'].map(kind => (
            <option
              key={kind}
              value={kind}
            >
              {refinementLabels[kind]}
            </option>
          ))}
        </select>
      </label>
      <p className="mask-help">{descriptions[operation]}</p>
      <label className="mask-control-label">
        邻域半径（mm）
        <input
          aria-label="形态学半径 mm"
          type="number"
          min="0.1"
          max="10"
          step="0.1"
          className="mask-input"
          disabled={!enabled || busy}
          value={radius}
          onChange={event => {
            discard();
            setRadius(event.target.value);
          }}
        />
      </label>
      <p className="mask-help">按实际体素间距计算。例如半径 1 mm、层距 5 mm 时不会跨层膨胀。</p>
      <button
        type="button"
        className="mask-action w-full"
        disabled={!enabled || busy}
        onClick={() => prepare(operation)}
      >
        预览三维形态学
      </button>
      <h4>三维连通区域清理</h4>
      <button
        type="button"
        className="mask-action w-full"
        disabled={!enabled || busy}
        onClick={() => prepare('largest')}
      >
        预览保留最大区域
      </button>
      <label className="mask-control-label">
        删除体积小于（mm³）
        <input
          aria-label="碎片最小体积 mm3"
          type="number"
          min="0.001"
          step="1"
          className="mask-input"
          value={minimumVolume}
          disabled={!enabled || busy}
          onChange={event => {
            discard();
            setMinimumVolume(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        className="mask-action w-full"
        disabled={!enabled || busy}
        onClick={() => prepare('removeSmall')}
      >
        预览删除小碎片
      </button>
      <button
        type="button"
        className="mask-action w-full"
        disabled={!enabled || busy}
        onClick={() => {
          discard();
          run(
            'setToolActiveToolbar',
            { toolName: 'MaskRemoveRegion' },
            '点选删除已启用：点击当前 Mask 内的区域，先生成整组三维删除预览。'
          );
        }}
      >
        点选删除连通区域 · 先预览
      </button>
      <p className="mask-help">
        按三维六邻接判断连通；点选会包含与点击处相连的所有层。体积恰好等于门槛的区域保留。
      </p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {preview && (
        <div
          role="region"
          aria-label="Mask 精修预览"
          className="space-y-2 rounded border border-gray-600 p-2 text-xs text-gray-300"
        >
          <strong>{refinementLabels[preview.operation]}</strong>
          <p>
            目标：{preview.segmentIndex} · {preview.label}；共 {preview.sliceCount} 层
          </p>
          <p>
            当前 {number(preview.before)} → 预计 {number(preview.after)} 个体素
          </p>
          <p data-testid="refinement-counts">
            新增 {number(preview.added)} / 删除 {number(preview.removed)} 个体素
          </p>
          <p>预计体积 {number(preview.after * preview.voxelVolumeMm3)} mm³</p>
          {preview.before > 0 && preview.after === 0 && (
            <p className="text-amber-300">此预览将清空当前 Mask；可关闭预览调整参数。</p>
          )}
          {!preview.added && !preview.removed && (
            <p className="text-gray-400">当前参数不产生选区变化，无需应用。</p>
          )}
          {preview.components !== undefined && (
            <p>
              共 {number(preview.components)} 个连通区域；预计删除{' '}
              {number(preview.removedComponents)} 个
            </p>
          )}
          <p className="text-gray-400">
            绿色新增、品红删除；尚未修改 Mask。可滚动切片或在 MPR 查看，三维模型在应用后更新。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="mask-action"
              disabled={!enabled || busy || (!preview.added && !preview.removed)}
              onClick={async () => {
                const result = await run('applyMaskRefinement', { previewId: preview.id });
                if (result)
                  commandsManager.run('setToolActiveToolbar', { toolName: 'WindowLevel' });
              }}
            >
              应用精修结果
            </button>
            <button
              type="button"
              className="mask-action"
              disabled={busy}
              onClick={discard}
            >
              关闭精修预览
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

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
import {
  parseInterpolationKeyframes,
  interpolationKeyframes,
  MAX_INTERPOLATION_KEYFRAMES,
} from '../utils/maskEditing/refinementAlgorithms';
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
  roi,
  toolName,
}) {
  const [section, setSection] = useState('morphology');
  const [operation, setOperation] = useState<RefinementOperation>('dilate');
  const [radius, setRadius] = useState('1');
  const [minimumVolume, setMinimumVolume] = useState('100');
  const [maximumCavityVolume, setMaximumCavityVolume] = useState('1000');
  const [unlimitedCavities, setUnlimitedCavities] = useState(false);
  const [useRoi, setUseRoi] = useState(false);
  const [huLower, setHuLower] = useState('150'),
    [huUpper, setHuUpper] = useState('2000');
  const [replaceGrow, setReplaceGrow] = useState(false);
  const [startSlice, setStartSlice] = useState(''),
    [endSlice, setEndSlice] = useState('');
  const [replaceIntermediate, setReplaceIntermediate] = useState(false);
  const [interpolationMode, setInterpolationMode] = useState('pair');
  const [keyframeText, setKeyframeText] = useState('');
  const [booleanOperation, setBooleanOperation] = useState('union'),
    [operand, setOperand] = useState('');
  const [cutOffset, setCutOffset] = useState('0'),
    [keepPositive, setKeepPositive] = useState(true);
  const availableOperands = servicesManager.services.segmentationService
    .getSegmentations()
    .filter(item => item.segmentationId !== segmentationId && item.representationData.Labelmap)
    .flatMap(item =>
      Object.values(item.segments).map((segment: any) => ({
        key: JSON.stringify([item.segmentationId, segment.segmentIndex]),
        label: `${item.label} / ${segment.label}`,
      }))
    );
  const [preview, setPreview] = useState<MaskRefinementPreview>();
  const [task, setTask] = useState<MaskRefinementTask>();
  const [error, setError] = useState('');
  const viewport =
    servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
  useEffect(() => {
    if (toolName === 'MaskHuGrow') setSection('hugrow');
    else if (toolName === 'MaskRemoveRegion') setSection('cleanup');
  }, [toolName]);
  function discard() {
    commandsManager.run('discardMaskRefinementPreview', { previewId: preview?.id });
    setPreview(undefined);
  }
  useEffect(() => {
    commandsManager.run('configureMaskHuGrow', {
      lower: huLower.trim() ? Number(huLower) : NaN,
      upper: huUpper.trim() ? Number(huUpper) : NaN,
      replace: replaceGrow,
      useRoi: Boolean(roi && useRoi),
    });
  }, [huLower, huUpper, replaceGrow, useRoi, Boolean(roi), commandsManager]);
  useEffect(() => {
    setStartSlice('');
    setEndSlice('');
    setKeyframeText('');
  }, [segmentationId, segmentIndex]);
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
      maximumCavityVolumeMm3: unlimitedCavities ? undefined : Number(maximumCavityVolume),
      useRoi: Boolean(roi && useRoi),
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
    if (
      kind === 'fillCavities' &&
      !unlimitedCavities &&
      (!maximumCavityVolume.trim() ||
        !Number.isFinite(options.maximumCavityVolumeMm3) ||
        options.maximumCavityVolumeMm3 <= 0 ||
        options.maximumCavityVolumeMm3 > 1e9)
    ) {
      setError('空腔最大体积应大于 0，且不超过 1000000000 mm³，或选择不限制体积。');
      return;
    }
    setError('');
    run('previewMaskRefinement', options);
  }
  useEffect(() => {
    discard();
  }, [JSON.stringify(roi)]);
  function captureSlice(end: boolean) {
    try {
      const context = commandsManager.run('getMaskRefinementSliceContext');
      discard();
      if (end) setEndSlice(String(context.slice));
      else setStartSlice(String(context.slice));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '请先选择切片窗口。');
    }
  }
  function addCurrentKeyframe() {
    try {
      const { slice } = commandsManager.run('getMaskRefinementSliceContext');
      const keys = [
        ...new Set([
          ...(keyframeText.trim() ? parseInterpolationKeyframes(keyframeText) : []),
          slice,
        ]),
      ].sort((a: number, b: number) => a - b);
      if (keys.length > MAX_INTERPOLATION_KEYFRAMES)
        throw new Error(`一次最多选择 ${MAX_INTERPOLATION_KEYFRAMES} 张关键层，请分段处理。`);
      discard();
      setKeyframeText(keys.join(', '));
      setError('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '请先选择原始轴向切片窗口。');
    }
  }
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div
      className="mt-4 space-y-3 border-t border-gray-700 pt-3"
      aria-label="三维精修与碎片清理"
    >
      <h4>三维精修工具箱</h4>
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
      <p className="mask-help">处理当前 Mask；其他 Mask 不会被覆盖。先预览，再应用。</p>
      <label className="flex items-start gap-2 text-xs text-gray-300">
        <input
          type="checkbox"
          aria-label="精修仅处理 ROI"
          disabled={!roi || busy}
          checked={Boolean(roi && useRoi)}
          onChange={event => {
            discard();
            setUseRoi(event.target.checked);
          }}
        />
        仅处理 ROI，范围外选区保留
      </label>
      <p className="mask-help">
        {roi && useRoi
          ? '已限定 ROI。形态学与三维填洞参考完整 Mask，只将 ROI 内变化写入。'
          : '当前范围：完整 Mask。需要限定范围时先在“阈值”页框选 ROI。'}
      </p>
      <nav
        className="mask-refinement-nav"
        aria-label="编辑工具分组"
      >
        {[
          ['morphology', '形态学'],
          ['cleanup', '区域清理'],
          ['cavities', '三维填洞'],
          ['hugrow', 'HU 生长'],
          ['interpolate', '插值'],
          ['cut', '切面'],
          ['boolean', '布尔'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            disabled={busy}
            aria-label={`编辑工具组：${label}`}
            aria-pressed={section === id}
            onClick={() => {
              commandsManager.run('setToolActiveToolbar', { toolName: 'WindowLevel' });
              setError('');
              setSection(id);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div
        hidden={section !== 'morphology'}
        aria-label="形态学工具组"
      >
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
      </div>
      <div
        hidden={section !== 'cleanup'}
        aria-label="cleanup 工具组"
      >
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
      </div>
      <div
        hidden={section !== 'cavities'}
        aria-label="三维填洞工具组"
      >
        <h4>三维封闭空腔填充</h4>
        <p className="mask-help">
          检查整组切片，只填当前 Mask 完全包围的空腔。通向任一影像外缘的通道（含对角连通）保留。
        </p>
        <label className="mask-control-label">
          仅填体积不超过（mm³）
          <input
            aria-label="空腔最大体积 mm3"
            type="number"
            min="0.001"
            max="1000000000"
            step="1"
            className="mask-input"
            value={maximumCavityVolume}
            disabled={!enabled || busy || unlimitedCavities}
            onChange={event => {
              discard();
              setMaximumCavityVolume(event.target.value);
            }}
          />
        </label>
        <label className="flex items-start gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            aria-label="三维填洞不限制体积"
            checked={unlimitedCavities}
            disabled={!enabled || busy}
            onChange={event => {
              discard();
              setUnlimitedCavities(event.target.checked);
            }}
          />
          不限制空腔体积
        </label>
        <p className="mask-help">
          背景按 26 邻接判断；体积包含腔内其他 Mask，但这些像素不会被覆盖。体积等于门槛时也会填充。
          ROI 只限制写入，不能把开放通道变成封闭空腔。
        </p>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy}
          onClick={() => prepare('fillCavities')}
        >
          预览三维空腔填充
        </button>
        <p className="mask-help">下方绿色区域为预计填充；检查应保留的解剖空腔后再应用。</p>
      </div>
      <div
        hidden={section !== 'hugrow'}
        aria-label="hugrow 工具组"
      >
        <h4>HU 灰度区域生长</h4>
        <p className="mask-help">
          直接点原始 CT，从种子沿 HU 范围内的相邻体素生长；不必先做阈值。使用上方 ROI 范围选择。
        </p>
        <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
          <label>
            HU 下限
            <input
              type="number"
              className="mask-input"
              aria-label="灰度生长 HU 下限"
              value={huLower}
              disabled={!enabled || busy}
              onChange={e => {
                discard();
                setHuLower(e.target.value);
              }}
            />
          </label>
          <label>
            HU 上限
            <input
              type="number"
              className="mask-input"
              aria-label="灰度生长 HU 上限"
              value={huUpper}
              disabled={!enabled || busy}
              onChange={e => {
                discard();
                setHuUpper(e.target.value);
              }}
            />
          </label>
        </div>
        <label className="flex gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            aria-label="灰度生长替换选区"
            checked={replaceGrow}
            disabled={!enabled || busy}
            onChange={e => {
              discard();
              setReplaceGrow(e.target.checked);
            }}
          />
          替换所选范围的当前 Mask（默认追加）
        </label>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy}
          onClick={() => {
            const lower = Number(huLower),
              upper = Number(huUpper);
            if (
              !huLower.trim() ||
              !huUpper.trim() ||
              !Number.isFinite(lower) ||
              !Number.isFinite(upper) ||
              lower > upper
            ) {
              setError('请填写有效的 HU 上下限。');
              return;
            }
            discard();
            setError('');
            commandsManager.run('configureMaskHuGrow', {
              lower,
              upper,
              replace: replaceGrow,
              useRoi: Boolean(roi && useRoi),
            });
            run(
              'setToolActiveToolbar',
              { toolName: 'MaskHuGrow' },
              'HU 灰度生长已启用：请点选 HU 范围内的目标，先生成预览。'
            );
          }}
        >
          点选 HU 灰度生长 · 先预览
        </button>
      </div>
      <div
        hidden={section !== 'interpolate'}
        aria-label="interpolate 工具组"
      >
        <h4>关键层插值</h4>
        <p className="mask-help">
          在原始切片画好关键层；按相邻关键层逐段补齐中间层。所有指定关键层保持不变。
        </p>
        <label className="mask-control-label">
          关键层方式
          <select
            aria-label="插值关键层方式"
            className="mask-input"
            disabled={!enabled || busy}
            value={interpolationMode}
            onChange={event => {
              discard();
              setError('');
              setInterpolationMode(event.target.value);
            }}
          >
            <option value="pair">两张关键层</option>
            <option value="multiple">多张关键层 · 逐段插值</option>
          </select>
        </label>
        <div hidden={interpolationMode !== 'pair'}>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
            <label>
              起始关键层
              <input
                type="number"
                min="1"
                className="mask-input"
                aria-label="插值起始关键层"
                value={startSlice}
                disabled={!enabled || busy}
                onChange={e => {
                  discard();
                  setStartSlice(e.target.value);
                }}
              />
            </label>
            <label>
              结束关键层
              <input
                type="number"
                min="1"
                className="mask-input"
                aria-label="插值结束关键层"
                value={endSlice}
                disabled={!enabled || busy}
                onChange={e => {
                  discard();
                  setEndSlice(e.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="mask-action"
              disabled={!enabled || busy}
              onClick={() => captureSlice(false)}
            >
              当前层设为起始
            </button>
            <button
              type="button"
              className="mask-action"
              disabled={!enabled || busy}
              onClick={() => captureSlice(true)}
            >
              当前层设为结束
            </button>
          </div>
        </div>
        <div
          hidden={interpolationMode !== 'multiple'}
          className="space-y-2"
        >
          <label className="mask-control-label">
            关键层列表（按层号递增）
            <textarea
              aria-label="插值关键层列表"
              className="mask-input"
              rows={2}
              placeholder="例如 1, 5, 10, 18"
              value={keyframeText}
              disabled={!enabled || busy}
              onChange={event => {
                discard();
                setKeyframeText(event.target.value);
              }}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="mask-action"
              disabled={!enabled || busy}
              onClick={addCurrentKeyframe}
            >
              添加当前层为关键层
            </button>
            <button
              type="button"
              className="mask-action"
              disabled={!enabled || busy}
              onClick={async () => {
                discard();
                setError('');
                const result = await run('getMaskInterpolationKeyframes');
                if (!result?.keyframes) return;
                setKeyframeText(result.keyframes.join(', '));
                if (result.keyframes.length < 2)
                  setError('当前 Mask 不足两张已标注关键层，请先绘制选区或手动添加层号。');
              }}
            >
              读取当前 Mask 已标注层
            </button>
          </div>
          <p className="mask-help">
            可输入逗号、中文逗号或空格分隔的层号，最多 {MAX_INTERPOLATION_KEYFRAMES} 张。
            读取结果也包含以前插值产生的层，请确认列表；每张关键层都必须有当前 Mask 选区。
          </p>
        </div>
        <label className="flex gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            aria-label="替换已有中间层"
            checked={replaceIntermediate}
            disabled={!enabled || busy}
            onChange={e => {
              discard();
              setReplaceIntermediate(e.target.checked);
            }}
          />
          替换已有中间层（默认跳过已标注层）
        </label>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy}
          onClick={() => {
            let keys: number[];
            try {
              keys = interpolationKeyframes(
                {
                  operation: 'interpolate',
                  ...(interpolationMode === 'multiple'
                    ? { keyframes: parseInterpolationKeyframes(keyframeText) }
                    : { startSlice: Number(startSlice), endSlice: Number(endSlice) }),
                },
                Infinity
              );
            } catch (error) {
              setError(error instanceof Error ? error.message : '请选择有效关键层。');
              return;
            }
            setError('');
            run('previewMaskRefinement', {
              operation: 'interpolate',
              keyframes: keys,
              replaceIntermediate,
              useRoi: Boolean(roi && useRoi),
            });
          }}
        >
          预览关键层插值
        </button>
      </div>
      <div
        hidden={section !== 'cut'}
        aria-label="cut 工具组"
      >
        <h4>三维切面裁剪</h4>
        <p className="mask-help">
          以当前切片为切面，保留一侧的整组
          Mask。选择轴向、冠状或矢状窗口可改变切面方向；先看删除预览。
        </p>
        <label className="mask-control-label">
          切面偏移（mm）
          <input
            type="number"
            min="-1000"
            max="1000"
            className="mask-input"
            aria-label="三维切面偏移 mm"
            value={cutOffset}
            disabled={!enabled || busy}
            onChange={e => {
              discard();
              setCutOffset(e.target.value);
            }}
          />
        </label>
        <label className="mask-control-label">
          保留侧
          <select
            className="mask-input"
            aria-label="三维切面保留侧"
            value={keepPositive ? 'positive' : 'negative'}
            disabled={!enabled || busy}
            onChange={e => {
              discard();
              setKeepPositive(e.target.value === 'positive');
            }}
          >
            <option value="positive">法向一侧</option>
            <option value="negative">相反一侧</option>
          </select>
        </label>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy}
          onClick={() => {
            if (
              !cutOffset.trim() ||
              !Number.isFinite(Number(cutOffset)) ||
              Math.abs(Number(cutOffset)) > 1000
            ) {
              setError('切面偏移应为 -1000 至 1000 mm。');
              return;
            }
            setError('');
            run('previewMaskRefinement', {
              operation: 'cut',
              cutFromView: true,
              cutOffsetMm: Number(cutOffset),
              keepPositive,
              useRoi: Boolean(roi && useRoi),
            });
          }}
        >
          预览三维切面裁剪
        </button>
      </div>
      <div
        hidden={section !== 'boolean'}
        aria-label="boolean 工具组"
      >
        <h4>独立 Mask 与布尔运算</h4>
        <p className="mask-help">
          独立副本存于新的单 Mask 标注集，可与原始 Mask 重叠。布尔运算只改当前独立副本，来源 Mask
          保留。
        </p>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy}
          onClick={() => run('cloneCurrentMask')}
        >
          复制当前 Mask 为独立副本
        </button>
        <label className="mask-control-label">
          另一个源 Mask
          <select
            className="mask-input"
            aria-label="布尔运算源 Mask"
            disabled={!enabled || busy}
            value={operand}
            onChange={e => {
              discard();
              setOperand(e.target.value);
            }}
          >
            <option value="">请选择其他标注集的 Mask</option>
            {availableOperands.map(item => (
              <option
                key={item.key}
                value={item.key}
              >
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mask-control-label">
          运算
          <select
            className="mask-input"
            aria-label="Mask 布尔运算"
            disabled={!enabled || busy}
            value={booleanOperation}
            onChange={e => {
              discard();
              setBooleanOperation(e.target.value);
            }}
          >
            <option value="union">并集：当前 ∪ 源</option>
            <option value="intersection">交集：当前 ∩ 源</option>
            <option value="difference">差集：当前 − 源</option>
          </select>
        </label>
        <button
          type="button"
          className="mask-action w-full"
          disabled={!enabled || busy || !operand}
          onClick={() => {
            const [operandSegmentationId, operandSegmentIndex] = JSON.parse(operand);
            setError('');
            run('previewMaskRefinement', {
              operation: 'boolean',
              booleanOperation,
              operandSegmentationId,
              operandSegmentIndex,
              useRoi: Boolean(roi && useRoi),
            });
          }}
        >
          预览 Mask 布尔运算
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="text-xs text-red-300"
        >
          {error}
        </p>
      )}
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
          <p>范围：{preview.roi ? '仅 ROI（范围外保留）' : '完整 Mask'}</p>
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
          {preview.cavities !== undefined && (
            <p data-testid="cavity-counts">
              全组封闭空腔 {number(preview.cavities)} 处；符合体积门槛{' '}
              {number(preview.eligibleCavities)} 处
              {preview.roi ? '；ROI 限制后的实际新增量见上方' : ''}。
              {preview.maximumCavityVolumeMm3 === undefined
                ? '不限制体积。'
                : `最大体积 ${number(preview.maximumCavityVolumeMm3)} mm³（含等于）。`}
            </p>
          )}
          {preview.operation === 'interpolate' && (
            <div data-testid="interpolation-summary">
              <p>
                关键层 {(preview.keyframes || [preview.startSlice, preview.endSlice]).length} 张：
                {(preview.keyframes || [preview.startSlice, preview.endSlice]).join(', ')}
                ；全部保留。
              </p>
              <p>
                全组分析：计算 {preview.interpolatedSlices} 层，跳过已有标注 {preview.skippedSlices}{' '}
                层。
              </p>
              {preview.roi && <p>ROI 限制后的实际增删量见上方。</p>}
            </div>
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

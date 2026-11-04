import React, { useEffect, useRef, useState } from 'react';
import { useSystem } from '@ohif/core';
import { useViewportGrid } from '@ohif/ui-next';
import { StackViewport, VolumeViewport, eventTarget, metaData } from '@cornerstonejs/core';
import { Enums as ToolEnums } from '@cornerstonejs/tools';
import {
  MASK_OPERATION_EVENT,
  MASK_BRUSH_SIZE_EVENT,
  MaskOperationStatus,
} from '../utils/maskEditing/maskOperationEvents';
import { useActiveViewportSegmentationRepresentations } from '../hooks/useActiveViewportSegmentationRepresentations';
import type { MaskSplitPreview } from '../utils/maskEditing/splitMaskTypes';
import './MaskWorkbench.css';
import MaskProgressPanel from './MaskProgressPanel';
import MaskThresholdPreview from './MaskThresholdPreview';
import MaskRefinementPanel from './MaskRefinementPanel';
import { MaskRoi, maskRoiSettings } from '../utils/maskEditing/maskRoi';
import { MASK_ROI_EVENT, setMaskRoi } from '../utils/maskEditing/maskRoiStore';
import MaskHistoryPanel from './MaskHistoryPanel';

const stages = [
  ['threshold', '阈值'],
  ['grow', '区域生长'],
  ['edit', '编辑'],
  ['split', '拆分'],
] as const;
type Stage = (typeof stages)[number][0];
const presets = { bone: [150, 3071], soft: [-100, 300], lung: [-950, -300] };
const brushTools = [
  'CircularBrush',
  'SphereBrush',
  'CircularEraser',
  'SphereEraser',
  'ThresholdCircularBrush',
  'ThresholdSphereBrush',
  'ThresholdCircularBrushDynamic',
  'ThresholdSphereBrushDynamic',
];

/** Extra mask operations complement OHIF's existing brush, eraser and threshold brushes. */
export default function MaskEditingTools() {
  const { servicesManager, commandsManager } = useSystem();
  const {
    segmentationService,
    cornerstoneViewportService,
    viewportGridService,
    toolGroupService,
    displaySetService,
  } = servicesManager.services;
  const [grid] = useViewportGrid();
  const { segmentationsWithRepresentations } = useActiveViewportSegmentationRepresentations();
  const [lower, setLower] = useState('150');
  const [upper, setUpper] = useState('2000');
  const [replace, setReplace] = useState(true);
  const [scope, setScope] = useState('series');
  const [thresholdPreview, setThresholdPreview] = useState(false);
  const [roi, setRoi] = useState<MaskRoi>();
  const [busy, setBusy] = useState(false);
  const projectInput = useRef<HTMLInputElement>(null);
  const workspaceInput = useRef<HTMLInputElement>(null);
  const [regionArmed, setRegionArmed] = useState(false);
  const [splitScope, setSplitScope] = useState('series');
  const [minimumVoxels, setMinimumVoxels] = useState('1');
  const [splitPreview, setSplitPreview] = useState<MaskSplitPreview>();
  const [stage, setStage] = useState<Stage>('threshold');
  const [preset, setPreset] = useState('custom');
  const [tool, setTool] = useState('WindowLevel');
  const [shape, setShape] = useState<'circle' | 'sphere'>('circle');
  const [radius, setRadius] = useState('3');
  const [fillScope, setFillScope] = useState('slice');
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const active = segmentationService.getActiveSegmentation(grid?.activeViewportId);
  const segment = segmentationService.getActiveSegment(grid?.activeViewportId);
  const viewport = cornerstoneViewportService.getCornerstoneViewport(grid?.activeViewportId);
  const isSliceViewport = viewport instanceof StackViewport || viewport instanceof VolumeViewport;
  const displaySetId =
    grid?.activeViewportId &&
    viewportGridService.getDisplaySetsUIDsForViewport(grid.activeViewportId)?.[0];
  const sourceImageId =
    displaySetId && displaySetService.getDisplaySetByUID(displaySetId)?.imageIds?.[0];
  const sourceSeries = sourceImageId && metaData.get('instance', sourceImageId)?.SeriesInstanceUID;
  const canReconstruct = Boolean(
    displaySetId && displaySetService.getDisplaySetByUID(displaySetId)?.isReconstructable
  );
  const enabled = Boolean(
    isSliceViewport &&
      active?.representationData.Labelmap &&
      segment &&
      !segment.locked &&
      segmentationsWithRepresentations.some(
        item => item.segmentation.segmentationId === active.segmentationId
      )
  );
  const buttonClass = 'mask-action';

  useEffect(() => {
    const refresh = () => setRoi(sourceSeries ? maskRoiSettings.get(sourceSeries) : undefined);
    refresh();
    eventTarget.addEventListener(MASK_ROI_EVENT, refresh);
    return () => eventTarget.removeEventListener(MASK_ROI_EVENT, refresh);
  }, [sourceSeries]);

  useEffect(() => {
    const onStatus = (event: CustomEvent<MaskOperationStatus>) => {
      const { phase, message } = event.detail;
      setBusy(phase === 'start' || phase === 'progress');
      setFeedback({ message, error: phase === 'error' });
    };
    eventTarget.addEventListener(MASK_OPERATION_EVENT, onStatus);
    const onTool = (event?: CustomEvent) => {
      const id = viewportGridService.getActiveViewportId();
      if (!id) return;
      const group = toolGroupService.getToolGroupForViewport(id);
      if (!group || (event && event.detail.toolGroupId !== group.id)) return;
      const name = event?.detail.toolName || group.getActivePrimaryMouseButtonTool();
      if (!name) return;
      setTool(name);
      setRegionArmed(name === 'MaskRegionGrow');
      if (name === 'MaskRegionGrow') setStage('grow');
      else if (name === 'MaskRemoveRegion' || name === 'MaskHuGrow') setStage('edit');
      else if (/Brush|Eraser/.test(name)) {
        setStage('edit');
        setShape(name.includes('Sphere') ? 'sphere' : 'circle');
        const size = group.getToolConfiguration(name)?.brushSize;
        if (typeof size === 'number') setRadius(String(size));
      }
    };
    const onSize = (event: CustomEvent) => {
      const group = toolGroupService.getToolGroupForViewport(
        viewportGridService.getActiveViewportId()
      );
      if (event.detail.toolGroupId && group?.id !== event.detail.toolGroupId) return;
      const currentTool = group?.getActivePrimaryMouseButtonTool();
      const currentSize = currentTool && group.getToolConfiguration(currentTool)?.brushSize;
      setRadius(String(typeof currentSize === 'number' ? currentSize : event.detail.value));
    };
    eventTarget.addEventListener(ToolEnums.Events.TOOL_ACTIVATED, onTool);
    eventTarget.addEventListener(MASK_BRUSH_SIZE_EVENT, onSize);
    onTool();
    return () => {
      eventTarget.removeEventListener(MASK_OPERATION_EVENT, onStatus);
      eventTarget.removeEventListener(ToolEnums.Events.TOOL_ACTIVATED, onTool);
      eventTarget.removeEventListener(MASK_BRUSH_SIZE_EVENT, onSize);
    };
  }, [grid?.activeViewportId, toolGroupService, viewportGridService]);

  useEffect(() => {
    setSplitPreview(undefined);
    commandsManager.run('discardMaskSplitPreview');
  }, [active?.segmentationId, segment?.segmentIndex, commandsManager]);

  async function run(commandName: string, options = {}, successMessage = '操作完成。') {
    if (busy) return;
    setBusy(true);
    try {
      const result = await commandsManager.run(commandName, options);
      if (result === false) {
        setFeedback({
          message: '当前影像无法执行此操作，请确认导入的是完整且可重建的序列。',
          error: true,
        });
        return result;
      }
      const message =
        result && typeof result === 'object' && 'message' in result
          ? String(result.message)
          : successMessage;
      setFeedback({
        message,
        error: Boolean(result && typeof result === 'object' && 'error' in result && result.error),
      });
      return result;
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : '操作失败，请检查当前影像和 Mask。',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  function discardSplit() {
    commandsManager.run('discardMaskSplitPreview', { previewId: splitPreview?.id });
    setSplitPreview(undefined);
  }

  async function analyzeSplit() {
    discardSplit();
    const result = await run('analyzeMaskSplit', { minimumVoxels: Number(minimumVoxels) });
    if (result && typeof result === 'object' && 'preview' in result)
      setSplitPreview(result.preview as MaskSplitPreview);
  }

  function thresholdRange() {
    if (!lower.trim() || !upper.trim()) {
      setFeedback({ message: '请填写阈值上下限。', error: true });
      return;
    }
    const range = { lower: Number(lower), upper: Number(upper) };
    if (
      !Number.isFinite(range.lower) ||
      !Number.isFinite(range.upper) ||
      range.lower > range.upper
    ) {
      setFeedback({ message: '阈值下限不能大于上限，且必须是有效数字。', error: true });
      return;
    }
    return range;
  }

  async function threshold() {
    const range = thresholdRange();
    if (!range) return;
    const result = await run(scope === 'series' ? 'thresholdMaskSeries' : 'thresholdMaskSlice', {
      ...range,
      replace,
      roi,
    });
    if (result) setThresholdPreview(false);
  }

  function selectStage(next: Stage) {
    try {
      if (
        (next !== 'edit' &&
          (/Brush|Eraser/.test(tool) ||
            tool === 'MaskRegionGrow' ||
            tool === 'MaskRemoveRegion' ||
            tool === 'MaskHuGrow')) ||
        (next !== 'grow' && tool === 'MaskRegionGrow')
      ) {
        commandsManager.run('setToolActiveToolbar', { toolName: 'WindowLevel' });
      }
      setStage(next);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : '工具切换失败。',
        error: true,
      });
    }
  }

  function choosePreset(value: string) {
    setPreset(value);
    if (value in presets) {
      setLower(String(presets[value][0]));
      setUpper(String(presets[value][1]));
    }
  }

  function changeRadius(value: string) {
    setRadius(value);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 99.5)
      commandsManager.run('setBrushSize', { value: parsed, toolNames: brushTools });
  }

  function activateEditor(kind: 'brush' | 'eraser' | 'threshold', nextShape = shape) {
    const range = kind === 'threshold' ? thresholdRange() : undefined;
    if (kind === 'threshold' && !range) return;
    const parsed = Number(radius);
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 99.5) {
      setFeedback({ message: '笔刷半径应为 0.5 至 99.5 mm。', error: true });
      return;
    }
    const name =
      kind === 'eraser'
        ? nextShape === 'sphere'
          ? 'SphereEraser'
          : 'CircularEraser'
        : kind === 'threshold'
          ? nextShape === 'sphere'
            ? 'ThresholdSphereBrush'
            : 'ThresholdCircularBrush'
          : nextShape === 'sphere'
            ? 'SphereBrush'
            : 'CircularBrush';
    commandsManager.run('setBrushSize', { value: parsed, toolNames: brushTools });
    if (kind === 'threshold')
      commandsManager.run('setThresholdRange', {
        value: [range.lower, range.upper],
        toolNames: ['ThresholdCircularBrush', 'ThresholdSphereBrush'],
      });
    run(
      'setToolActiveToolbar',
      { toolName: name },
      kind === 'eraser' ? '橡皮擦已启用。' : '画笔已启用，可在切片上编辑。'
    );
  }

  const editorKind = tool.includes('Eraser')
    ? 'eraser'
    : tool.startsWith('Threshold')
      ? 'threshold'
      : 'brush';
  const toolLabel =
    tool === 'MaskHuGrow'
      ? 'HU 灰度生长 · 点选预览'
      : tool === 'MaskRemoveRegion'
        ? '连通区域删除 · 点选预览'
        : tool === 'MaskRegionGrow'
          ? '区域生长 · 点选'
          : tool.includes('Eraser')
            ? '橡皮擦'
            : tool.startsWith('Threshold')
              ? '阈值笔刷'
              : tool.includes('Brush')
                ? '画笔'
                : tool === 'Pan'
                  ? '平移'
                  : tool === 'Zoom'
                    ? '缩放'
                    : '窗宽 / 窗位';

  return (
    <section
      aria-label="Mask 编辑"
      aria-busy={busy}
      className="mask-workbench"
    >
      <div className="mask-workbench-heading">
        <span className="mask-eyebrow">SEGMENTATION</span>
        <h3>分割工作台</h3>
        <p>选择 Mask，按步骤完成三维分割。</p>
      </div>
      <div
        className="mask-view-layouts"
        aria-label="视图布局快捷操作"
      >
        <button
          type="button"
          disabled={busy || !canReconstruct}
          onClick={() =>
            run(
              'setHangingProtocol',
              { protocolId: 'primaryAxial', reset: true },
              '已切换到轴向视图。'
            )
          }
        >
          轴向优先
        </button>
        <button
          type="button"
          disabled={busy || !canReconstruct}
          onClick={() =>
            run('setHangingProtocol', { protocolId: 'mpr', reset: true }, '已切换到三视图。')
          }
        >
          三视图
        </button>
        <button
          type="button"
          disabled={busy || !canReconstruct}
          onClick={() =>
            run(
              'setHangingProtocol',
              { protocolId: 'mprAnd3DVolumeViewport', reset: true },
              '已切换到三视图与三维预览。'
            )
          }
        >
          三视图 + 3D
        </button>
      </div>
      <nav
        className="mask-stage-nav"
        role="tablist"
        aria-label="标注工作流"
      >
        {stages.map(([id, label], index) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-label={label}
            aria-selected={stage === id}
            disabled={busy}
            onClick={() => selectStage(id)}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </nav>
      <p className="mask-active-strip">
        {enabled
          ? `当前 Mask：${segment.label}`
          : segment?.locked
            ? '当前 Mask 已锁定，请先解锁。'
            : !isSliceViewport
              ? '请先点击中间的 CT 切片窗口。三维模型预览不能执行这些二维编辑操作。'
              : '请先在左侧 Mask 列表中新建或选择一个 Mask。'}
      </p>
      <div
        hidden={stage !== 'threshold'}
        role="tabpanel"
        aria-label="阈值参数"
        className="mask-step-content"
      >
        <fieldset
          disabled={!enabled || busy}
          className="mb-3 space-y-2"
        >
          <legend className="mb-2 text-sm font-medium">Thresholding 阈值选区</legend>
          <label className="block text-xs text-gray-300">
            参考预设
            <select
              aria-label="阈值预设"
              value={preset}
              onChange={event => choosePreset(event.target.value)}
              className="mask-input"
            >
              <option value="custom">自定义范围</option>
              <option value="bone">骨组织 · 参考</option>
              <option value="soft">软组织 · 参考</option>
              <option value="lung">肺区低密度 · 参考</option>
            </select>
          </label>
          <label className="block text-xs text-gray-300">
            处理范围
            <select
              aria-label="阈值处理范围"
              value={scope}
              onChange={event => setScope(event.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white"
            >
              <option value="series">整组切片（默认）</option>
              <option value="slice">当前切片</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-300">
              下限
              <input
                aria-label="阈值下限"
                type="number"
                value={lower}
                onChange={event => {
                  setPreset('custom');
                  setLower(event.target.value);
                }}
                className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white disabled:opacity-40"
              />
            </label>
            <label className="text-xs text-gray-300">
              上限
              <input
                aria-label="阈值上限"
                type="number"
                value={upper}
                onChange={event => {
                  setPreset('custom');
                  setUpper(event.target.value);
                }}
                className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white disabled:opacity-40"
              />
            </label>
          </div>
          <div className="mask-hu-sliders">
            <input
              type="range"
              aria-label="阈值下限滑块"
              min={Math.min(-1024, Number(lower) || -1024)}
              max={Math.max(3071, Number(upper) || 3071)}
              value={Number(lower) || 0}
              onChange={event => {
                setPreset('custom');
                setLower(String(Math.min(Number(event.target.value), Number(upper))));
              }}
            />
            <input
              type="range"
              aria-label="阈值上限滑块"
              min={Math.min(-1024, Number(lower) || -1024)}
              max={Math.max(3071, Number(upper) || 3071)}
              value={Number(upper) || 0}
              onChange={event => {
                setPreset('custom');
                setUpper(String(Math.max(Number(event.target.value), Number(lower))));
              }}
            />
            <span>−1024 HU</span>
            <span>3071 HU</span>
          </div>
          <p className="text-xs text-gray-400">使用原始影像强度；CT 使用 HU，与窗宽窗位无关。</p>
          <label className="flex items-start gap-2 text-xs leading-5 text-gray-300">
            <input
              type="checkbox"
              checked={replace}
              onChange={event => setReplace(event.target.checked)}
              className="mt-1"
            />
            替换当前 Mask 在所选范围的选区；不勾选则追加
          </label>
          <MaskThresholdPreview
            servicesManager={servicesManager}
            viewportId={grid?.activeViewportId}
            displaySetId={displaySetId}
            lower={lower.trim() ? Number(lower) : NaN}
            upper={upper.trim() ? Number(upper) : NaN}
            replace={replace}
            enabled={enabled && stage === 'threshold'}
            preview={thresholdPreview}
            setPreview={setThresholdPreview}
            roi={roi}
            setRoi={value => sourceSeries && setMaskRoi(sourceSeries, value)}
            busy={busy}
          />
          <button
            type="button"
            onClick={threshold}
            disabled={!enabled || busy}
            className={`${buttonClass} mask-primary w-full`}
          >
            {scope === 'series' ? '应用阈值到整组切片' : '应用阈值到当前切片'}
          </button>
        </fieldset>
        <p className="mask-help">
          参考预设可按影像调整。设置完成后应用到 Mask；显示窗宽窗位不影响 HU 选区。
        </p>
      </div>
      <div
        hidden={stage !== 'grow'}
        role="tabpanel"
        aria-label="区域生长参数"
        className="mask-step-content"
      >
        <h4>Region Grow 区域生长</h4>
        <p className="mask-help">在阈值生成的 Mask 内点选目标，保留它的三维连通区域。</p>
        <button
          type="button"
          className={`${buttonClass} mb-2 w-full`}
          disabled={!enabled || busy}
          onClick={() => selectStage('edit')}
        >
          前往 HU 灰度生长 / 关键层插值
        </button>
        {roi && (
          <p className="mask-help">
            当前 ROI 限制已启用：只筛选 ROI 内区域，范围外标注保留。可在“阈值”页清除限制。
          </p>
        )}
        <button
          type="button"
          aria-pressed={regionArmed}
          disabled={!enabled || busy}
          className={`${buttonClass} mb-2 w-full ${regionArmed ? 'ring-primary ring-1' : ''}`}
          onClick={() =>
            run(
              'setToolActiveToolbar',
              { toolName: 'MaskRegionGrow' },
              '区域生长已启用：请在影像中点击当前 Mask 内要保留的目标。'
            )
          }
        >
          Region Grow 区域生长 · 点选保留
        </button>
        <p className="mb-3 text-xs leading-5 text-gray-400">
          保留与种子点三维连通的当前 Mask 区域，清除整组中其他不连通的部分；可撤销。
          {regionArmed && ' 点选模式已启用，切回上方画笔可继续精修。'}
        </p>
      </div>
      <div
        hidden={stage !== 'edit'}
        role="tabpanel"
        aria-label="画笔编辑参数"
        className="mask-step-content"
      >
        <h4>Edit Masks 手动编辑</h4>
        <div className="mask-editor-tools">
          <button
            type="button"
            aria-pressed={tool.includes('Brush') && !tool.startsWith('Threshold')}
            disabled={!enabled || busy}
            onClick={() => activateEditor('brush')}
          >
            画笔
          </button>
          <button
            type="button"
            aria-pressed={tool.includes('Eraser')}
            disabled={!enabled || busy}
            onClick={() => activateEditor('eraser')}
          >
            橡皮擦
          </button>
          <button
            type="button"
            aria-pressed={tool.startsWith('Threshold')}
            disabled={!enabled || busy}
            onClick={() => activateEditor('threshold')}
          >
            阈值笔刷
          </button>
        </div>
        <p className="mask-help">
          阈值笔刷使用“阈值”页的范围：{lower || '未填写'} 至 {upper || '未填写'}。
        </p>
        <label className="mask-control-label">形状与作用范围</label>
        <div
          className="mask-shape-tabs"
          role="tablist"
          aria-label="笔刷形状"
        >
          <button
            type="button"
            role="tab"
            aria-selected={shape === 'circle'}
            disabled={!enabled || busy}
            onClick={() => activateEditor(editorKind, 'circle')}
          >
            Circle
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={shape === 'sphere'}
            disabled={!enabled || busy}
            onClick={() => activateEditor(editorKind, 'sphere')}
          >
            Sphere
          </button>
        </div>
        <p className="mask-help">Circle 仅当前切片；Sphere 同时影响邻近切片，需要可重建序列。</p>
        <label className="mask-radius-control">
          半径（mm）
          <input
            aria-label="笔刷半径"
            type="number"
            min="0.5"
            max="99.5"
            step="0.5"
            value={radius}
            disabled={!enabled || busy}
            onChange={event => changeRadius(event.target.value)}
          />
        </label>
        <input
          className="mask-radius-slider"
          aria-label="笔刷半径滑块"
          type="range"
          min="0.5"
          max="99.5"
          step="0.5"
          value={Number(radius) || 3}
          disabled={!enabled || busy}
          onChange={event => changeRadius(event.target.value)}
        />
        <div className="mask-fill-section">
          <h4>Fill Holes 填洞</h4>
          <label className="mask-control-label">
            处理范围
            <select
              aria-label="填洞处理范围"
              value={fillScope}
              disabled={!enabled || busy}
              onChange={event => setFillScope(event.target.value)}
              className="mask-input"
            >
              <option value="slice">当前切片</option>
              <option value="series">整组逐片</option>
            </select>
          </label>
          <button
            type="button"
            className={`${buttonClass} w-full`}
            disabled={!enabled || busy}
            onClick={() => run(fillScope === 'series' ? 'fillMaskHolesSeries' : 'fillMaskHoles')}
          >
            {fillScope === 'series' ? 'Fill Holes 逐片填洞（整组）' : 'Fill Holes 填洞（单片）'}
          </button>
          <p className="mask-help">填充每张切片中封闭的空白，不覆盖其他 Mask。该操作可撤销。</p>
        </div>
        <MaskRefinementPanel
          servicesManager={servicesManager}
          commandsManager={commandsManager}
          viewportId={grid?.activeViewportId}
          segmentationId={active?.segmentationId}
          segmentIndex={segment?.segmentIndex}
          enabled={enabled && canReconstruct}
          busy={busy}
          visible={stage === 'edit'}
          roi={roi}
          toolName={tool}
          run={run}
        />
      </div>
      <div
        hidden={stage !== 'split'}
        role="tabpanel"
        aria-label="拆分参数"
        className="mask-step-content"
      >
        <h4>Split Mask 拆分</h4>
        {splitScope === 'series' && (
          <div className="mb-3 space-y-2">
            <span className="text-xs text-gray-300">最小区域快捷设置</span>
            <div className="flex gap-2">
              {[1, 100, 1000].map(value => (
                <button
                  type="button"
                  key={value}
                  disabled={!enabled || busy}
                  aria-label={'最小区域 ' + value + ' 体素'}
                  aria-pressed={Number(minimumVoxels) === value}
                  className={buttonClass}
                  onClick={() => {
                    discardSplit();
                    setMinimumVoxels(String(value));
                  }}
                >
                  {value.toLocaleString()} 体素
                </button>
              ))}
            </div>
            <p className="mask-help">
              真实影像可能含大量小碎片。区域过多时可先试 1,000 体素；小区域仍保留在原 Mask。
            </p>
          </div>
        )}
        <div className="mb-2 grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-300">
            拆分范围
            <select
              aria-label="拆分处理范围"
              value={splitScope}
              disabled={!enabled || busy}
              onChange={event => {
                discardSplit();
                setSplitScope(event.target.value);
              }}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-xs text-white"
            >
              <option value="series">整组（三维）</option>
              <option value="slice">当前切片</option>
            </select>
          </label>
          {splitScope === 'series' && (
            <label className="text-xs text-gray-300">
              最小区域（体素）
              <input
                aria-label="拆分最小区域体素数"
                type="number"
                min="1"
                max="1000000"
                value={minimumVoxels}
                disabled={!enabled || busy}
                onChange={event => {
                  discardSplit();
                  setMinimumVoxels(event.target.value);
                }}
                className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-xs text-white"
              />
            </label>
          )}
        </div>
        <div>
          <button
            type="button"
            disabled={!enabled || busy}
            onClick={() => (splitScope === 'series' ? analyzeSplit() : run('splitMaskComponents'))}
            className={`${buttonClass} mask-primary w-full`}
          >
            {splitScope === 'series' ? 'Split Mask 三维预览' : 'Split Mask 拆分（单片）'}
          </button>
        </div>
        <p className="mt-2 text-xs leading-5 text-gray-400">
          {splitScope === 'series'
            ? '一次最多拆分 32 个三维连通区域。小于最小体素数的区域留在原 Mask，不会删除；仍粘连的结构需先切断。'
            : '单片拆分仅处理当前切片。拆分前先用橡皮擦切断连接，再将独立区域分为不同 Mask。'}
        </p>
        {splitPreview && (
          <div
            role="region"
            aria-label="三维拆分预览"
            className="mt-3 rounded border border-gray-600 p-2"
          >
            <p className="mb-2 text-xs text-gray-300">
              {splitPreview.sliceCount} 张切片 · {splitPreview.components.length} 个可拆分区域 ·
              尚未修改 Mask
            </p>
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="py-1">区域</th>
                    <th className="py-1">体素 / 体积 mm³</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {splitPreview.components.map((component, index) => (
                    <tr key={component.code}>
                      <td className="py-1">
                        {index + 1}
                        {component.keepOriginal ? '（原 Mask）' : '（新 Mask）'}
                      </td>
                      <td className="py-1">
                        {component.voxelCount.toLocaleString()}
                        <br />
                        {component.volumeMm3 === null
                          ? '—'
                          : component.volumeMm3.toLocaleString(undefined, {
                              maximumFractionDigits: 1,
                            })}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={!enabled || busy}
                          className="text-primary px-1"
                          onClick={() =>
                            run('locateMaskSplitRegion', {
                              previewId: splitPreview.id,
                              code: component.code,
                            })
                          }
                        >
                          定位
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {splitPreview.ignoredRegions > 0 && (
              <p className="mt-2 text-xs text-gray-400">
                {splitPreview.ignoredRegions} 个小区域（{splitPreview.ignoredVoxels} 体素）保留在原
                Mask。
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={!enabled || busy || splitPreview.components.length < 2}
                className={buttonClass}
                onClick={async () => {
                  await run('applyMaskSplit', { previewId: splitPreview.id });
                  setSplitPreview(undefined);
                }}
              >
                应用三维拆分
              </button>
              <button
                type="button"
                disabled={busy}
                className={buttonClass}
                onClick={() => {
                  discardSplit();
                  setFeedback({ message: '已关闭预览，Mask 未改变。', error: false });
                }}
              >
                关闭预览
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="mask-workbench-footer">
        <MaskProgressPanel
          busy={busy}
          run={run}
        />
        <div className="mask-current-tool">
          当前工具：<strong>{toolLabel}</strong>
        </div>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !active || !segment}
            onClick={() => run('isolateCurrentMask')}
          >
            只显示当前 Mask
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={
              busy ||
              !active ||
              !commandsManager.run('hasMaskVisibilitySnapshot', {
                segmentationId: active?.segmentationId,
              })
            }
            onClick={() => run('restoreMaskVisibility')}
          >
            恢复之前显隐
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => run('undo')}
          >
            撤销
          </button>
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => run('redo')}
          >
            重做
          </button>
        </div>
        <MaskHistoryPanel />
        <div className="mask-project-actions mt-3 rounded border border-gray-600 p-2">
          <strong className="text-xs text-gray-200">完整项目 · 当前序列</strong>
          <button
            type="button"
            className={`${buttonClass} mt-2 w-full`}
            disabled={busy || !isSliceViewport || !active?.representationData.Labelmap}
            onClick={() => run('saveMaskWorkspace')}
          >
            保存整个项目
          </button>
          <input
            ref={workspaceInput}
            type="file"
            accept=".ohifproject"
            aria-label="载入完整项目文件"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) run('loadMaskWorkspace', { file });
            }}
          />
          <button
            type="button"
            className={`${buttonClass} mt-2 w-full`}
            disabled={busy || !isSliceViewport || !displaySetId}
            onClick={() => workspaceInput.current?.click()}
          >
            载入整个项目
          </button>
          <p className="mask-help">
            一次保存此序列的所有标注集、重叠 Mask 与 ROI。载入前先导入原始 DICOM；原有结果保留。
          </p>
        </div>
        <button
          type="button"
          className={`${buttonClass} mt-3 w-full`}
          disabled={busy || !isSliceViewport || !active?.representationData.Labelmap}
          onClick={() => run('saveMaskProject')}
        >
          保存标注文件
        </button>
        <input
          ref={projectInput}
          type="file"
          accept=".ohifmask"
          aria-label="载入本地标注文件"
          className="hidden"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) run('loadMaskProject', { file });
          }}
        />
        <button
          type="button"
          className={`${buttonClass} mt-2 w-full`}
          disabled={busy || !isSliceViewport || !displaySetId}
          onClick={() => projectInput.current?.click()}
        >
          载入标注文件
        </button>
        <p className="mask-help">
          保存当前标注集的选区、空 Mask、名称、颜色、显隐、锁定和外观。继续编辑时，先导入同一组完整
          DICOM，再载入 .ohifmask 文件；将创建新标注集。此文件不含原始影像或撤销记录。
        </p>
        <button
          type="button"
          className={`${buttonClass} mt-3 w-full`}
          disabled={busy || !active?.representationData.Labelmap}
          onClick={() => run('exportMaskSegmentation', { segmentationId: active.segmentationId })}
        >
          导出 DICOM SEG
        </button>
        <p className="mask-help">
          导出整个标注集的非空选区，包含隐藏或锁定的 Mask。请保留原始
          CT；显隐和锁定设置不写入此文件。
        </p>
        {feedback && (
          <p
            role={feedback.error ? 'alert' : 'status'}
            aria-live="polite"
            className={`mt-3 text-xs leading-5 ${feedback.error ? 'text-red-300' : 'text-green-300'}`}
          >
            {feedback.message}
          </p>
        )}
        {busy && <p className="mt-2 text-xs text-gray-300">处理中，请稍候…</p>}
      </div>
    </section>
  );
}

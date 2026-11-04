import React, { useEffect, useState } from 'react';
import useTaskReadOnly from '../hooks/useTaskReadOnly';
import { useSystem } from '@ohif/core';
import { useViewportGrid } from '@ohif/ui-next';
import { StackViewport, VolumeViewport, eventTarget } from '@cornerstonejs/core';
import { Enums as ToolEnums } from '@cornerstonejs/tools';
import {
  MASK_OPERATION_EVENT,
  MaskOperationStatus,
} from '../utils/maskEditing/maskOperationEvents';
import { useActiveViewportSegmentationRepresentations } from '../hooks/useActiveViewportSegmentationRepresentations';
import type { MaskSplitPreview } from '../utils/maskEditing/splitMaskTypes';

/** Extra mask operations complement OHIF's existing brush, eraser and threshold brushes. */
export default function MaskEditingTools() {
  const { servicesManager, commandsManager } = useSystem();
  const { segmentationService, cornerstoneViewportService } = servicesManager.services;
  const [grid] = useViewportGrid();
  const readOnly = useTaskReadOnly();
  const { segmentationsWithRepresentations } = useActiveViewportSegmentationRepresentations();
  const [lower, setLower] = useState('150');
  const [upper, setUpper] = useState('2000');
  const [replace, setReplace] = useState(true);
  const [scope, setScope] = useState('series');
  const [busy, setBusy] = useState(false);
  const [regionArmed, setRegionArmed] = useState(false);
  const [splitScope, setSplitScope] = useState('series');
  const [minimumVoxels, setMinimumVoxels] = useState('1');
  const [splitPreview, setSplitPreview] = useState<MaskSplitPreview>();
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const active = segmentationService.getActiveSegmentation(grid?.activeViewportId);
  const segment = segmentationService.getActiveSegment(grid?.activeViewportId);
  const viewport = cornerstoneViewportService.getCornerstoneViewport(grid?.activeViewportId);
  const isSliceViewport = viewport instanceof StackViewport || viewport instanceof VolumeViewport;
  const enabled = Boolean(
    !readOnly &&
      isSliceViewport &&
      active?.representationData.Labelmap &&
      segment &&
      !segment.locked &&
      segmentationsWithRepresentations.some(
        item => item.segmentation.segmentationId === active.segmentationId
      )
  );
  const buttonClass =
    'rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40';

  useEffect(() => {
    const onStatus = (event: CustomEvent<MaskOperationStatus>) => {
      const { phase, message } = event.detail;
      setBusy(phase === 'start' || phase === 'progress');
      setFeedback({ message, error: phase === 'error' });
    };
    eventTarget.addEventListener(MASK_OPERATION_EVENT, onStatus);
    const onTool = (event: CustomEvent) =>
      setRegionArmed(event.detail.toolName === 'MaskRegionGrow');
    eventTarget.addEventListener(ToolEnums.Events.TOOL_ACTIVATED, onTool);
    return () => {
      eventTarget.removeEventListener(MASK_OPERATION_EVENT, onStatus);
      eventTarget.removeEventListener(ToolEnums.Events.TOOL_ACTIVATED, onTool);
    };
  }, []);

  useEffect(() => {
    setSplitPreview(undefined);
    commandsManager.run('discardMaskSplitPreview');
  }, [active?.segmentationId, segment?.segmentIndex, commandsManager]);

  async function run(commandName: string, options = {}, successMessage = '操作完成。') {
    if (busy) return;
    setBusy(true);
    try {
      const result = await commandsManager.run(commandName, options);
      const message =
        result && typeof result === 'object' && 'message' in result
          ? String(result.message)
          : successMessage;
      setFeedback({ message, error: false });
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

  function threshold() {
    if (!lower.trim() || !upper.trim()) {
      setFeedback({ message: '请填写阈值上下限。', error: true });
      return;
    }
    run(scope === 'series' ? 'thresholdMaskSeries' : 'thresholdMaskSlice', {
      lower: Number(lower),
      upper: Number(upper),
      replace,
    });
  }

  return (
    <section
      aria-label="Mask 编辑"
      aria-busy={busy}
      className="border-b border-gray-700 px-3 py-4 text-white"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Mask 编辑</h3>
        <span className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300">切片与整组操作</span>
      </div>
      <p className="mb-3 text-xs leading-5 text-gray-300">
        {enabled
          ? `当前 Mask：${segment.label}`
          : segment?.locked
            ? '当前 Mask 已锁定，请先解锁。'
            : !isSliceViewport
              ? '请先点击中间的 CT 切片窗口。三维模型预览不能执行这些二维编辑操作。'
              : '请在下方新建分割并选择一个 Mask。画笔和橡皮擦位于上方工具箱。'}
      </p>

      <fieldset
        disabled={!enabled || busy}
        className="mb-3 space-y-2"
      >
        <legend className="mb-2 text-sm font-medium">Thresholding 阈值选区</legend>
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
              onChange={event => setLower(event.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white disabled:opacity-40"
            />
          </label>
          <label className="text-xs text-gray-300">
            上限
            <input
              aria-label="阈值上限"
              type="number"
              value={upper}
              onChange={event => setUpper(event.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white disabled:opacity-40"
            />
          </label>
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
        <button
          type="button"
          onClick={threshold}
          disabled={!enabled || busy}
          className={`${buttonClass} w-full`}
        >
          {scope === 'series' ? '应用阈值到整组切片' : '应用阈值到当前切片'}
        </button>
      </fieldset>

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
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!enabled || busy}
          onClick={() => run('fillMaskHoles')}
          className={buttonClass}
        >
          Fill Holes 填洞（单片）
        </button>
        <button
          type="button"
          disabled={!enabled || busy}
          onClick={() => (splitScope === 'series' ? analyzeSplit() : run('splitMaskComponents'))}
          className={buttonClass}
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
    </section>
  );
}

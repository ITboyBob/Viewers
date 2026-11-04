import { utilities, eventTarget } from '@cornerstonejs/core';
export const MASK_HISTORY_EVENT = 'OHIF_MASK_HISTORY_CHANGED';
export type MaskHistoryDetail = {
  title: string;
  segmentationId?: string;
  segmentIndex?: number;
  target?: string;
  parameters?: Record<string, unknown>;
  changed?: number;
  added?: number;
  removed?: number;
};
type Detail = MaskHistoryDetail & { id: string; time: string };
const details = new WeakMap<object, Detail>();
let next = 0;
let describeNative: (memo: any) => MaskHistoryDetail = () => ({ title: '原生工具编辑' });
let targetAvailable: (detail: MaskHistoryDetail) => boolean = () => true;
export function describeHistoryMemo<T extends object>(memo: T, detail: MaskHistoryDetail): T {
  details.set(memo, { ...detail, id: `mask-history-${++next}`, time: new Date().toISOString() });
  return memo;
}
function detailFor(memo: any): Detail {
  if (!details.has(memo)) describeHistoryMemo(memo, describeNative(memo));
  return details.get(memo);
}
/** Read the SDK ring directly so eviction, groups and discarded redo entries cannot drift. */
export function readMaskHistory(history: any = utilities.HistoryMemo.DefaultHistoryMemo) {
  const entries = [];
  let nextUndo: Detail & { available?: boolean }, nextRedo: Detail & { available?: boolean };
  const undo = Math.max(0, history.undoAvailable || 0),
    redo = Math.max(0, history.redoAvailable || 0),
    size = history.size || 50;
  for (let offset = -undo + 1; offset <= redo; offset++) {
    const item = history.ring?.[(history.position + offset + size * 2) % size];
    if (!item) continue;
    const memos = Array.isArray(item) ? item : [item];
    if (!memos.length) continue;
    const values = memos.map(detailFor);
    const value =
      values.length === 1
        ? values[0]
        : {
            ...values[0],
            title: `组合编辑（${values.length} 项）`,
            target: new Set(values.map(v => v.target)).size === 1 ? values[0].target : '多个目标',
            changed: undefined,
            parameters: undefined,
          };
    const entry = {
      ...value,
      available: values.every(targetAvailable),
      state: offset <= 0 ? 'applied' : 'undone',
    };
    entries.push(entry);
    if (offset === 0) nextUndo = entry;
    if (offset === 1) nextRedo = entry;
  }
  return {
    entries: entries.reverse(),
    nextUndo,
    nextRedo,
    canUndo: Boolean(
      history.canUndo && !history.isRecordingGrouped && nextUndo?.available !== false
    ),
    canRedo: Boolean(
      history.canRedo && !history.isRecordingGrouped && nextRedo?.available !== false
    ),
  };
}
export function assertMaskHistoryTarget(
  isRedo = false,
  history: any = utilities.HistoryMemo.DefaultHistoryMemo
) {
  if (history.isRecordingGrouped) throw new Error('当前笔画尚未结束，请松开鼠标后再撤销或重做。');
  const state = readMaskHistory(history),
    next = isRedo ? state.nextRedo : state.nextUndo;
  if (next?.available === false)
    throw new Error('这条编辑的目标 Mask 已被删除，无法恢复；未改动当前选区。');
}
export function trackMaskHistory(
  servicesManager,
  history: any = utilities.HistoryMemo.DefaultHistoryMemo
) {
  const { segmentationService, viewportGridService, toolGroupService } = servicesManager.services;
  const previousDescribe = describeNative;
  const previousAvailable = targetAvailable;
  targetAvailable = detail => {
    if (!detail.segmentationId) return true;
    const current = segmentationService.getSegmentation(detail.segmentationId);
    return Boolean(
      current && (detail.segmentIndex === undefined || current.segments?.[detail.segmentIndex])
    );
  };
  describeNative = memo => {
    const viewportId = viewportGridService.getActiveViewportId(),
      current = segmentationService.getActiveSegmentation(viewportId);
    const id = memo.segmentationId || current?.segmentationId;
    const collection = id && segmentationService.getSegmentation(id);
    const segment = collection?.segments
      ? (Object.values(collection.segments).find((value: any) => value.active) as any)
      : segmentationService.getActiveSegment(viewportId);
    const group = toolGroupService?.getToolGroupForViewport(viewportId);
    const tool = group?.getActivePrimaryMouseButtonTool() || '';
    const radius = group?.getToolConfiguration?.(tool)?.brushSize;
    return {
      title:
        memo.operationType === 'labelmap'
          ? tool.includes('Eraser')
            ? '橡皮擦'
            : tool.includes('Brush')
              ? '画笔'
              : '原生 Mask 编辑'
          : '测量或原生编辑',
      segmentationId: memo.operationType === 'labelmap' ? id : undefined,
      segmentIndex: memo.operationType === 'labelmap' ? segment?.segmentIndex : undefined,
      parameters:
        memo.operationType === 'labelmap' && Number.isFinite(radius)
          ? { '半径 mm': radius }
          : undefined,
      target:
        id && memo.operationType === 'labelmap'
          ? `${segmentationService.getSegmentation(id)?.label || '标注集'} / ${segment?.label || 'Mask'}`
          : undefined,
    };
  };
  // Memos reference live labelmaps; a new mode has new image objects and starts a new editing session.
  history.size = history.size;
  const notify = () => eventTarget.dispatchEvent(new CustomEvent(MASK_HISTORY_EVENT));
  const originals = new Map<string, Function>();
  for (const name of ['push', 'undo', 'redo', 'endGroupRecording']) {
    const original = history[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    history[name] = function (...args) {
      try {
        const result = original.apply(this, args);
        if (name === 'push' && result) detailFor(result);
        return result;
      } finally {
        notify();
      }
    };
  }
  notify();
  return () => {
    originals.forEach((original, name) => {
      history[name] = original;
    });
    describeNative = previousDescribe;
    targetAvailable = previousAvailable;
    notify();
  };
}

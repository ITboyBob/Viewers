import React, { useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
import { useViewportGrid } from '@ohif/ui-next';
import { eventTarget, metaData } from '@cornerstonejs/core';
import { maskProgress, MASK_PROGRESS_EVENT } from '../utils/maskEditing/maskProgress';
import { listMaskDrafts, MaskDraft } from '../utils/maskEditing/maskDraftStorage';

export default function MaskProgressPanel({ busy, run }) {
  const { servicesManager } = useSystem();
  const { viewportGridService, displaySetService, segmentationService } = servicesManager.services;
  const [grid] = useViewportGrid();
  const [, update] = useState(0);
  const [drafts, setDrafts] = useState<MaskDraft[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const id = segmentationService.getActiveSegmentation(grid?.activeViewportId)?.segmentationId;
  const displaySetId = viewportGridService.getDisplaySetsUIDsForViewport(
    grid?.activeViewportId
  )?.[0];
  const imageId = displaySetId && displaySetService.getDisplaySetByUID(displaySetId)?.imageIds?.[0];
  const series = imageId && metaData.get('instance', imageId)?.SeriesInstanceUID;
  const progress = id && maskProgress.get(id);
  const otherDirty = maskProgress.dirtyIds().filter(other => other !== id).length;
  useEffect(() => {
    const refresh = () => update(value => value + 1);
    eventTarget.addEventListener(MASK_PROGRESS_EVENT, refresh);
    return () => eventTarget.removeEventListener(MASK_PROGRESS_EVENT, refresh);
  }, []);
  useEffect(() => {
    let stopped = false;
    setDrafts([]);
    setSelected('');
    async function refresh() {
      if (!series) return;
      try {
        const values = await listMaskDrafts(series);
        if (!stopped) {
          setDrafts(values);
          setError('');
          setSelected(current =>
            values.some(item => item.key === current) ? current : values[0]?.key || ''
          );
        }
      } catch {
        if (!stopped) setError('无法读取本地暂存，请使用标注文件保存和恢复。');
      }
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [series]);
  return (
    <div
      className="mt-2 border-b border-gray-700 pb-3 text-xs leading-5"
      aria-label="标注保存状态"
    >
      <p
        data-testid="mask-save-state"
        aria-live="polite"
        className={id && maskProgress.dirty(id) ? 'text-amber-300' : 'text-gray-300'}
      >
        {id
          ? maskProgress.dirty(id)
            ? '有未保存到文件的修改'
            : '标注已保存到文件'
          : '尚未创建标注集'}
      </p>
    {otherDirty > 0 && <p className="text-amber-300">另有 {otherDirty} 个标注集未保存到文件</p>}
      {progress?.draftAt && (
        <p className="text-gray-400">
          最近本地暂存：{new Date(progress.draftAt).toLocaleTimeString()}
        </p>
      )}
      {(progress?.error || error) && <p className="text-red-300">{progress?.error || error}</p>}
      {drafts.length > 0 && (
        <>
          <label className="mt-2 block text-gray-300">
            此序列的本地暂存
            <select
              aria-label="选择本地暂存"
              value={selected}
              onChange={event => setSelected(event.target.value)}
              className="mask-input mt-1"
            >
              {drafts.map(draft => (
                <option
                  key={draft.key}
                  value={draft.key}
                >
                  {draft.label} · {new Date(draft.savedAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="mask-action mt-2 w-full"
            disabled={busy || !selected}
            onClick={() => run('restoreMaskDraft', { key: selected })}
          >
            恢复本地暂存为新标注集
          </button>
        </>
      )}
      <p className="mt-1 text-gray-400">
        停止编辑约 5 秒后自动暂存。暂存可能被浏览器清理，请定期保存标注文件；恢复前需导入原始
        DICOM。
      </p>
    </div>
  );
}

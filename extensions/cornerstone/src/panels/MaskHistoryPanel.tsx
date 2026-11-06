import React, { useEffect, useState } from 'react';
import { eventTarget } from '@cornerstonejs/core';
import { MASK_HISTORY_EVENT, readMaskHistory } from '../utils/maskEditing/maskHistory';
export default function MaskHistoryPanel() {
  const [, refresh] = useState(0);
  useEffect(() => {
    const onChange = () => refresh(v => v + 1);
    eventTarget.addEventListener(MASK_HISTORY_EVENT, onChange);
    return () => eventTarget.removeEventListener(MASK_HISTORY_EVENT, onChange);
  }, []);
  const history = readMaskHistory();
  return (
    <div
      className="mt-3 text-xs leading-5 text-gray-300"
      aria-label="编辑历史"
    >
      <p data-testid="next-undo">
        下一步撤销：
        {history.nextUndo
          ? `${history.nextUndo.title} · ${history.nextUndo.target || '当前影像'}`
          : '无'}
      </p>
      {history.nextRedo && <p>下一步重做：{history.nextRedo.title}</p>}
      <details className="mask-tool-section mt-2">
        <summary>操作历史（{history.entries.length}）</summary>
        <p className="mask-help">
          只列出本次会话仍可撤销 / 重做的编辑。新操作会丢弃已撤销分支；保存、预览和取消不占历史。
        </p>
        <ol
          className="max-h-64 space-y-2 overflow-auto"
          data-testid="mask-history-entries"
        >
          {history.entries.map(item => (
            <li
              key={item.id}
              className="rounded border border-gray-700 p-2"
              data-state={item.state}
            >
              <strong>{item.title}</strong> · {item.state === 'applied' ? '已应用' : '已撤销'}
              {!item.available && (
                <p className="text-amber-300">目标 Mask 已删除，不能恢复此记录。</p>
              )}
              <p>
                {item.target || '原生影像工具'} · {new Date(item.time).toLocaleTimeString()}
              </p>
              {item.changed !== undefined && <p>更改 {item.changed.toLocaleString()} 个体素</p>}
              {item.added !== undefined && (
                <p>
                  新增 {item.added.toLocaleString()} / 删除 {item.removed?.toLocaleString() || 0}
                </p>
              )}
              {item.parameters && (
                <p className="break-words text-gray-400">
                  {Object.entries(item.parameters)
                    .map(
                      ([key, value]) =>
                        `${key}：${Array.isArray(value) ? value.join(', ') : String(value)}`
                    )
                    .join('；')}
                </p>
              )}
            </li>
          ))}
        </ol>
        {!history.entries.length && <p className="mask-help">尚无可撤销的编辑。</p>}
      </details>
    </div>
  );
}

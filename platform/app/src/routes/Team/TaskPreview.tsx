import React, { useEffect, useState } from 'react';
import type { BusinessServices, ReadonlyPreviewResult } from '@ohif/core';
import { loadReadonlyPreview } from '../../business/ReadonlyPreviewLoader';
import { composeReadonlyPreview } from './composeReadonlyPreview';

export default function TaskPreview({
  taskId,
  services,
  accountUid,
  refreshKey = 0,
  permissionKey = '',
  onOpen,
  opening = false,
}: {
  taskId: string;
  services: BusinessServices;
  accountUid: string;
  refreshKey?: number;
  permissionKey?: string;
  onOpen?(): void;
  opening?: boolean;
}) {
  const [attempt, retry] = useState(0);
  const identity = JSON.stringify([accountUid, taskId, refreshKey, permissionKey, attempt]);
  const [state, setState] = useState<{
    key: string;
    result?: ReadonlyPreviewResult;
    error?: string;
  }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let result: ReadonlyPreviewResult | undefined;
    void loadReadonlyPreview(
      services.api,
      accountUid,
      taskId,
      controller.signal,
      composeReadonlyPreview
    )
      .then(value => {
        result = value;
        if (alive) setState({ key: identity, result: value });
        else value.release?.();
      })
      .catch(failure => {
        if (alive)
          setState({
            key: identity,
            error: failure instanceof Error ? failure.message : '预览读取失败',
          });
      });
    return () => {
      alive = false;
      controller.abort();
      result?.release?.();
    };
  }, [identity, services]);
  if (state.key === identity && state.result?.image) {
    const image = (
      <img
        src={state.result.image}
        alt="任务来源影像首帧"
      />
    );
    return onOpen ? (
      <button
        type="button"
        className="team-preview-open"
        onClick={onOpen}
        disabled={opening}
        aria-label="打开任务影像"
      >
        {image}
      </button>
    ) : (
      image
    );
  }
  if (state.key === identity && state.error)
    return (
      <div role="alert">
        <span>影像预览暂不可用</span>
        <p>{state.error}</p>
        <button
          type="button"
          onClick={() => retry(n => n + 1)}
        >
          重试预览
        </button>
      </div>
    );
  return <span role="status">正在验证影像与成果…</span>;
}

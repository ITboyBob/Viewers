import React, { useEffect, useRef, useState } from 'react';
import { useHref } from 'react-router-dom';
import { sharedViewPath } from '../localCollaboration/sharedEntry';

export default function SharedLinkButton({ taskId }: { taskId: string }) {
  const path = useHref(sharedViewPath(taskId));
  const address = new URL(path, window.location.origin).href;
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = async () => {
    setStatus('copying');
    try {
      await navigator.clipboard.writeText(address);
      if (mounted.current) {
        setStatus('copied');
      }
    } catch (_error) {
      if (mounted.current) {
        setStatus('failed');
      }
    }
  };
  return (
    <div className="relative text-xs">
      <button
        type="button"
        className="text-primary px-2 text-xs"
        disabled={status === 'copying'}
        onClick={copy}
      >
        共享链接
      </button>
      {status === 'copying' && <span role="status">正在复制…</span>}
      {status === 'copied' && <span role="status">已复制</span>}
      {status === 'failed' && (
        <div
          role="alert"
          className="absolute right-0 top-full z-50 w-80 rounded bg-black p-3 text-white"
        >
          复制失败，请手动复制下方链接，在 B 窗口打开。
          <input
            className="mt-2 w-full border border-current bg-black p-2"
            aria-label="共享地址（手动复制）"
            readOnly
            value={address}
            onFocus={event => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}

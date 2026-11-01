import React, { useLayoutEffect, useRef, useState } from 'react';
import type { LocalParticipantSnapshot, TaskColorRegistrySnapshot } from '@ohif/core';
import { isCursorCanvasPointVisible } from './remoteCursorProjection';
import type { CursorCanvasPoint, CursorViewportSize } from './remoteCursorProjection';
import './RemoteCursorOverlay.css';

export type RemoteCursorDisplay = Readonly<{
  participant: Pick<LocalParticipantSnapshot, 'participant_id' | 'user' | 'color_key'>;
  point: CursorCanvasPoint;
}>;

export type RemoteCursorOverlayProps = Readonly<{
  selfParticipantId: string;
  cursors: readonly RemoteCursorDisplay[];
  colorRegistry: TaskColorRegistrySnapshot;
  viewportSize: CursorViewportSize;
}>;

export type CursorLabelLayout = Readonly<{
  left: number;
  top: number;
  width: number;
  textWidth: number;
}>;

export function layoutRemoteCursorLabel(
  point: CursorCanvasPoint,
  viewportSize: CursorViewportSize,
  textWidth: number
): CursorLabelLayout | null {
  if (
    !isCursorCanvasPointVisible(point, viewportSize) ||
    !Number.isFinite(textWidth) ||
    textWidth < 0 ||
    viewportSize.width < 20 ||
    viewportSize.height < 30
  ) {
    return null;
  }

  const width = Math.min(textWidth + 12, 132, viewportSize.width - 8);
  const right = point.x + 24;
  const below = point.y + 16;
  const preferredLeft = right + width <= viewportSize.width - 4 ? right : point.x - 24 - width;
  const preferredTop = below + 22 <= viewportSize.height - 4 ? below : point.y - 16 - 22;
  return {
    left: Math.min(Math.max(preferredLeft, 4), viewportSize.width - 4 - width),
    top: Math.min(Math.max(preferredTop, 4), viewportSize.height - 4 - 22),
    width,
    textWidth: width - 12,
  };
}

function RemoteCursorMark({
  cursor,
  color,
  viewportSize,
}: {
  cursor: RemoteCursorDisplay;
  color: string;
  viewportSize: CursorViewportSize;
}): JSX.Element | null {
  const { participant, point } = cursor;
  const username = participant.user.username;
  const text = useRef<HTMLSpanElement>(null);
  const [textWidth, setTextWidth] = useState(120);
  const layout = layoutRemoteCursorLabel(point, viewportSize, textWidth);
  const visible = layout !== null;

  useLayoutEffect(() => {
    const element = text.current;
    if (!element) {
      return;
    }
    const measure = () => {
      // scrollWidth 包含被省略部分；无布局引擎时保留安全的最大宽度。
      const width = element.scrollWidth;
      if (Number.isFinite(width) && width > 0) {
        setTextWidth(Math.min(120, width));
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    const fonts = document.fonts;
    fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
    };
  }, [username, visible]);

  if (!layout) {
    return null;
  }

  return (
    <div
      className="remote-cursor-mark"
      data-remote-cursor={participant.participant_id}
      style={{ left: point.x, top: point.y }}
    >
      <svg
        className="remote-cursor-arrow"
        width="20"
        height="24"
        viewBox="0 0 20 24"
        style={{ left: -0.75, top: -0.75 }}
      >
        <path
          d="M 0.75 0.75 L 19.25 12.25 L 11.75 13.25 L 15.75 21.75 L 12.25 23.25 L 8.25 14.75 L 3.25 20.25 Z"
          fill={color}
          stroke="#FFFFFF"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <div
        className="remote-cursor-label"
        data-cursor-label=""
        style={{
          left: layout.left - point.x,
          top: layout.top - point.y,
          width: layout.width,
          backgroundColor: color,
        }}
      >
        <span
          className="remote-cursor-username"
          data-cursor-username=""
          ref={text}
          style={{ maxWidth: layout.textWidth }}
        >
          {username}
        </span>
      </div>
    </div>
  );
}

/** 仅接收已通过参与协议和色表校验的数据，不承担握手或任务写入。 */
export default function RemoteCursorOverlay({
  selfParticipantId,
  cursors,
  colorRegistry,
  viewportSize,
}: RemoteCursorOverlayProps): JSX.Element | null {
  if (!isCursorCanvasPointVisible({ x: 0, y: 0 }, viewportSize)) {
    return null;
  }
  return (
    <div
      className="remote-cursor-overlay"
      aria-hidden="true"
      style={{ width: viewportSize.width, height: viewportSize.height }}
    >
      {cursors.map(cursor => {
        const { participant } = cursor;
        if (participant.participant_id === selfParticipantId) {
          return null;
        }
        const assignment = colorRegistry.assignments.find(
          value => value.uid === participant.user.uid
        );
        if (!assignment || assignment.color_key !== participant.color_key) {
          return null;
        }
        return (
          <RemoteCursorMark
            key={participant.participant_id}
            cursor={cursor}
            color={assignment.color_value}
            viewportSize={viewportSize}
          />
        );
      })}
    </div>
  );
}

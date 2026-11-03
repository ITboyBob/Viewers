import React, { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRightIcon, HomeIcon } from '@radix-ui/react-icons';

// 本地展示数据，不代表会话中的真实团队，也不参与任务归属或团队切换。
const placeholderTeams = ['团队 A', '团队 B'];

export default function TeamListOverlay({
  contentRef,
  suppressCloseFocusRef,
}: {
  contentRef: React.RefObject<HTMLDivElement>;
  suppressCloseFocusRef: React.RefObject<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    // 窄屏两侧均容不下完整菜单时，改在入口下方展开，不压缩文字或溢出视口。
    const media = window.matchMedia?.('(max-width: 560px)');
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return (
    <Popover.Root
      open={open}
      onOpenChange={setOpen}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          className="business-member-team-trigger"
          onKeyDown={event => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <HomeIcon aria-hidden="true" />
          查看你的团队
          <ChevronRightIcon
            className="business-team-chevron"
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          role="menu"
          aria-label="团队列表（占位）"
          className="business-team-panel shadow-md"
          side={compact ? 'bottom' : 'right'}
          align="start"
          sideOffset={compact ? 8 : 24}
          collisionPadding={8}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setOpen(false);
            }
          }}
          onKeyPress={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          onCloseAutoFocus={event => {
            if (suppressCloseFocusRef.current) event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="business-team-heading">你的团队</div>
          <p className="business-team-hint">示例团队，仅供界面预览</p>
          {placeholderTeams.map(name => (
            <button
              key={name}
              type="button"
              role="menuitem"
              disabled
              aria-disabled="true"
              className="business-team-placeholder"
            >
              <HomeIcon aria-hidden="true" />
              {name}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

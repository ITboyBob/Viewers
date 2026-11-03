import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { PersonIcon, ExitIcon } from '@radix-ui/react-icons';
import type { BusinessTeamMembership, BusinessUserSummary } from '@ohif/core';
import TeamListOverlay from './TeamListOverlay';

/** 个人信息面板；可展示会话自有团队，但不查询、切换团队或执行注销。 */
export default function MemberOverlay({
  user,
  ownedTeam,
}: {
  user: BusinessUserSummary;
  ownedTeam?: BusinessTeamMembership;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const teamRef = useRef<HTMLDivElement>(null);
  const closedByPointerOutsideRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // 面板需隔离 pointerdown；捕获阶段判断外部点击，避免 Radix 的冒泡监听漏掉首次关闭。
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !contentRef.current?.contains(target) &&
        !teamRef.current?.contains(target)
      ) {
        closedByPointerOutsideRef.current = true;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={nextOpen => {
        if (nextOpen) closedByPointerOutsideRef.current = false;
        setOpen(nextOpen);
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="business-top-action"
          aria-label="成员"
          onClick={event => event.stopPropagation()}
        >
          <PersonIcon aria-hidden="true" />
          成员
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          className="business-member-panel shadow-md"
          align="start"
          sideOffset={4}
          aria-label="个人信息"
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onKeyPress={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          onCloseAutoFocus={event => {
            // 外部点击应保留被点击控件的焦点；键盘关闭仍由 Radix 归还入口。
            if (closedByPointerOutsideRef.current) event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="business-member-identity">
            {user.avatar_url ? (
              <img
                className="business-avatar"
                src={user.avatar_url}
                alt={`${user.username}的头像`}
              />
            ) : (
              <span
                className="business-avatar"
                role="img"
                aria-label="默认头像"
              >
                <PersonIcon aria-hidden="true" />
              </span>
            )}
            <span>{user.username}</span>
          </div>
          <div
            role="menu"
            aria-label="个人菜单"
          >
            <TeamListOverlay
              ownedTeam={ownedTeam}
              contentRef={teamRef}
              suppressCloseFocusRef={closedByPointerOutsideRef}
            />
            <div
              role="menuitem"
              aria-disabled="true"
            >
              <ExitIcon aria-hidden="true" />
              退出登录
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

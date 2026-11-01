import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { PersonIcon, HomeIcon, ExitIcon } from '@radix-ui/react-icons';
import type { BusinessUserSummary } from '@ohif/core';

/** 一级个人信息面板：展示不是团队查询、账号切换或注销入口。 */
export default function MemberOverlay({ user }: { user: BusinessUserSummary }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
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
          className="business-member-panel shadow-md"
          align="start"
          sideOffset={4}
          aria-label="个人信息"
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
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
            aria-label="个人菜单（仅展示）"
          >
            <div
              role="menuitem"
              aria-disabled="true"
            >
              <HomeIcon aria-hidden="true" />
              查看你的团队
            </div>
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

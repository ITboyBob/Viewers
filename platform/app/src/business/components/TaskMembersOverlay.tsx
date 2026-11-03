import React, { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { PersonIcon } from '@radix-ui/react-icons';
import type { TaskMemberList, TeamPageApi } from '@ohif/core';
import './TaskMembersOverlay.css';

type Props = { taskId: string; api: TeamPageApi; identityKey: string };
type ReadState =
  | { status: 'loading'; api: TeamPageApi }
  | { status: 'error'; api: TeamPageApi }
  | { status: 'ready'; api: TeamPageApi; data: TaskMemberList };

/** 只消费服务校验后的任务名单；不读取团队成员或临时窗口参与状态。 */
function TaskMembersList({
  taskId,
  api,
  onBeforeRetry,
}: Pick<Props, 'taskId' | 'api'> & { onBeforeRetry: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState>({ status: 'loading', api });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: 'loading', api });
    const load = async () => {
      try {
        const data = await api.listTaskMembers(taskId, controller.signal);
        // 取消只是通知传输层；即便提供器忽略 signal，也不能提交过期结果。
        if (active) {
          setState({ status: 'ready', api, data });
        }
      } catch (_error) {
        if (active) {
          setState({ status: 'error', api });
        }
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [taskId, api, attempt]);

  if (state.api !== api || state.status === 'loading') {
    return (
      <p
        className="task-members-status"
        role="status"
      >
        正在读取成员…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="task-members-failure">
        <p
          className="task-members-error"
          role="alert"
        >
          成员读取失败，请重试。
        </p>
        <button
          className="task-members-retry"
          type="button"
          onClick={() => {
            // loading 会卸载重试按钮；先移交焦点，避免落到 BODY 后泄漏文档级快捷键。
            onBeforeRetry();
            setAttempt(value => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  }
  return (
    <ul
      className="task-members-list"
      aria-label="任务成员名单"
    >
      {state.data.members.map(member => (
        <li
          className="task-members-row"
          key={member.uid}
        >
          <span className="task-members-username">{member.username}</span>
          {member.uid === state.data.owner_uid && <span className="task-members-owner">Owner</span>}
        </li>
      ))}
    </ul>
  );
}

/** 目标任务成员只读浮层；每次打开重新读取，身份或目标变化隔离整份展示状态。 */
export default function TaskMembersOverlay({ taskId, api, identityKey }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closedByOutsideRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 内容会隔离指针冒泡，需在捕获阶段关闭，且不抢走外部控件焦点。
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !contentRef.current?.contains(target)) {
        closedByOutsideRef.current = true;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        if (next) {
          closedByOutsideRef.current = false;
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="business-top-action task-members-trigger"
          aria-label="任务成员"
          onClick={event => event.stopPropagation()}
        >
          <PersonIcon aria-hidden="true" />
          成员
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          className="task-members-panel"
          tabIndex={-1}
          aria-label="任务成员"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onKeyPress={event => event.stopPropagation()}
          onKeyUp={event => event.stopPropagation()}
          onInteractOutside={() => {
            closedByOutsideRef.current = true;
          }}
          onCloseAutoFocus={event => {
            if (closedByOutsideRef.current) {
              event.preventDefault();
            }
          }}
          onDragOver={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <h2 className="task-members-heading">任务成员</h2>
          {/* 换身份／任务先卸载旧读取器，避免新渲染短暂闪现旧名单。 */}
          <TaskMembersList
            key={JSON.stringify([identityKey, taskId])}
            taskId={taskId}
            api={api}
            onBeforeRetry={() => contentRef.current?.focus({ preventScroll: true })}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

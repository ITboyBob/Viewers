import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellIcon, PersonIcon } from '@radix-ui/react-icons';
import type {
  BusinessUserSummary,
  CollaborationMockApi,
  InvitationDecision,
  InvitationView,
  MockInvitation,
  NotificationItem,
  TeamInvitationApi,
} from '@ohif/core';
import BusinessDialog from './BusinessDialog';

type Props = {
  api?: TeamInvitationApi;
  store?: CollaborationMockApi;
  user: BusinessUserSummary;
  onAccepted?(): Promise<void>;
  onRead?(count: number): void;
};
const message = (failure: unknown) =>
  (failure as { reason?: string })?.reason === 'INVITATION_EXPIRED'
    ? '邀请已过期'
    : failure instanceof Error
      ? failure.message
      : '操作失败，请重试。';
const itemKey = (item: NotificationItem) =>
  item.kind === 'team_join' ? `team:${item.invitation.invitation_id}` : `mock:${item.mock_id}`;

function NotificationBody({ api, store, user, onAccepted, onRead }: Props) {
  const [real, setReal] = useState<InvitationView[]>([]);
  const [mock, setMock] = useState<MockInvitation[]>([]);
  const [realError, setRealError] = useState('');
  const [mockError, setMockError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(false);
  const sequence = useRef(0);
  const readController = useRef<AbortController>();
  const actions = useRef(new Set<AbortController>());
  const busy = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setLoading(true);
    try {
      if (!api) {
        throw new Error('真实通知服务不可用，不使用模拟数据替代。');
      }
      const result = await api.listNotifications(controller.signal);
      if (alive.current && current === sequence.current && !controller.signal.aborted) {
        setReal(result);
        setRealError('');
      }
    } catch (failure) {
      if (alive.current && current === sequence.current && !controller.signal.aborted) {
        setRealError(message(failure));
      }
    } finally {
      if (alive.current && current === sequence.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    const activeActions = actions.current;
    try {
      setMock(store?.list() ?? []);
    } catch (failure) {
      setMockError(message(failure));
    }
    void refresh();
    return () => {
      alive.current = false;
      readController.current?.abort();
      activeActions.forEach(controller => controller.abort());
    };
  }, [refresh, store]);

  useEffect(() => {
    if (loading || realError || !api?.markRead || !real.length) return;
    const ids = real.filter(item => item.read_at === null).map(item => item.invitation_id);
    if (!ids.length) return;
    const controller = new AbortController();
    api
      .markRead(ids, controller.signal)
      .then(count => {
        if (controller.signal.aborted || !alive.current) return;
        setReal(items =>
          items.map(item =>
            ids.includes(item.invitation_id) ? { ...item, read_at: new Date().toISOString() } : item
          )
        );
        onRead?.(count);
      })
      .catch(error => {
        if (!controller.signal.aborted && alive.current) setActionError(message(error));
      });
    return () => controller.abort();
  }, [api, real, loading, realError, onRead]);

  const decide = async (
    item: NotificationItem,
    decision: Exclude<InvitationDecision, 'pending'>
  ) => {
    const key = itemKey(item);
    if (busy.current.has(key)) {
      return;
    }
    busy.current.add(key);
    setPending(new Set(busy.current));
    setActionError('');
    const controller = new AbortController();
    actions.current.add(controller);
    try {
      if (item.kind === 'team_join') {
        // 防止处理期间较早的列表响应把刚处理的条目覆盖为 pending。
        ++sequence.current;
        readController.current?.abort();
        if (!api) {
          throw new Error('真实通知服务不可用。');
        }
        const result = await api.decide(item.invitation.invitation_id, decision, controller.signal);
        if (alive.current && !controller.signal.aborted) {
          setReal(items =>
            items.map(value => (value.invitation_id === result.invitation_id ? result : value))
          );
          await refresh();
          if (decision === 'accepted') await onAccepted?.();
        }
      } else {
        if (!store) {
          throw new Error('协作模拟存储不可用。');
        }
        store.decide(item.mock_id, decision);
        setMock(store.list());
      }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) {
        setActionError(message(failure));
      }
    } finally {
      actions.current.delete(controller);
      busy.current.delete(key);
      if (alive.current && !controller.signal.aborted) {
        setPending(new Set(busy.current));
        setLoading(false);
      }
    }
  };

  const items: NotificationItem[] = [
    ...real.map(invitation => ({ kind: 'team_join' as const, invitation })),
    ...mock,
  ];
  return (
    <>
      {realError || mockError || actionError ? (
        <p
          className="business-error"
          role="alert"
        >
          {[realError, mockError, actionError].filter(Boolean).join('；')}
        </p>
      ) : null}
      {loading && (
        <p
          className="business-hint"
          role="status"
        >
          正在刷新真实通知…
        </p>
      )}
      {!loading && !items.length && !realError && !mockError && (
        <p className="business-hint">暂无通知</p>
      )}
      {items.map(item => {
        const teamJoin = item.kind === 'team_join';
        const decision = teamJoin ? item.invitation.decision : item.decision;
        const key = itemKey(item);
        const sender = teamJoin ? item.invitation.inviter : user;
        return (
          <article
            key={key}
            className="business-notification"
            aria-label={
              teamJoin
                ? `入队邀请 ${item.invitation.team_name}`
                : `协作模拟 ${item.recipient_username}`
            }
          >
            {sender.avatar_url ? (
              <img
                className="business-avatar"
                src={sender.avatar_url}
                alt={`${sender.username}的头像`}
              />
            ) : (
              <span
                className="business-avatar"
                aria-hidden="true"
              >
                <PersonIcon />
              </span>
            )}
            <div className="business-person-info">
              <strong>
                {teamJoin ? sender.username : `协作演示：你 → ${item.recipient_username}`}
              </strong>
              <span>
                {teamJoin
                  ? `邀请你加入团队“${item.invitation.team_name}”`
                  : '协作邀请 · 合成用户；按钮模拟接收方决定'}
              </span>
            </div>
            <div className="business-notification-actions">
              {decision === 'pending' ? (
                <>
                  <button
                    type="button"
                    className="business-action business-action-secondary"
                    disabled={pending.has(key)}
                    aria-label={teamJoin ? '拒绝' : '模拟拒绝'}
                    onClick={() => {
                      void decide(item, 'rejected');
                    }}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="business-action"
                    disabled={pending.has(key)}
                    aria-label={teamJoin ? '接受' : '模拟接受'}
                    onClick={() => {
                      void decide(item, 'accepted');
                    }}
                  >
                    接受
                  </button>
                </>
              ) : (
                <span
                  className="business-notification-decision"
                  data-decision={decision}
                >
                  {decision === 'accepted' ? '已接受' : '已拒绝'}
                </span>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}

export default function NotificationDialog(props: Props) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [readError, setReadError] = useState('');
  useEffect(() => {
    if (!props.api?.unreadCount) return;
    let alive = true;
    let controller: AbortController | undefined;
    const check = () => {
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      props.api!.unreadCount!(current.signal)
        .then(count => {
          if (alive && !current.signal.aborted) {
            setUnread(count);
            setReadError('');
          }
        })
        .catch(error => {
          if (alive && !current.signal.aborted) setReadError(message(error));
        });
    };
    check();
    const timer = setInterval(check, 30000);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [props.api, props.user.uid]);
  return (
    <BusinessDialog
      title="通知"
      variant="notifications"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="business-top-action"
          aria-label="通知"
          onClick={event => event.stopPropagation()}
        >
          <BellIcon aria-hidden="true" />
          通知
          {unread > 0 && (
            <span
              aria-label="有未读通知"
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#ef4444',
              }}
            />
          )}
          {readError && (
            <span
              role="status"
              title={readError}
            >
              读取失败
            </span>
          )}
        </button>
      }
    >
      {open && (
        <NotificationBody
          {...props}
          onRead={setUnread}
        />
      )}
    </BusinessDialog>
  );
}

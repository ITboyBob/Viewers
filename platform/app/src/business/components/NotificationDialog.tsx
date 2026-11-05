import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellIcon, PersonIcon } from '@radix-ui/react-icons';
import type {
  BusinessUserSummary,
  CollaborationInvitation,
  CollaborationInvitationApi,
  InvitationDecision,
  InvitationView,
  NotificationItem,
  TeamInvitationApi,
} from '@ohif/core';
import BusinessDialog from './BusinessDialog';

type Domain = 'team' | 'collaboration';
type Props = {
  api?: TeamInvitationApi;
  collaborationApi?: CollaborationInvitationApi;
  user: BusinessUserSummary;
  onAccepted?(): Promise<void>;
  onOpenWorkspace?(taskId: string, signal?: AbortSignal): Promise<void>;
};
const message = (error: unknown) =>
  (error as { reason?: string })?.reason === 'INVITATION_EXPIRED'
    ? '邀请已过期'
    : error instanceof Error
      ? error.message
      : '操作失败，请重试';
const keyOf = (item: NotificationItem) => `${item.kind}:${item.invitation.invitation_id}`;
function NotificationBody({
  api,
  collaborationApi,
  onAccepted,
  onOpenWorkspace,
  onDomainRead,
}: Props & { onDomainRead(domain: Domain, count: number): void }) {
  const [teams, setTeams] = useState<InvitationView[]>([]),
    [collaborations, setCollaborations] = useState<CollaborationInvitation[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Domain, string>>>({}),
    [actionError, setActionError] = useState('');
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false),
    [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(false),
    sequence = useRef(0),
    readController = useRef<AbortController>();
  const actions = useRef(new Set<AbortController>()),
    busy = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setLoading(true);
    await Promise.all(
      (['team', 'collaboration'] as const).map(async domain => {
        try {
          const service = domain === 'team' ? api : collaborationApi;
          if (!service) {
            throw new Error(`${domain === 'team' ? '团队' : '协作'}真实通知服务不可用`);
          }
          const records = await service.listNotifications(controller.signal);
          if (!alive.current || controller.signal.aborted || current !== sequence.current) {
            return;
          }
          if (domain === 'team') {
            setTeams(records as InvitationView[]);
          } else {
            setCollaborations(records as CollaborationInvitation[]);
          }
          setErrors(values => ({ ...values, [domain]: '' }));
        } catch (error) {
          if (alive.current && !controller.signal.aborted && current === sequence.current) {
            setErrors(values => ({ ...values, [domain]: message(error) }));
          }
        }
      })
    );
    if (alive.current && !controller.signal.aborted && current === sequence.current) {
      setLoading(false);
    }
  }, [api, collaborationApi]);
  useEffect(() => {
    alive.current = true;
    const activeActions = actions.current;
    void refresh();
    return () => {
      alive.current = false;
      readController.current?.abort();
      activeActions.forEach(controller => controller.abort());
    };
  }, [refresh]);
  useEffect(() => {
    if (loading) {
      return;
    }
    const controller = new AbortController();
    for (const domain of ['team', 'collaboration'] as const) {
      const service = domain === 'team' ? api : collaborationApi,
        records = domain === 'team' ? teams : collaborations;
      if (errors[domain] || !service?.markRead) {
        continue;
      }
      const ids = records.filter(item => item.read_at === null).map(item => item.invitation_id);
      if (!ids.length) {
        continue;
      }
      service
        .markRead(ids, controller.signal)
        .then(count => {
          if (!alive.current || controller.signal.aborted) {
            return;
          }
          const update = <T extends InvitationView | CollaborationInvitation>(items: T[]) =>
            items.map(item =>
              ids.includes(item.invitation_id)
                ? { ...item, read_at: new Date().toISOString() }
                : item
            );
          if (domain === 'team') {
            setTeams(update);
          } else {
            setCollaborations(update);
          }
          onDomainRead(domain, count);
        })
        .catch(error => {
          if (alive.current && !controller.signal.aborted) {
            setActionError(message(error));
          }
        });
    }
    return () => controller.abort();
  }, [api, collaborationApi, teams, collaborations, errors, loading, onDomainRead]);
  const enter = async (item: CollaborationInvitation, signal: AbortSignal) => {
    try {
      if (!onOpenWorkspace) {
        throw new Error('工作台加载服务不可用');
      }
      await onOpenWorkspace(item.task_id, signal);
      if (alive.current && !signal.aborted) {
        setEntryErrors(values => ({ ...values, [item.invitation_id]: '' }));
      }
    } catch (error) {
      if (alive.current && !signal.aborted) {
        setEntryErrors(values => ({
          ...values,
          [item.invitation_id]: `邀请已接受；工作台加载失败：${message(error)}`,
        }));
      }
    }
  };
  const operate = async (
    item: NotificationItem,
    decision?: Exclude<InvitationDecision, 'pending'>
  ) => {
    const key = keyOf(item);
    if (busy.current.has(key)) {
      return;
    }
    busy.current.add(key);
    setPending(new Set(busy.current));
    setActionError('');
    const controller = new AbortController();
    actions.current.add(controller);
    try {
      if (!decision && item.kind === 'workspace_collaboration') {
        await enter(item.invitation, controller.signal);
        return;
      }
      ++sequence.current;
      readController.current?.abort();
      if (item.kind === 'team_join') {
        if (!api || !decision) {
          throw new Error('团队通知服务不可用');
        }
        const result = await api.decide(item.invitation.invitation_id, decision, controller.signal);
        if (!alive.current || controller.signal.aborted) {
          return;
        }
        setTeams(items =>
          items.map(value => (value.invitation_id === result.invitation_id ? result : value))
        );
        if (decision === 'accepted' && !controller.signal.aborted) {
          await onAccepted?.();
        }
        await refresh();
      } else {
        if (!collaborationApi) {
          throw new Error('协作通知服务不可用');
        }
        const result =
          decision === 'accepted'
            ? (await collaborationApi.accept(item.invitation.invitation_id, controller.signal))
                .invitation
            : await collaborationApi.reject(item.invitation.invitation_id, controller.signal);
        if (!alive.current || controller.signal.aborted) {
          return;
        }
        setCollaborations(items =>
          items.map(value => (value.invitation_id === result.invitation_id ? result : value))
        );
        setLoading(false);
        if (decision === 'accepted') {
          await enter(result, controller.signal);
        }
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) {
        setActionError(message(error));
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
    ...teams.map(invitation => ({ kind: 'team_join' as const, invitation })),
    ...collaborations.map(invitation => ({ kind: 'workspace_collaboration' as const, invitation })),
  ];
  return (
    <>
      {[errors.team, errors.collaboration, actionError].filter(Boolean).length > 0 && (
        <p
          className="business-error"
          role="alert"
        >
          {[errors.team, errors.collaboration, actionError].filter(Boolean).join('；')}
        </p>
      )}
      {loading && (
        <p
          className="business-hint"
          role="status"
        >
          正在刷新真实通知…
        </p>
      )}
      {!loading && !items.length && !errors.team && !errors.collaboration && (
        <p className="business-hint">暂无通知</p>
      )}
      {items.map(item => {
        const team = item.kind === 'team_join',
          invitation = item.invitation,
          sender = invitation.inviter,
          key = keyOf(item);
        const title =
          item.kind === 'team_join' ? item.invitation.team_name : item.invitation.task_title;
        return (
          <article
            key={key}
            className="business-notification"
            aria-label={`${team ? '入队邀请' : '工作台协作邀请'} ${title}`}
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
              <strong>{sender.username}</strong>
              <span>{team ? `邀请你加入团队“${title}”` : `邀请你协作此工作台“${title}”`}</span>
              {!team && entryErrors[invitation.invitation_id] && (
                <p
                  className="business-error"
                  role="alert"
                >
                  {entryErrors[invitation.invitation_id]}
                </p>
              )}
            </div>
            <div className="business-notification-actions">
              {invitation.decision === 'pending' ? (
                <>
                  <button
                    type="button"
                    className="business-action business-action-secondary"
                    disabled={pending.has(key)}
                    onClick={() => void operate(item, 'rejected')}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="business-action"
                    disabled={pending.has(key)}
                    onClick={() => void operate(item, 'accepted')}
                  >
                    接受
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="business-notification-decision"
                    data-decision={invitation.decision}
                  >
                    {invitation.decision === 'accepted' ? '已接受' : '已拒绝'}
                  </span>
                  {!team && invitation.decision === 'accepted' && (
                    <button
                      type="button"
                      className="business-action"
                      disabled={pending.has(key)}
                      onClick={() => void operate(item)}
                    >
                      {entryErrors[invitation.invitation_id] ? '重试进入工作台' : '进入工作台'}
                    </button>
                  )}
                </>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
export default function NotificationDialog(props: Props) {
  const [open, setOpen] = useState(false),
    [counts, setCounts] = useState<Partial<Record<Domain, number>>>({}),
    [readError, setReadError] = useState('');
  useEffect(() => {
    setCounts({});
    setReadError('');
  }, [props.user.uid]);
  const mark = useCallback(
    (domain: Domain, count: number) => setCounts(values => ({ ...values, [domain]: count })),
    []
  );
  useEffect(() => {
    let alive = true,
      controller: AbortController | undefined;
    const check = async () => {
      controller?.abort();
      const abort = new AbortController();
      controller = abort;
      const failures: string[] = [];
      await Promise.all(
        (['team', 'collaboration'] as const).map(async domain => {
          const service = domain === 'team' ? props.api : props.collaborationApi;
          if (!service?.unreadCount) {
            return;
          }
          try {
            const count = await service.unreadCount(abort.signal);
            if (alive && !abort.signal.aborted) {
              mark(domain, count);
            }
          } catch (error) {
            failures.push(message(error));
          }
        })
      );
      if (alive && !abort.signal.aborted) {
        setReadError(failures.join('；'));
      }
    };
    void check();
    const timer = setInterval(() => void check(), 30000);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [props.api, props.collaborationApi, props.user.uid, mark]);
  const unread = (counts.team ?? 0) + (counts.collaboration ?? 0);
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
          title={readError || undefined}
          onClick={event => event.stopPropagation()}
        >
          <BellIcon aria-hidden="true" />
          通知
          {unread > 0 && (
            <span
              className="business-unread-dot"
              aria-label="有未读通知"
            />
          )}
          {readError && (
            <span
              role="status"
              aria-label="未读状态读取失败"
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
          key={props.user.uid}
          {...props}
          onDomainRead={mark}
        />
      )}
    </BusinessDialog>
  );
}

import React, { useEffect, useState } from 'react';
import { PlusIcon } from '@radix-ui/react-icons';
import type { CollaborationMockApi } from '@ohif/core';
import BusinessDialog from './BusinessDialog';

function InviteBody({ store }: { store?: CollaborationMockApi }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [, redraw] = useState(0);
  const state = (() => {
    try {
      return { items: store?.list() ?? [], error: store ? '' : '协作模拟存储不可用。' };
    } catch (failure) {
      return { items: [], error: (failure as Error).message };
    }
  })();
  const nextDeadline = store
    ? state.items
        .filter(item => item.expires_at > store.clockNow())
        .reduce<
          number | null
        >((earliest, item) => (earliest === null ? item.expires_at : Math.min(earliest, item.expires_at)), null)
    : null;
  useEffect(() => {
    if (!store || nextDeadline === null) {
      return;
    }
    const timer = setTimeout(
      () => redraw(value => value + 1),
      Math.max(0, nextDeadline - store.clockNow())
    );
    return () => clearTimeout(timer);
  }, [store, nextDeadline]);

  const invite = (name: string) => {
    try {
      store?.invite(name);
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
    redraw(value => value + 1);
  };
  const unavailable = !store || !!state.error || !!store.getError();
  const invited = (name: string) => store?.isInvited(name) ?? false;
  return (
    <>
      <form
        className="business-username-invite"
        onSubmit={event => {
          event.preventDefault();
          if (!unavailable && username.trim()) {
            invite(username);
          }
        }}
      >
        <label
          className="business-field"
          htmlFor="collaboration-username"
        >
          <span>用户名</span>
          <input
            id="collaboration-username"
            placeholder="请输入被邀请人的用户名"
            value={username}
            autoComplete="off"
            disabled={unavailable}
            onChange={event => {
              setUsername(event.target.value);
              setError('');
            }}
          />
        </label>
        <button
          className="business-action business-username-submit"
          type="submit"
          aria-label="按用户名邀请"
          disabled={unavailable || !username.trim() || invited(username.trim())}
        >
          {invited(username.trim()) ? '已邀请' : '邀请'}
        </button>
      </form>
      <p className="business-hint">仅使用合成用户演示；不发送真实协作请求，不会将用户加入团队。</p>
      {error || state.error ? (
        <p
          className="business-error"
          role="alert"
        >
          {error || state.error}
        </p>
      ) : null}
      <div className="business-divider" />
      <div className="business-mock-members">
        <h3>你的团队成员（合成演示）</h3>
        {store?.recipients
          .filter(item => item.in_team)
          .map(recipient => (
            <div
              className="business-mock-member"
              key={recipient.uid}
            >
              <span
                className="business-avatar"
                aria-hidden="true"
              >
                {recipient.username.slice(0, 1)}
              </span>
              <div className="business-person-info">
                <strong>{recipient.username}</strong>
                <span>团队成员 · 合成用户</span>
              </div>
              <button
                className="business-action business-member-invite"
                type="button"
                aria-label={`邀请${recipient.username}`}
                disabled={unavailable || invited(recipient.username)}
                onClick={() => invite(recipient.username)}
              >
                {invited(recipient.username) ? '已邀请' : '邀请他'}
              </button>
            </div>
          ))}
        <p className="business-hint">
          用户名也可选择合成已注册用户：
          {store?.recipients
            .filter(item => !item.in_team)
            .map(item => item.username)
            .join('、')}
        </p>
      </div>
    </>
  );
}

export default function CollaborationInviteDialog({ store }: { store?: CollaborationMockApi }) {
  const [open, setOpen] = useState(false);
  return (
    <BusinessDialog
      title="邀请他人协作"
      variant="invite"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="business-top-action"
          aria-label="邀请"
          onClick={event => event.stopPropagation()}
        >
          <PlusIcon aria-hidden="true" />
          邀请
        </button>
      }
    >
      {open && <InviteBody store={store} />}
    </BusinessDialog>
  );
}

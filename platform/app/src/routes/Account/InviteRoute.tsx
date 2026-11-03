import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BusinessServices, MemberView } from '@ohif/core';
import useBusinessSession, { useBusinessServices } from '../../business/useBusinessSession';
import AccountLayout from './AccountLayout';
import './InviteRoute.css';
import '../../business/components/BusinessFonts.css';

function InvitationForm({ services }: { services: BusinessServices }) {
  const snapshot = useBusinessSession(services.session);
  const teamId = snapshot.currentTeamId;
  const user = snapshot.context?.user;
  const team = snapshot.context?.memberships.find(item => item.team_id === teamId);
  const api = services.teamInvitations;
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const request = useRef<AbortController>();
  const [members, setMembers] = useState<{
    teamId: string | null;
    data: MemberView[];
    ready: boolean;
    error: string;
  }>({ teamId: null, data: [], ready: false, error: '' });

  useEffect(() => {
    const controller = new AbortController();
    setPending(false);
    setError('');
    setMembers({ teamId, data: [], ready: false, error: '' });
    if (api && teamId && team?.role === 'owner') {
      api
        .listMembers(teamId, controller.signal)
        .then(data => {
          if (!controller.signal.aborted) {
            setMembers({ teamId, data, ready: true, error: '' });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setMembers({
              teamId,
              data: [],
              ready: false,
              error: '无法核对当前团队成员，请重新打开页面后重试。',
            });
          }
        });
    }
    return () => {
      controller.abort();
      request.current?.abort();
      busy.current = false;
    };
  }, [api, teamId, team?.role, user?.uid]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current) {
      return;
    }
    const value = username.trim();
    if (!value) {
      setError('请输入对方用户名。');
      return;
    }
    if (!api || !teamId || !user || team?.role !== 'owner') {
      setError('真实邀请服务不可用，或当前身份没有邀请权限。');
      return;
    }
    if (value === user.username) {
      setError('不能邀请自己。');
      return;
    }
    if (members.teamId !== teamId || !members.ready) {
      setError('尚未完成团队成员核对，不能发送邀请。');
      return;
    }
    if (members.data.some(member => member.username === value)) {
      setError('该用户已在当前团队中，不能重复邀请。');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await api.send(teamId, value, controller.signal);
      if (!controller.signal.aborted) {
        navigate('/team/tasks');
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : '邀请发送失败，请重试。');
      }
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  return (
    <form
      className="account-form"
      onSubmit={submit}
    >
      <div className="account-card">
        <h2>邀请成员</h2>
        <label
          className="account-field"
          htmlFor="invite-username"
        >
          <span>输入他的用户名</span>
          <input
            id="invite-username"
            name="username"
            autoComplete="off"
            placeholder="请输入对方用户名"
            value={username}
            disabled={pending}
            onChange={event => {
              setUsername(event.target.value);
              setError('');
            }}
          />
        </label>
        {error || members.error || !api || team?.role !== 'owner' ? (
          <p
            className="account-error"
            role="alert"
          >
            {error || members.error || '真实邀请服务不可用，或当前身份没有邀请权限。'}
          </p>
        ) : (
          <p className="account-hint">
            {members.ready
              ? `邀请入队：${team.name}；发送不代表对方已加入。`
              : '正在核对当前团队成员…'}
          </p>
        )}
      </div>
      <div className="account-invite-actions">
        <button
          className="account-submit account-invite-skip"
          type="button"
          disabled={pending}
          onClick={() => {
            if (!busy.current) {
              navigate('/team/tasks');
            }
          }}
        >
          跳过
        </button>
        <button
          className="account-submit"
          type="submit"
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? '发送中…' : '完成'}
        </button>
      </div>
    </form>
  );
}

export default function InviteRoute() {
  const services = useBusinessServices();
  return (
    <AccountLayout mode="invite">
      {services ? (
        <InvitationForm services={services} />
      ) : (
        <p
          className="account-error"
          role="alert"
        >
          业务服务尚未初始化，不能发送真实邀请。
        </p>
      )}
    </AccountLayout>
  );
}

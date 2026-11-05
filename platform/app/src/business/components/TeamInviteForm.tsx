import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { InvitationView, SentInvitationDeadline, TeamInvitationApi } from '@ohif/core';
import { BusinessApiError } from '../BusinessApiClient';

/** 两个入队入口共用；恢复失败不阻断提交，业务资格只由POST判断。父级按账号与团队重建。 */
export default function TeamInviteForm({
  api,
  teamId,
  onSent,
  onContextLost,
  children,
}: React.PropsWithChildren<{
  api?: TeamInvitationApi;
  teamId: string;
  onSent?(value: InvitationView): void;
  onContextLost?(): void;
}>) {
  const [username, setUsername] = useState('');
  const [records, setRecords] = useState<SentInvitationDeadline[]>([]);
  const [error, setError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [pending, setPending] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [contextLost, setContextLost] = useState(false);
  const lost = useRef(false);
  const recoverContext = useRef(onContextLost);
  recoverContext.current = onContextLost;
  // 时间依据后端事实，以单调时钟推进；系统时钟跳变不能延长或缩短本人期限。
  const timeBase = useRef<{ server: number; monotonic: number }>();
  const timeVersion = useRef(0);
  const now = () =>
    timeBase.current
      ? timeBase.current.server + performance.now() - timeBase.current.monotonic
      : Date.now();
  const alive = useRef(true);
  const busy = useRef(false);
  const sendRequest = useRef<AbortController>();
  const readRequest = useRef<AbortController>();
  const invalidateTeam = useCallback(() => {
    lost.current = true;
    sendRequest.current?.abort();
    readRequest.current?.abort();
    setRecords([]);
    setUsername('');
    setContextLost(true);
    recoverContext.current?.();
  }, []);
  const restore = useCallback(async () => {
    if (lost.current) return;
    const version = timeVersion.current;
    const started = performance.now();
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      if (!api?.listSent) throw new Error('真实期限读取服务不可用');
      const value = await api.listSent(teamId, controller.signal);
      if (!alive.current || lost.current || controller.signal.aborted) return;
      if (version === timeVersion.current)
        timeBase.current = {
          server: Date.parse(value.server_time) + (performance.now() - started) / 2,
          monotonic: performance.now(),
        };
      setClock(now());
      // 保留并发POST刚确认的记录；不能让更早发起的读取覆盖它。
      setRecords(current =>
        [
          ...new Map([...value.data, ...current].map(item => [item.invitation_id, item])).values(),
        ].filter(item => Date.parse(item.expires_at) > Date.parse(value.server_time))
      );
      setRestoreError('');
    } catch (failure) {
      if (
        alive.current &&
        !controller.signal.aborted &&
        (failure as { status?: number })?.status === 404
      ) {
        invalidateTeam();
        return;
      }
      if (alive.current && !controller.signal.aborted)
        setRestoreError('本人邀请期限恢复失败，请重试恢复；仍可提交，由后端最终校验。');
    }
  }, [api, teamId, invalidateTeam]);
  useEffect(() => {
    alive.current = true;
    void restore();
    const timer = setInterval(() => setClock(now()), 1000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      sendRequest.current?.abort();
      readRequest.current?.abort();
    };
  }, [restore]);
  const value = username.trim();
  const invited = records.some(
    item => item.invitee.username === value && Date.parse(item.expires_at) > clock
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (lost.current || busy.current || !value || invited || !api || !teamId) return;
    const started = performance.now();
    const controller = new AbortController();
    sendRequest.current = controller;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api.send(teamId, value, controller.signal);
      if (!alive.current || lost.current || controller.signal.aborted) return;
      if (
        result.team_id !== teamId ||
        !result.invitation_id ||
        !Number.isFinite(Date.parse(result.created_at)) ||
        !Number.isFinite(Date.parse(result.expires_at))
      )
        throw new Error('邀请响应不完整，请恢复本人邀请记录确认结果。');
      timeVersion.current++;
      timeBase.current = {
        server: Date.parse(result.created_at) + (performance.now() - started) / 2,
        monotonic: performance.now(),
      };
      setClock(now());
      setRecords(current => [
        ...current.filter(item => item.invitation_id !== result.invitation_id),
        {
          invitation_id: result.invitation_id,
          team_id: teamId,
          invitee: { uid: result.invitee_uid, username: value },
          created_at: result.created_at,
          expires_at: result.expires_at,
        },
      ]);
      onSent?.(result);
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      if ((failure as { status?: number })?.status === 404) {
        invalidateTeam();
        return;
      }
      const reason = failure instanceof BusinessApiError ? failure.reason : undefined;
      setError(
        reason === 'ALREADY_MEMBER'
          ? '该用户已在团队中。'
          : reason === 'INVALID_INVITEE'
            ? '无法邀请该用户。'
            : reason === 'INVITATION_COOLDOWN'
              ? '本人邀请仍在有效期限内，请恢复邀请记录。'
              : failure instanceof BusinessApiError && failure.status === 0
                ? '发送结果未知，请恢复本人邀请记录确认；重试仍由后端防重。'
                : failure instanceof Error
                  ? failure.message
                  : '邀请发送失败，请重试。'
      );
      if (
        reason === 'INVITATION_COOLDOWN' ||
        (failure instanceof BusinessApiError && failure.status === 0)
      )
        void restore();
    } finally {
      if (alive.current && !controller.signal.aborted) {
        busy.current = false;
        setPending(false);
      }
    }
  };
  if (contextLost)
    return (
      <div role="alert">
        <p>当前团队资格已失效，请重新确认团队。</p>
        <button
          type="button"
          onClick={() => recoverContext.current?.()}
        >
          重试恢复团队
        </button>
      </div>
    );
  return (
    <form
      className="team-invite-form"
      onSubmit={submit}
    >
      <label
        className="account-field"
        htmlFor="team-invite-username"
      >
        <span>输入他的用户名</span>
        <input
          id="team-invite-username"
          autoComplete="off"
          placeholder="请输入对方用户名"
          value={username}
          onChange={event => {
            setUsername(event.target.value);
            setError('');
          }}
          disabled={pending}
        />
      </label>
      {restoreError && (
        <div role="alert">
          <p>{restoreError}</p>
          <button
            type="button"
            onClick={() => void restore()}
          >
            重试恢复
          </button>
        </div>
      )}
      {error && (
        <p
          className="account-error"
          role="alert"
        >
          {error}
        </p>
      )}
      {!api && <p role="alert">真实邀请服务不可用。</p>}
      <div className="account-invite-actions">
        {React.Children.map(children, child =>
          React.isValidElement<{ disabled?: boolean }>(child)
            ? React.cloneElement(child, { disabled: pending || child.props.disabled })
            : child
        )}
        <button
          className="account-submit"
          type="submit"
          disabled={!value || pending || invited || !api || !teamId}
          aria-busy={pending}
        >
          {pending ? '发送中…' : invited ? '已邀请' : '邀请'}
        </button>
      </div>
    </form>
  );
}

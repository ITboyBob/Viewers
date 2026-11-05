import React, { useEffect, useRef, useState } from 'react';
import { PlusIcon } from '@radix-ui/react-icons';
import type {
  CollaborationInvitation,
  CollaborationInvitationApi,
  CollaborationPermission,
} from '@ohif/core';
import BusinessDialog from './BusinessDialog';

type Props = { api?: CollaborationInvitationApi; taskId?: string };
function InviteBody({ api, taskId }: Props) {
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<CollaborationPermission>('edit');
  const [records, setRecords] = useState<CollaborationInvitation[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [attempt, retry] = useState(0);
  const [, redraw] = useState(0);
  const offset = useRef(0),
    busy = useRef(false),
    controller = useRef<AbortController>();
  const blocked = useRef(new Set<string>());
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError('');
    if (!api || !taskId) {
      setError('真实协作服务或当前工作台不可用');
      setLoading(false);
      return;
    }
    api
      .listSent(taskId, abort.signal)
      .then(value => {
        if (abort.signal.aborted) {
          return;
        }
        offset.current = Date.parse(value.server_time) - Date.now();
        setRecords(value.data);
        setLoading(false);
      })
      .catch(failure => {
        if (!abort.signal.aborted) {
          setError((failure as Error).message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [api, taskId, attempt]);
  const now = Date.now() + offset.current;
  const deadlines = records
    .map(item => Date.parse(item.expires_at))
    .filter(deadline => deadline > now);
  const next = deadlines.length ? Math.min(...deadlines) : null;
  useEffect(() => {
    if (next === null) {
      return;
    }
    const timer = setTimeout(
      () => redraw(value => value + 1),
      Math.max(0, next - Date.now() - offset.current)
    );
    return () => clearTimeout(timer);
  }, [next]);
  const name = username.trim();
  const invited =
    records.some(item => item.invitee.username === name && Date.parse(item.expires_at) > now) ||
    blocked.current.has(name);
  const unavailable = !api || !taskId || loading;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
  }, [api, taskId, attempt]);
  // 读取失败不能放行；发送失败不废弃此前已确认的记录。
  useEffect(() => {
    if (!loading && !error) {
      setLoaded(true);
    }
  }, [loading, error]);
  const send = async () => {
    if (!api || !taskId || busy.current || !loaded || !name || invited) {
      return;
    }
    const signal = controller.current?.signal;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api.send(taskId, name, permission, signal);
      if (signal?.aborted) {
        return;
      }
      setRecords(items => [
        ...items.filter(item => item.invitation_id !== result.invitation_id),
        result,
      ]);
    } catch (failure) {
      if (signal?.aborted) {
        return;
      }
      setError((failure as Error).message);
      const reason = (failure as { reason?: string }).reason;
      if (reason === 'ALREADY_COLLABORATOR') {
        blocked.current.add(name);
      }
      if (reason === 'INVITATION_COOLDOWN') {
        setLoaded(false);
        retry(value => value + 1);
      }
    } finally {
      busy.current = false;
      if (!signal?.aborted) {
        setPending(false);
      }
    }
  };
  return (
    <>
      <form
        className="business-username-invite"
        onSubmit={event => {
          event.preventDefault();
          void send();
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
            disabled={!api || !taskId || pending}
            onChange={event => {
              setUsername(event.target.value);
              if (loaded) {
                setError('');
              }
            }}
          />
        </label>
        <label
          className="business-field business-permission-field"
          htmlFor="collaboration-permission"
        >
          <span>权限</span>
          <select
            id="collaboration-permission"
            value={permission}
            disabled={pending}
            onChange={event => setPermission(event.target.value as CollaborationPermission)}
          >
            <option value="edit">可编辑</option>
            <option value="view">仅查看</option>
          </select>
        </label>
        <button
          className="business-action business-username-submit"
          type="submit"
          aria-label="按用户名邀请"
          disabled={unavailable || !loaded || pending || !name || invited}
        >
          {invited ? '已邀请' : pending ? '邀请中…' : '邀请'}
        </button>
      </form>
      {loading && (
        <p
          className="business-hint"
          role="status"
        >
          正在读取本人邀请记录…
        </p>
      )}
      {error && (
        <p
          className="business-error"
          role="alert"
        >
          {error}
        </p>
      )}
      {!loaded && !loading && api && taskId && (
        <button
          type="button"
          className="business-action"
          onClick={() => retry(value => value + 1)}
        >
          重新读取邀请状态
        </button>
      )}
    </>
  );
}
export default function CollaborationInviteDialog(props: Props) {
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
      {open && (
        <InviteBody
          key={props.taskId ?? 'unavailable'}
          {...props}
        />
      )}
    </BusinessDialog>
  );
}

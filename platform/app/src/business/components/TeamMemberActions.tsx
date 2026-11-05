import React, { useCallback, useEffect, useState } from 'react';
import { PersonIcon } from '@radix-ui/react-icons';
import type { MemberView, TeamInvitationApi } from '@ohif/core';
import BusinessDialog from './BusinessDialog';
import TeamInviteForm from './TeamInviteForm';

function Members({
  api,
  teamId,
  onContextLost,
}: {
  api?: TeamInvitationApi;
  teamId: string;
  onContextLost(): void;
}) {
  const [attempt, retry] = useState(0);
  const [state, setState] = useState<{ data?: MemberView[]; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    if (!api) {
      setState({ error: '真实成员服务不可用。' });
      return;
    }
    void api
      .listMembers(teamId, controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setState({ data });
      })
      .catch(failure => {
        if (!controller.signal.aborted && (failure as { status?: number })?.status === 404) {
          onContextLost();
          return;
        }
        if (!controller.signal.aborted)
          setState({
            error: failure instanceof Error ? failure.message : '成员读取未完成，请重试。',
          });
      });
    return () => controller.abort();
  }, [api, teamId, attempt, onContextLost]);
  if (state.error)
    return (
      <div role="alert">
        <p>成员名单读取未完成：{state.error}</p>
        <button
          type="button"
          onClick={() => retry(n => n + 1)}
        >
          重试
        </button>
      </div>
    );
  if (!state.data) return <p role="status">正在加载完整成员名单…</p>;
  return (
    <div
      className="team-member-list"
      role="list"
      aria-label="完整团队成员"
    >
      {state.data.map(member => (
        <div
          className="team-member-row"
          role="listitem"
          key={member.uid}
        >
          {member.avatar_url ? (
            <img
              className="business-avatar"
              src={member.avatar_url}
              alt=""
            />
          ) : (
            <span
              className="business-avatar"
              aria-hidden="true"
            >
              <PersonIcon />
            </span>
          )}
          <span>{member.username}</span>
        </div>
      ))}
      {!state.data.length && <p>暂无成员</p>}
    </div>
  );
}
/** 由路由按uid/team_id设key；切换上下文销毁弹窗及其请求，不共享可见表单状态。 */
export default function TeamMemberActions({
  api,
  teamId,
  onContextLost,
}: {
  api?: TeamInvitationApi;
  teamId: string;
  onContextLost?(): void;
}) {
  const [dialog, setDialog] = useState<'invite' | 'members' | null>(null);
  const [lost, setLost] = useState(false);
  const invalidateTeam = useCallback(() => {
    setDialog(null);
    setLost(true);
    onContextLost?.();
  }, [onContextLost]);
  if (lost)
    return (
      <div role="alert">
        当前团队资格已失效。
        <button
          type="button"
          onClick={onContextLost}
        >
          重试恢复团队
        </button>
      </div>
    );
  return (
    <div className="team-member-actions">
      <BusinessDialog
        title="邀请他人进入团队"
        variant="invite"
        open={dialog === 'invite'}
        onOpenChange={open => setDialog(open ? 'invite' : null)}
        trigger={<button type="button">新增团队成员</button>}
      >
        {dialog === 'invite' && (
          <TeamInviteForm
            api={api}
            teamId={teamId}
            onContextLost={invalidateTeam}
          />
        )}
      </BusinessDialog>
      <BusinessDialog
        title="查看团队成员"
        variant="members"
        open={dialog === 'members'}
        onOpenChange={open => setDialog(open ? 'members' : null)}
        trigger={<button type="button">查看团队成员</button>}
      >
        {dialog === 'members' && (
          <Members
            api={api}
            teamId={teamId}
            onContextLost={invalidateTeam}
          />
        )}
      </BusinessDialog>
    </div>
  );
}

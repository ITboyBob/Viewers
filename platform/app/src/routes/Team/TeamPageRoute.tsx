import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';
import useBusinessSession, { useBusinessServices } from '../../business/useBusinessSession';
import MemberOverlay from '../../business/components/MemberOverlay';
import NotificationDialog from '../../business/components/NotificationDialog';
import '../../business/components/BusinessDialogs.css';
import TeamPageContainer from './TeamPageContainer';
import type { TeamPageView } from './TeamPage';
import CreateTaskButton from './CreateTaskButton';
import useOpenTask from './useOpenTask';
import TaskPreview from './TaskPreview';
import TeamListOverlay from '../../business/components/TeamListOverlay';
import TeamMemberActions from '../../business/components/TeamMemberActions';
import useBusinessLogout from '../../business/useBusinessLogout';

function ConnectedTeamPage({ services, view }: { services: BusinessServices; view: TeamPageView }) {
  const navigate = useNavigate();
  const opener = useOpenTask(services);
  const logout = useBusinessLogout(services);
  const snapshot = useBusinessSession(services.session);
  const context = snapshot.status === 'authenticated' ? snapshot.context : null;
  const ownedTeam = context?.memberships.find(
    team =>
      team.team_id === context.default_team_id &&
      team.owner_uid === context.user.uid &&
      team.role === 'owner'
  );
  const currentTeam = context?.memberships.find(team => team.team_id === snapshot.currentTeamId);
  const [contextError, setContextError] = useState('');
  const recoverTeam = useCallback(() => {
    const current = services.session.getSnapshot();
    if (
      current.context?.user.uid !== context?.user.uid ||
      current.currentTeamId !== snapshot.currentTeamId
    )
      return;
    void (services.session.refreshContext?.() ?? services.session.validateCurrent())
      .then(() => setContextError(''))
      .catch(() => setContextError('团队资格恢复失败，请重试。'));
  }, [services, context?.user.uid, snapshot.currentTeamId]);
  const selectTeam = async (id: string) => {
    if (!services.session.selectTeam) throw new Error('团队选择服务不可用');
    let updated;
    try {
      updated = await services.session.selectTeam(id);
    } catch (failure) {
      const current = services.session.getSnapshot();
      if (
        (failure as { status?: number })?.status === 404 &&
        current.context?.user.uid === context?.user.uid &&
        current.currentTeamId === snapshot.currentTeamId
      )
        recoverTeam();
      throw failure;
    }
    if (updated.context?.user.uid !== context?.user.uid || updated.currentTeamId !== id)
      throw new Error('团队切换已取消');
    navigate('/team/tasks');
  };
  return (
    <TeamPageContainer
      teamSelectorSlot={
        context &&
        currentTeam && (
          <TeamListOverlay
            key={context.user.uid}
            teams={context.memberships}
            currentTeamId={snapshot.currentTeamId}
            onSelect={selectTeam}
            trigger={
              <button
                type="button"
                className="team-page-team-switch"
                aria-label={`切换团队：${currentTeam.name}`}
              >
                {currentTeam.name} ▾
              </button>
            }
          />
        )
      }
      teamActionsSlot={
        context &&
        currentTeam && (
          <TeamMemberActions
            key={`${context.user.uid}:${currentTeam.team_id}`}
            teamId={currentTeam.team_id}
            api={services.teamInvitations}
            onContextLost={recoverTeam}
          />
        )
      }
      view={view}
      services={services}
      onOpenTask={opener.open}
      openingTaskId={opener.opening}
      renderPreview={(taskId, generation) => (
        <TaskPreview
          taskId={taskId}
          accountUid={context?.user.uid ?? ''}
          permissionKey={JSON.stringify(context?.memberships)}
          refreshKey={generation}
          onOpen={() => opener.open(taskId)}
          opening={!!opener.opening}
          services={services}
        />
      )}
      canOpenTask={taskId =>
        !!services.taskStorage || !!services.localProjects?.getRetained?.(taskId)
      }
      taskStatusSlot={
        <>
          {contextError && (
            <p role="alert">
              {contextError}
              <button
                type="button"
                onClick={recoverTeam}
              >
                重试恢复团队
              </button>
            </p>
          )}
          {opener.opening && <p role="status">正在打开任务…</p>}
          {opener.error && <p role="alert">{opener.error}</p>}
        </>
      }
      onViewChange={next => navigate(next === 'team' ? '/team/tasks' : '/team/recent')}
      createTaskSlot={
        <CreateTaskButton
          key={`${context?.user.uid}:${view}`}
          services={services}
          teamId={
            view === 'team'
              ? context?.memberships.find(team => team.team_id === snapshot.currentTeamId)?.team_id
              : ownedTeam?.team_id
          }
        />
      }
      memberSlot={
        context &&
        ownedTeam && (
          <MemberOverlay
            key={context.user.uid}
            label="我的"
            onLogout={logout}
            user={context.user}
            ownedTeam={ownedTeam}
            teams={context.memberships}
            currentTeamId={snapshot.currentTeamId}
            onSelectTeam={selectTeam}
          />
        )
      }
      notificationSlot={
        context && (
          <NotificationDialog
            key={context.user.uid}
            user={context.user}
            api={services.teamInvitations}
            onAccepted={async () => {
              await (services.session.refreshContext?.() ?? services.session.validateCurrent());
            }}
          />
        )
      }
    />
  );
}

/** 受既有业务路由门禁保护；创建入口复用已有导入登记服务，不复制账号或协作邀请存储。 */
export default function TeamPageRoute({ view }: { view: TeamPageView }) {
  const services = useBusinessServices();
  if (!services) {
    return <div role="alert">业务服务尚未初始化，无法读取团队页。</div>;
  }
  return (
    <ConnectedTeamPage
      view={view}
      services={services}
    />
  );
}

import React from 'react';
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
  return (
    <TeamPageContainer
      view={view}
      services={services}
      onOpenTask={opener.open}
      openingTaskId={opener.opening}
      renderPreview={taskId => (
        <TaskPreview
          taskId={taskId}
          services={services}
        />
      )}
      canOpenTask={taskId =>
        !!services.taskStorage || !!services.localProjects?.getRetained?.(taskId)
      }
      taskStatusSlot={
        <>
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
            onSelectTeam={async id => {
              await services.session.selectTeam?.(id);
              navigate('/team/tasks');
            }}
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

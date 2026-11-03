import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';
import useBusinessSession, { useBusinessServices } from '../../business/useBusinessSession';
import MemberOverlay from '../../business/components/MemberOverlay';
import NotificationDialog from '../../business/components/NotificationDialog';
import '../../business/components/BusinessDialogs.css';
import TeamPageContainer from './TeamPageContainer';
import type { TeamPageView } from './TeamPage';

function ConnectedTeamPage({ services, view }: { services: BusinessServices; view: TeamPageView }) {
  const navigate = useNavigate();
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
      onViewChange={next => navigate(next === 'team' ? '/team/tasks' : '/team/recent')}
      memberSlot={
        context &&
        ownedTeam && (
          <MemberOverlay
            key={context.user.uid}
            user={context.user}
            ownedTeam={ownedTeam}
          />
        )
      }
      notificationSlot={
        context && (
          <NotificationDialog
            key={context.user.uid}
            user={context.user}
            api={services.teamInvitations}
          />
        )
      }
    />
  );
}

/** 受既有业务路由门禁保护；页面不创建账号、任务或协作邀请存储。 */
export default function TeamPageRoute({ view }: { view: TeamPageView }) {
  const services = useBusinessServices();
  if (!services) return <div role="alert">业务服务尚未初始化，无法读取团队页。</div>;
  return (
    <ConnectedTeamPage
      view={view}
      services={services}
    />
  );
}

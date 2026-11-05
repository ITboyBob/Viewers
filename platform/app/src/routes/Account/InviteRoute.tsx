import React from 'react';
import { useNavigate } from 'react-router-dom';
import useBusinessSession, { useBusinessServices } from '../../business/useBusinessSession';
import TeamInviteForm from '../../business/components/TeamInviteForm';
import AccountLayout from './AccountLayout';
import './InviteRoute.css';
import '../../business/components/BusinessFonts.css';

function ConnectedInvitation() {
  const services = useBusinessServices();
  const navigate = useNavigate();
  const snapshot = useBusinessSession(services!.session);
  const team = snapshot.context?.memberships.find(item => item.team_id === snapshot.currentTeamId);
  return team ? (
    <div className="account-form">
      <div className="account-card">
        <h2>邀请成员</h2>
        <p className="account-hint">邀请入队：{team.name}；接受邀请后才会入队。</p>
        <TeamInviteForm
          key={`${snapshot.context?.user.uid}:${team.team_id}`}
          api={services?.teamInvitations}
          teamId={team.team_id}
          onContextLost={() => {
            if (services!.session.getSnapshot().context?.user.uid !== snapshot.context?.user.uid)
              return;
            void (
              services!.session.refreshContext?.() ?? services!.session.validateCurrent()
            ).catch(() => undefined);
          }}
          onSent={() => navigate('/team/tasks')}
        >
          <button
            className="account-submit account-invite-skip"
            type="button"
            onClick={() => navigate('/team/tasks')}
          >
            跳过
          </button>
        </TeamInviteForm>
      </div>
    </div>
  ) : (
    <p role="alert">无法确认当前团队。</p>
  );
}
export default function InviteRoute() {
  const services = useBusinessServices();
  return (
    <AccountLayout mode="invite">
      {services ? (
        <ConnectedInvitation />
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

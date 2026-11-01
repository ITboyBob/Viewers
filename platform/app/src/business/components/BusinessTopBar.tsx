import React from 'react';
import type { BusinessServices } from '@ohif/core';
import useBusinessSession from '../useBusinessSession';
import MemberOverlay from './MemberOverlay';
import NotificationDialog from './NotificationDialog';
import CollaborationInviteDialog from './CollaborationInviteDialog';
import '../../routes/Account/AccountFonts.css';
import './BusinessDialogs.css';
import './BusinessFonts.css';

export default function BusinessTopBar({
  page,
  services,
}: {
  page: 'import' | 'viewer';
  services: BusinessServices;
}) {
  const snapshot = useBusinessSession(services.session);
  if (snapshot.status !== 'authenticated' || !snapshot.context) {
    return null;
  }
  const user = snapshot.context.user;
  const store = services.collaborationMock?.forUser(user);
  return (
    <div
      className="business-topbar"
      role="toolbar"
      aria-label={page === 'import' ? '导入业务入口' : '标注业务入口'}
      onClick={event => event.stopPropagation()}
      onDrop={event => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <MemberOverlay
        key={`member:${user.uid}`}
        user={user}
      />
      <NotificationDialog
        key={`notifications:${user.uid}`}
        api={services.teamInvitations}
        store={store}
        user={user}
      />
      {page === 'viewer' && (
        <CollaborationInviteDialog
          key={`invite:${user.uid}`}
          store={store}
        />
      )}
    </div>
  );
}

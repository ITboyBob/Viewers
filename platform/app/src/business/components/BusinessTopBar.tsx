import React, { useEffect, useReducer } from 'react';
import SharedLinkButton from './SharedLinkButton';
import type { BusinessServices } from '@ohif/core';
import useBusinessSession from '../useBusinessSession';
import MemberOverlay from './MemberOverlay';
import TaskMembersOverlay from './TaskMembersOverlay';
import NotificationDialog from './NotificationDialog';
import CollaborationInviteDialog from './CollaborationInviteDialog';
import '../../routes/Account/AccountFonts.css';
import './BusinessDialogs.css';
import './BusinessFonts.css';

export default function BusinessTopBar({
  page,
  services,
  taskMembers = false,
}: {
  page: 'import' | 'viewer';
  services: BusinessServices;
  taskMembers?: boolean;
}) {
  const snapshot = useBusinessSession(services.session);
  const [, refreshSharing] = useReducer(value => value + 1, 0);
  const shared = services.localCollaboration;
  useEffect(() => shared?.publisher?.subscribe(refreshSharing), [shared?.publisher]);
  useEffect(() => services.localProjects?.subscribe(refreshSharing), [services.localProjects]);
  const currentProject = services.projectRuntime?.getCurrent?.();
  const taskId =
    page === 'viewer' &&
    taskMembers &&
    currentProject?.mode_path === 'segmentation/dicomlocal' &&
    currentProject.phase === 'registered'
      ? currentProject.task_id
      : undefined;
  const source = shared?.identities.getSource();
  const sharingReady =
    source?.getSnapshot().publication_phase === 'ready' &&
    shared?.participation?.getSnapshot().phase === 'active';
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
      {taskId && services.teamPage ? (
        <TaskMembersOverlay
          key={`task-members:${user.uid}`}
          taskId={taskId}
          api={services.teamPage}
          identityKey={user.uid}
        />
      ) : (
        <MemberOverlay
          key={`member:${user.uid}`}
          user={user}
        />
      )}
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
      {page === 'viewer' && sharingReady && (
        <SharedLinkButton
          key={source.task_id}
          taskId={source.task_id}
        />
      )}
    </div>
  );
}

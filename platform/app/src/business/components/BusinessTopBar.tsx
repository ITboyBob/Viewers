import React, { useCallback, useSyncExternalStore } from 'react';
import SharedLinkButton from './SharedLinkButton';
import type { BusinessServices } from '@ohif/core';
import useBusinessSession from '../useBusinessSession';
import useBusinessLogout from '../useBusinessLogout';
import MemberOverlay from './MemberOverlay';
import TaskMembersOverlay from './TaskMembersOverlay';
import NotificationDialog from './NotificationDialog';
import CollaborationInviteDialog from './CollaborationInviteDialog';
import '../../routes/Account/AccountFonts.css';
import './BusinessDialogs.css';
import './BusinessFonts.css';

const noSharedTask = () => null;

function useSharedLinkTask(services: BusinessServices) {
  const shared = services.localCollaboration;
  const subscribe = useCallback(
    (listener: () => void) => {
      let participation = shared?.participation;
      let stopParticipation = participation?.subscribe(listener);
      const update = () => {
        if (participation !== shared?.participation) {
          stopParticipation?.();
          participation = shared?.participation;
          stopParticipation = participation?.subscribe(listener);
        }
        listener();
      };
      const stops = [
        shared?.publisher?.subscribe(update),
        shared?.sharedView?.subscribe(update),
        services.session.subscribe(update),
        services.localProjects?.subscribe(update),
      ];
      return () => {
        stops.forEach(stop => stop?.());
        stopParticipation?.();
      };
    },
    [services, shared]
  );
  const read = useCallback(() => {
    if (services.session.getSnapshot().status !== 'authenticated') {
      return null;
    }
    const source = shared?.identities.getSource();
    return source?.getSnapshot().publication_phase === 'ready' &&
      shared?.participation?.getSnapshot().phase === 'active'
      ? source.task_id
      : null;
  }, [services, shared]);
  // UUID/null 是稳定快照；React 会补查 render 与 subscribe 之间的状态变化。
  return useSyncExternalStore(subscribe, read, noSharedTask);
}

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
  const logout = useBusinessLogout(services);
  const sharedTaskId = useSharedLinkTask(services);
  const currentProject = services.projectRuntime?.getCurrent?.();
  const taskId =
    page === 'viewer' &&
    taskMembers &&
    currentProject?.mode_path === 'segmentation/dicomlocal' &&
    currentProject.phase === 'registered'
      ? currentProject.task_id
      : undefined;
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
          onLogout={logout}
        />
      )}
      {page === 'import' && (
        <NotificationDialog
          key={`notifications:${user.uid}`}
          api={services.teamInvitations}
          store={store}
          user={user}
        />
      )}
      {page === 'viewer' && (
        <CollaborationInviteDialog
          key={`invite:${user.uid}`}
          store={store}
        />
      )}
      {page === 'viewer' && sharedTaskId && (
        <SharedLinkButton
          key={sharedTaskId}
          taskId={sharedTaskId}
        />
      )}
    </div>
  );
}

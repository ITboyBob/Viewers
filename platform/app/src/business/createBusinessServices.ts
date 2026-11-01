import React from 'react';
import BusinessTopBar from './components/BusinessTopBar';
import type { BusinessConfiguration, BusinessServices } from '@ohif/core';
import { BusinessApiClient } from './BusinessApiClient';
import { LocalProjectService } from './LocalProjectService';
import { TaskService } from './TaskService';
import { ProjectRuntimeService } from './ProjectRuntimeService';
import { BusinessSessionService } from './BusinessSessionService';
import { TeamInvitationService } from './TeamInvitationService';
import { CollaborationMockStore } from './mock/CollaborationMockStore';
import { LocalParticipationIdentity } from './localCollaboration/LocalParticipationIdentity';
import { SharedFileStore } from './localCollaboration/SharedFileStore';
import { SharedFilePublisher } from './localCollaboration/SharedFilePublisher';
import type { SharedFilePort } from '@ohif/core';

type Dependencies = {
  fetch?: typeof fetch;
  storage?: Storage | null;
  timeoutMs?: number;
  clock?: () => number;
  sharedFiles?: SharedFilePort;
  basePath?: string;
};
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function createBusinessServices(
  configuration: BusinessConfiguration,
  dependencies: Dependencies = {}
): BusinessServices {
  const api = new BusinessApiClient({
    fetch: dependencies.fetch,
    timeoutMs: dependencies.timeoutMs,
    getToken: () => session.getToken(),
    getRevision: () => session.getRevision(),
    onUnauthorized: () => session.invalidate(),
  });
  const session = new BusinessSessionService(
    api,
    dependencies.storage === undefined ? browserStorage() : dependencies.storage
  );
  // 只比较既有session的凭证变化，派生不透明generation，不把凭证传入project。
  // validateCurrent的请求revision会改变，但同一凭证的正常校验不应废弃项目。
  let observedCredential = session.getToken();
  let identityGeneration = 0;
  session.subscribe(() => {
    const current = session.getToken();
    if (current !== observedCredential) {
      observedCredential = current;
      identityGeneration++;
    }
  });
  const localProjects = new LocalProjectService(session, {
    identityGeneration: () => identityGeneration,
  });
  const tasks = new TaskService(api, localProjects);
  const projectRuntime = new ProjectRuntimeService(localProjects, tasks, project => {
    const participant = services.localCollaboration?.participation;
    if (
      participant?.identity.role === 'source' &&
      participant.identity.task_id === project.task_id
    ) {
      participant.close(
        session.getSnapshot().status === 'invalid' ? 'identity_invalid' : 'source_invalid'
      );
    }
    services.localCollaboration?.publisher?.cancel(project);
  });
  const services: BusinessServices = {
    api,
    session,
    localProjects,
    tasks,
    projectRuntime,
    teamInvitations: new TeamInvitationService(api),
  };
  if (configuration.enabled) {
    const identities = new LocalParticipationIdentity(
      session,
      localProjects,
      () => identityGeneration,
      undefined,
      (identity, reason) => {
        const project = projectRuntime.getCurrent();
        if (
          identity.role === 'source' &&
          (identity.session_generation !== identityGeneration ||
            session.getSnapshot().status === 'invalid' ||
            project?.phase === 'invalid' ||
            project?.phase === 'disposed')
        ) {
          projectRuntime.getHandle()?.deactivate();
        }
        if (services.localCollaboration?.participation?.identity === identity) {
          services.localCollaboration.participation.close(reason);
        }
      }
    );
    const files =
      dependencies.sharedFiles ?? new SharedFileStore({ basePath: dependencies.basePath });
    services.localCollaboration = {
      identities,
      files,
      publisher: new SharedFilePublisher({
        session,
        projects: localProjects,
        identities,
        files,
        generation: () => identityGeneration,
      }),
    };
    const stores = new Map<string, CollaborationMockStore>();
    const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
    services.collaborationMock = {
      forUser: user => {
        if (!stores.has(user.uid)) {
          stores.set(user.uid, new CollaborationMockStore(user, storage, dependencies.clock));
        }
        return stores.get(user.uid)!;
      },
    };
    services.ui = {
      renderHeader: ({ page }) => React.createElement(BusinessTopBar, { page, services }),
    };
  }
  return services;
}

export const businessServicesRegistration = {
  name: 'businessServices',
  create: ({ configuration }: { configuration: BusinessConfiguration }) =>
    createBusinessServices(configuration),
};

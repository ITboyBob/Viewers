import React from 'react';
import BusinessTopBar from './components/BusinessTopBar';
import type { BusinessConfiguration, BusinessServices } from '@ohif/core';
import { BusinessApiClient } from './BusinessApiClient';
import { LocalProjectService } from './LocalProjectService';
import { TaskService } from './TaskService';
import { TeamPageService } from './TeamPageService';
import { ProjectRuntimeService } from './ProjectRuntimeService';
import { BusinessSessionService } from './BusinessSessionService';
import { TeamInvitationService } from './TeamInvitationService';
import { CollaborationMockStore } from './mock/CollaborationMockStore';
import { LocalParticipationIdentity } from './localCollaboration/LocalParticipationIdentity';
import { SharedFileStore } from './localCollaboration/SharedFileStore';
import { SharedFilePublisher } from './localCollaboration/SharedFilePublisher';
import { DicomMetadataStore } from '@ohif/core';
import type { SharedFilePort, LocalChannelPort, LocalClockPort, ImportBatch } from '@ohif/core';
import { LocalParticipationService } from './localCollaboration/LocalParticipationService';
import { SourceSessionVerifier } from './localCollaboration/SourceSessionVerifier';
import { SharedViewService } from './localCollaboration/SharedViewService';
import { routerBasename } from '../utils/publicUrl';

type Dependencies = {
  fetch?: typeof fetch;
  storage?: Storage | null;
  timeoutMs?: number;
  clock?: () => number;
  sharedFiles?: SharedFilePort;
  basePath?: string;
  sharingClock?: LocalClockPort;
  channelFactory?: (name: string) => LocalChannelPort;
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
    services.teamPage = new TeamPageService(api);
    const basePath = (dependencies.basePath ?? routerBasename).replace(/\/+$/, '') || '/';
    const sharingClock: LocalClockPort = dependencies.sharingClock ?? {
      now: () => performance.now(),
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const createChannel = (taskId: string): LocalChannelPort => {
      const name = `colla.local-shared.v1:${JSON.stringify([basePath, taskId])}`;
      if (dependencies.channelFactory) {
        return dependencies.channelFactory(name);
      }
      const channel = new BroadcastChannel(name);
      return {
        postMessage: message => channel.postMessage(message),
        subscribe: listener => {
          const receive = (event: MessageEvent<unknown>) => listener(event.data);
          channel.addEventListener('message', receive);
          return () => channel.removeEventListener('message', receive);
        },
        close: () => channel.close(),
      };
    };
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
    const files = dependencies.sharedFiles ?? new SharedFileStore({ basePath });
    let releaseSharedBatch: ((batch: ImportBatch) => unknown) | undefined;
    services.localCollaboration = {
      identities,
      files,
      sharedView: new SharedViewService({
        session,
        generation: () => identityGeneration,
        files,
        createParticipation: taskId =>
          services.localCollaboration!.createViewerParticipation!(taskId),
        parse: async input => {
          const loader = await import('../routes/Local/filesToImportBatch');
          releaseSharedBatch = loader.releaseImportBatch;
          return loader.default(input);
        },
        release: batch => releaseSharedBatch?.(batch),
        prepareScope: (id, datasets) => DicomMetadataStore.prepareLocalImportScope(id, datasets),
      }),
      createViewerParticipation: taskId => {
        const identity = identities.viewer(taskId);
        let channel: LocalChannelPort | undefined;
        try {
          channel = createChannel(taskId);
          const participation = new LocalParticipationService({
            identity,
            channel,
            clock: sharingClock,
          });
          services.localCollaboration!.participation = participation;
          return participation;
        } catch (error) {
          channel?.close();
          identity.close();
          throw error;
        }
      },
      publisher: new SharedFilePublisher({
        session,
        projects: localProjects,
        identities,
        files,
        generation: () => identityGeneration,
      }),
    };
    const shared = services.localCollaboration;
    shared.publisher!.subscribe(() => {
      const source = identities.getSource();
      if (
        !source ||
        source.getSnapshot().publication_phase !== 'ready' ||
        shared.participation?.identity === source.identity
      ) {
        return;
      }
      let channel: LocalChannelPort | undefined;
      try {
        channel = createChannel(source.task_id);
        shared.participation = new LocalParticipationService({
          identity: source.identity,
          source,
          channel,
          clock: sharingClock,
          verifier: new SourceSessionVerifier({ api, session, identity: source.identity }),
        });
      } catch (_error) {
        channel?.close();
        source.setPublication('failed', undefined, '此浏览器无法建立本地共享连接');
      }
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        projectRuntime.getHandle()?.deactivate();
        shared.sharedView?.dispose();
        shared.participation?.close('exit');
        shared.publisher?.cancel();
      });
    }
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
      renderHeader: options => React.createElement(BusinessTopBar, { ...options, services }),
    };
  }
  return services;
}

export const businessServicesRegistration = {
  name: 'businessServices',
  create: ({ configuration }: { configuration: BusinessConfiguration }) =>
    createBusinessServices(configuration),
};

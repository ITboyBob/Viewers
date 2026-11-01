import React from 'react';
import BusinessTopBar from './components/BusinessTopBar';
import type { BusinessConfiguration, BusinessServices } from '@ohif/core';
import { BusinessApiClient } from './BusinessApiClient';
import { BusinessSessionService } from './BusinessSessionService';
import { TeamInvitationService } from './TeamInvitationService';
import { CollaborationMockStore } from './mock/CollaborationMockStore';

type Dependencies = {
  fetch?: typeof fetch;
  storage?: Storage | null;
  timeoutMs?: number;
  clock?: () => number;
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
  const services: BusinessServices = {
    api,
    session,
    teamInvitations: new TeamInvitationService(api),
  };
  if (configuration.enabled) {
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

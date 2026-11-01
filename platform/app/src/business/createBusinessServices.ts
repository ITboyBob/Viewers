import type { BusinessConfiguration, BusinessServices } from '@ohif/core';
import { BusinessApiClient } from './BusinessApiClient';
import { BusinessSessionService } from './BusinessSessionService';

type Dependencies = { fetch?: typeof fetch; storage?: Storage | null; timeoutMs?: number };
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
  return { api, session };
}

export const businessServicesRegistration = {
  name: 'businessServices',
  create: ({ configuration }: { configuration: BusinessConfiguration }) =>
    createBusinessServices(configuration),
};

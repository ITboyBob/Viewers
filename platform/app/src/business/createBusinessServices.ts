import type { BusinessConfiguration, BusinessServices } from '@ohif/core';
import { BusinessApiClient } from './BusinessApiClient';
import { LocalProjectService } from './LocalProjectService';
import { TaskService } from './TaskService';
import { ProjectRuntimeService } from './ProjectRuntimeService';
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
  const projectRuntime = new ProjectRuntimeService(localProjects);
  return { api, session, localProjects, tasks, projectRuntime };
}

export const businessServicesRegistration = {
  name: 'businessServices',
  create: ({ configuration }: { configuration: BusinessConfiguration }) =>
    createBusinessServices(configuration),
};

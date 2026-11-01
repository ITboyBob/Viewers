import { useCallback, useSyncExternalStore } from 'react';
import { useSystem } from '@ohif/core';
import type { BusinessSession } from '@ohif/core';

export function useBusinessServices() {
  return useSystem()?.servicesManager?.services.businessServices;
}
export default function useBusinessSession(session: BusinessSession) {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const read = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, read, read);
}

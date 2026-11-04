import { useCallback, useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
export default function useTaskReadOnly() {
  const { servicesManager } = useSystem();
  const read = useCallback(
    () =>
      servicesManager.services.businessServices?.projectRuntime?.getCurrent?.()?.can_edit === false,
    [servicesManager]
  );
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener('colla:task-access', update);
    update();
    return () => window.removeEventListener('colla:task-access', update);
  }, [read]);
  return value;
}

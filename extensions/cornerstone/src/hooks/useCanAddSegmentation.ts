import { useCallback, useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
import { canCreateSegmentation } from '../utils/SegmentationCreationPermission';
export default function useCanAddSegmentation() {
  const { servicesManager } = useSystem();
  const read = useCallback(
    () => canCreateSegmentation(servicesManager.services),
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

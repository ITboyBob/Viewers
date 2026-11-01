import React, { useEffect } from 'react';
import type { ProjectModeLifecycle } from '@ohif/core';
/** 覆盖交接后、Mode挂载前的身份门禁等待／拒绝窗口；与Mode共用同一释放边界。 */
export default function ProjectRouteBoundary({
  lifecycle,
  children,
}: React.PropsWithChildren<{ lifecycle?: ProjectModeLifecycle | null }>) {
  useEffect(() => () => lifecycle?.dispose(), [lifecycle]);
  return <>{children}</>;
}

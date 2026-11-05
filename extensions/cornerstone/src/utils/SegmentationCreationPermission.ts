import type { LocalProject } from '@ohif/core';
type Services = {
  businessServices?: {
    projectRuntime?: { phaseOneMask?: boolean; getCurrent?(): LocalProject | null };
  };
};
/** 非业务模式不受影响；业务能力未知时仅禁止创建新的 segmentation。 */
export function canCreateSegmentation(services: Services): boolean {
  const runtime = services.businessServices?.projectRuntime,
    project = runtime?.getCurrent?.();
  if (!project) {
    return !runtime?.phaseOneMask;
  }
  return (
    project.phase !== 'invalid' &&
    project.phase !== 'disposed' &&
    project.can_edit !== false &&
    project.can_add_segmentation === true
  );
}

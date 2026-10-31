const circleTools: Record<string, string> = {
  SphereBrush: 'CircularBrush',
  SphereEraser: 'CircularEraser',
  ThresholdSphereBrush: 'ThresholdCircularBrush',
  ThresholdSphereBrushDynamic: 'ThresholdCircularBrushDynamic',
  SphereScissor: 'CircleScissor',
};

export function isSphereTool(toolName: string) {
  return Object.prototype.hasOwnProperty.call(circleTools, toolName);
}

/** Check the same geometry contract as Cornerstone before entering a sphere strategy. */
export function supportsSphereTools(
  imageIds: string[],
  reconstructable: boolean | undefined,
  isValidVolume: (ids: string[]) => boolean
) {
  if (!imageIds || imageIds.length < 2 || reconstructable === false) return false;
  try {
    return Boolean(isValidVolume(imageIds));
  } catch {
    // Missing geometry metadata is unsupported until it finishes loading.
    return false;
  }
}

export function getCircleTool(toolName: string) {
  return circleTools[toolName] || toolName;
}

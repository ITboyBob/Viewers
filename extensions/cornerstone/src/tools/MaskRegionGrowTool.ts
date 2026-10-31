import { BaseTool } from '@cornerstonejs/tools';
import { getEnabledElement } from '@cornerstonejs/core';

/** Pick an image-space seed using Cornerstone's own viewport coordinate transform. */
export default class MaskRegionGrowTool extends BaseTool {
  static toolName = 'MaskRegionGrow';

  constructor(
    toolProps = {},
    defaultToolProps = { supportedInteractionTypes: ['Mouse'], configuration: {} }
  ) {
    super(toolProps, defaultToolProps);
  }

  preMouseDownCallback = evt => {
    const { element, currentPoints } = evt.detail;
    const viewport = getEnabledElement(element)?.viewport;
    if (!viewport) return false;
    evt.preventDefault();
    // The command reports completion and errors to the mask panel. Handle its
    // rejected promise here so a failed seed never becomes a runtime overlay.
    Promise.resolve(
      this.configuration.onSeed?.({
        viewportId: viewport.id,
        worldPoint: [...currentPoints.world],
      })
    ).catch(() => {});
    return true;
  };
}

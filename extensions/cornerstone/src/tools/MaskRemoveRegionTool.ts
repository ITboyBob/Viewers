import MaskRegionGrowTool from './MaskRegionGrowTool';
/** Same image-space picking as Region Grow; its callback prepares a deletion preview. */
export default class MaskRemoveRegionTool extends MaskRegionGrowTool {
  static toolName = 'MaskRemoveRegion';
}

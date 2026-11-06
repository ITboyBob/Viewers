import { eventTarget } from '@cornerstonejs/core';
import { validateRoi, maskRoiSettings } from './maskRoi';
import type { MaskRoi } from './maskRoi';
export const MASK_ROI_EVENT = 'OHIF_MASK_ROI_CHANGED';
export function setMaskRoi(seriesInstanceUID: string, roi?: MaskRoi) {
  if (roi) {
    validateRoi(roi);
    if (roi.seriesInstanceUID !== seriesInstanceUID) throw new Error('ROI 与目标序列不匹配。');
  }
  const before = JSON.stringify(maskRoiSettings.get(seriesInstanceUID) || null);
  if (before === JSON.stringify(roi || null)) return;
  if (roi) maskRoiSettings.set(seriesInstanceUID, structuredClone(roi));
  else maskRoiSettings.delete(seriesInstanceUID);
  eventTarget.dispatchEvent(new CustomEvent(MASK_ROI_EVENT, { detail: { seriesInstanceUID } }));
}

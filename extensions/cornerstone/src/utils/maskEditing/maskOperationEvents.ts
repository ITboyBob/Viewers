import { eventTarget } from '@cornerstonejs/core';

export const MASK_OPERATION_EVENT = 'OHIF_MASK_VOLUME_OPERATION';
export const MASK_BRUSH_SIZE_EVENT = 'OHIF_MASK_BRUSH_SIZE';
export type MaskOperationStatus = {
  phase: 'start' | 'progress' | 'complete' | 'error';
  message: string;
};

let applying = false;
export const isMaskOperationActive = () => applying;

export function reportMaskOperation(phase: MaskOperationStatus['phase'], message: string) {
  applying = phase === 'start' || phase === 'progress';
  eventTarget.dispatchEvent(
    new CustomEvent<MaskOperationStatus>(MASK_OPERATION_EVENT, {
      detail: { phase, message },
    })
  );
}

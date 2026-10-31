import { eventTarget } from '@cornerstonejs/core';

export const MASK_OPERATION_EVENT = 'OHIF_MASK_VOLUME_OPERATION';
export type MaskOperationStatus = {
  phase: 'start' | 'progress' | 'complete' | 'error';
  message: string;
};

export function reportMaskOperation(phase: MaskOperationStatus['phase'], message: string) {
  eventTarget.dispatchEvent(
    new CustomEvent<MaskOperationStatus>(MASK_OPERATION_EVENT, {
      detail: { phase, message },
    })
  );
}

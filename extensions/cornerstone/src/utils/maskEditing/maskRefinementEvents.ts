import { eventTarget } from '@cornerstonejs/core';
import type { RefinementOperation } from './refinementAlgorithms';
export const MASK_REFINEMENT_EVENT = 'OHIF_MASK_REFINEMENT_PREVIEW';
export const MASK_REFINEMENT_TASK_EVENT = 'OHIF_MASK_REFINEMENT_TASK';
export type MaskRefinementTask = {
  id: string;
  segmentationId: string;
  segmentIndex: number;
  phase: 'running' | 'cancelling' | 'cancelled' | 'complete' | 'error';
  stage: 'prepare' | 'compute' | 'validate';
  percent: number;
  message: string;
};
export function publishRefinementTask(task: MaskRefinementTask) {
  eventTarget.dispatchEvent(new CustomEvent(MASK_REFINEMENT_TASK_EVENT, { detail: task }));
}
export type MaskRefinementPreview = {
  id: string;
  operation: RefinementOperation;
  segmentationId: string;
  segmentIndex: number;
  label: string;
  added: number;
  removed: number;
  before: number;
  after: number;
  voxelVolumeMm3: number;
  sliceCount: number;
  components?: number;
  removedComponents?: number;
  radiusMm?: number;
  minimumVolumeMm3?: number;
};
export function publishRefinementPreview(preview?: MaskRefinementPreview) {
  eventTarget.dispatchEvent(new CustomEvent(MASK_REFINEMENT_EVENT, { detail: { preview } }));
}

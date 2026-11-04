import { eventTarget } from '@cornerstonejs/core';
import { Enums, segmentation } from '@cornerstonejs/tools';
import { MASK_ROI_EVENT } from './maskRoiStore';
import { maskRoiSettings } from './maskRoi';
import { metaData, cache } from '@cornerstonejs/core';

export const MASK_PROGRESS_EVENT = 'OHIF_MASK_PROGRESS';
export const maskDraftPauseReasons = new Set<string>();
export type MaskProgress = {
  revision: number;
  savedRevision: number;
  draftRevision: number;
  draftAt?: string;
  error?: string;
  savedFingerprint?: string;
};

/** Revision tokens prevent a slow save from marking newer edits as saved. */
export class MaskProgressStore {
  private entries = new Map<string, MaskProgress>();
  constructor(private notify = () => {}) {}
  get(id: string): MaskProgress {
    return this.entries.get(id) || { revision: 0, savedRevision: 0, draftRevision: -1 };
  }
  change(id: string) {
    this.entries.set(id, {
      ...this.get(id),
      revision: this.get(id).revision + 1,
      error: undefined,
    });
    this.notify();
  }
  saved(id: string, revision: number, savedFingerprint?: string) {
    this.entries.set(id, {
      ...this.get(id),
      savedRevision: revision,
      savedFingerprint,
      error: undefined,
    });
    this.notify();
  }
  drafted(id: string, revision: number, draftAt: string, fingerprint?: string) {
    const previous = this.get(id);
    const unchanged =
      fingerprint && fingerprint === previous.savedFingerprint && previous.revision === revision;
    this.entries.set(id, {
      ...previous,
      savedRevision: unchanged ? revision : previous.savedRevision,
      draftRevision: revision,
      draftAt,
      error: undefined,
    });
    this.notify();
  }
  failed(id: string, error: string) {
    this.entries.set(id, { ...this.get(id), error });
    this.notify();
  }
  remove(id: string) {
    this.entries.delete(id);
    this.notify();
  }
  clear() {
    this.entries.clear();
    this.notify();
  }
  dirty(id: string) {
    const state = this.get(id);
    return state.revision !== state.savedRevision;
  }
  dirtyIds() {
    return [...this.entries.keys()].filter(id => this.dirty(id));
  }
}

export const maskProgress = new MaskProgressStore(() =>
  eventTarget.dispatchEvent(new CustomEvent(MASK_PROGRESS_EVENT))
);

export function trackMaskProgress(servicesManager, commandsManager) {
  const service = servicesManager.services.segmentationService;
  const pointers = new Set<number>();
  const pointerDown = (event: PointerEvent) => {
    const viewports =
      servicesManager.services.cornerstoneViewportService?.getRenderingEngine()?.getViewports() ||
      [];
    if (viewports.some(viewport => viewport.element.contains(event.target as Node)))
      pointers.add(event.pointerId);
  };
  const pointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    schedule();
  };
  window.addEventListener('pointerdown', pointerDown, true);
  window.addEventListener('pointerup', pointerUp, true);
  window.addEventListener('pointercancel', pointerUp, true);
  const signatures = new Map<string, string>();
  function metadata(id: string) {
    const current = service.getSegmentation(id);
    if (!current?.representationData.Labelmap) return;
    const viewportId = service.getViewportIdsWithSegmentation(id)[0];
    // A layout can temporarily detach every representation; that is not an edit.
    if (!viewportId && signatures.has(id)) return;
    const signature = JSON.stringify({
      label: current.label,
      representationVisible:
        viewportId &&
        segmentation.config.visibility.getSegmentationRepresentationVisibility?.(viewportId, {
          segmentationId: id,
          type: Enums.SegmentationRepresentations.Labelmap,
        }),
      segments: Object.values(current.segments).map((segment: any) => {
        const style =
          viewportId &&
          service.getStyle({
            viewportId,
            segmentationId: id,
            segmentIndex: segment.segmentIndex,
            type: 'Labelmap',
          });
        return [
          segment.segmentIndex,
          segment.label,
          segment.locked,
          viewportId && service.getSegmentColor(viewportId, id, segment.segmentIndex),
          viewportId &&
            segmentation.config.visibility.getSegmentIndexVisibility(
              viewportId,
              { segmentationId: id, type: Enums.SegmentationRepresentations.Labelmap },
              segment.segmentIndex
            ),
          style && [style.fillAlpha, style.outlineWidth, style.renderFill, style.renderOutline],
        ];
      }),
    });
    if (signatures.get(id) !== signature) {
      signatures.set(id, signature);
      maskProgress.change(id);
    }
  }
  const subscriptions = [
    service.subscribe(service.EVENTS.SEGMENTATION_MODIFIED, ({ segmentationId }) =>
      metadata(segmentationId)
    ),
    service.subscribe(service.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED, ({ segmentationId }) =>
      metadata(segmentationId)
    ),
    service.subscribe(service.EVENTS.SEGMENTATION_DATA_MODIFIED, ({ segmentationId }) => {
      if (service.getSegmentation(segmentationId)?.representationData.Labelmap)
        maskProgress.change(segmentationId);
    }),
    service.subscribe(service.EVENTS.SEGMENTATION_REMOVED, ({ segmentationId }) => {
      signatures.delete(segmentationId);
      maskProgress.remove(segmentationId);
    }),
  ];
  service.getSegmentations().forEach(item => metadata(item.segmentationId));
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (maskProgress.dirtyIds().length) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  const roiChanged = (event: CustomEvent<{ seriesInstanceUID: string }>) => {
    for (const item of service.getSegmentations()) {
      if (!item.representationData.Labelmap) continue;
      const ids: unknown = segmentation.getLabelmapImageIds(item.segmentationId);
      const referenceId = Array.isArray(ids) && cache.getImage(ids[0])?.referencedImageId;
      if (
        referenceId &&
        metaData.get('instance', referenceId)?.SeriesInstanceUID === event.detail.seriesInstanceUID
      )
        maskProgress.change(item.segmentationId);
    }
  };
  eventTarget.addEventListener(MASK_ROI_EVENT, roiChanged);
  let stopped = false,
    running = false,
    timer: ReturnType<typeof setTimeout>;
  const needsDraft = () =>
    maskProgress.dirtyIds().filter(id => {
      const state = maskProgress.get(id);
      return state.revision !== state.draftRevision && !state.error;
    });
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped && needsDraft().length) timer = setTimeout(backup, 5000);
  };
  async function backup() {
    if (stopped || running) return;
    if (pointers.size || maskDraftPauseReasons.size) {
      schedule();
      return;
    }
    running = true;
    try {
      for (const id of needsDraft()) {
        if (stopped) break;
        try {
          await commandsManager.run('backupMaskProject', { segmentationId: id });
        } catch (error) {
          const message = error instanceof Error ? error.message : '本地暂存失败，请手动保存。';
          if (!message.includes('正在处理')) maskProgress.failed(id, message);
        }
      }
    } finally {
      running = false;
      schedule();
    }
  }
  eventTarget.addEventListener(MASK_PROGRESS_EVENT, schedule);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    eventTarget.removeEventListener(MASK_PROGRESS_EVENT, schedule);
    subscriptions.forEach(subscription => subscription.unsubscribe());
    window.removeEventListener('beforeunload', beforeUnload);
    eventTarget.removeEventListener(MASK_ROI_EVENT, roiChanged);
    maskRoiSettings.clear();
    window.removeEventListener('pointerdown', pointerDown, true);
    window.removeEventListener('pointerup', pointerUp, true);
    window.removeEventListener('pointercancel', pointerUp, true);
    maskDraftPauseReasons.clear();
    maskProgress.clear();
  };
}

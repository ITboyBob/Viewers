import * as cornerstoneTools from '@cornerstonejs/tools';
import { updateSegmentationStats } from './updateSegmentationStats';

/**
 * Sets up the handler for segmentation data modification events
 */
export function setupSegmentationDataModifiedHandler({
  segmentationService,
  customizationService,
  commandsManager,
}) {
  // A flag to indicate if the event is unsubscribed to. This is important because
  // the debounced callback does an await and in that period of time the event may have
  // been unsubscribed.
  let isUnsubscribed = false;
  // Invalidate in-flight calculations immediately, rather than waiting for the debounce.
  const revisions = new Map<string, number>();
  const { unsubscribe: invalidateUnsubscribe } = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
    ({ segmentationId }) => revisions.set(segmentationId, (revisions.get(segmentationId) || 0) + 1)
  );
  const { unsubscribe: debouncedUnsubscribe } = segmentationService.subscribeDebounced(
    segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
    async ({ segmentationId }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        return;
      }

      const readableText = customizationService.getCustomization('panelSegmentation.readableText');
      const revision = revisions.get(segmentationId) || 0;
      const isCurrent = () =>
        !isUnsubscribed &&
        (revisions.get(segmentationId) || 0) === revision &&
        Boolean(segmentationService.getSegmentation(segmentationId));

      // Check for segments with bidirectional measurements and update them
      const segmentIndices = Object.keys(segmentation.segments)
        .map(index => parseInt(index))
        .filter(index => index > 0);

      for (const segmentIndex of segmentIndices) {
        const segment = segmentation.segments[segmentIndex];
        if (segment?.cachedStats?.namedStats?.bidirectional) {
          // Run the command to update the bidirectional measurement
          commandsManager.runCommand('runSegmentBidirectional', {
            segmentationId,
            segmentIndex,
          });
        }
      }

      let updatedSegmentation;
      try {
        updatedSegmentation = await updateSegmentationStats({
          segmentation,
          segmentationId,
          readableText,
          getCurrentSegmentation: () => segmentationService.getSegmentation(segmentationId),
          isCurrent,
        });
      } catch (error) {
        if (isCurrent()) console.warn('Could not update segmentation statistics:', error);
        return;
      }

      if (isCurrent() && updatedSegmentation) {
        segmentationService.addOrUpdateSegmentation({
          segmentationId,
          segments: updatedSegmentation.segments,
        });
      }
    },
    1000
  );

  const unsubscribe = () => {
    isUnsubscribed = true;
    invalidateUnsubscribe();
    debouncedUnsubscribe();
    revisions.clear();
  };
  return { unsubscribe };
}

/**
 * Sets up the handler for segmentation modification events
 */
export function setupSegmentationModifiedHandler({ segmentationService }) {
  const { unsubscribe } = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_MODIFIED,
    async ({ segmentationId }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        return;
      }

      const annotationState = cornerstoneTools.annotation.state.getAllAnnotations();
      const bidirectionalAnnotations = annotationState.filter(
        annotation =>
          annotation.metadata.toolName === cornerstoneTools.SegmentBidirectionalTool.toolName
      );

      let toRemoveUIDs = [];
      if (!segmentation) {
        toRemoveUIDs = bidirectionalAnnotations.map(
          annotation => annotation.metadata.segmentationId === segmentationId
        );
        return;
      } else {
        const segmentIndices = Object.keys(segmentation.segments)
          .map(index => parseInt(index))
          .filter(index => index > 0);

        // check if there is a bidirectional data that exists but the segment
        // does not exists anymore we need to remove the bidirectional data
        const bidirectionalAnnotationsToRemove = bidirectionalAnnotations.filter(
          annotation =>
            annotation.metadata.segmentationId === segmentationId &&
            !segmentIndices.includes(annotation.metadata.segmentIndex)
        );

        toRemoveUIDs = bidirectionalAnnotationsToRemove.map(annotation => annotation.annotationUID);
      }

      toRemoveUIDs.forEach(uid => {
        cornerstoneTools.annotation.state.removeAnnotation(uid);
      });
    }
  );

  return { unsubscribe };
}

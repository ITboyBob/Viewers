import { segmentation, Enums } from '@cornerstonejs/tools';
export default function createMaskVisibilityCommands({ servicesManager }) {
  const { segmentationService: service, viewportGridService } = servicesManager.services;
  const previous = new Map<string, Map<number, boolean>>();
  const type = Enums.SegmentationRepresentations.Labelmap;
  return {
    isolateCurrentMask: () => {
      const viewportId = viewportGridService.getActiveViewportId();
      const current = service.getActiveSegmentation(viewportId),
        segment = service.getActiveSegment(viewportId);
      if (!current?.representationData.Labelmap || !segment)
        throw new Error('请先选择要单独显示的 Mask。');
      const id = current.segmentationId;
      if (!previous.has(id))
        previous.set(
          id,
          new Map(
            Object.keys(current.segments).map(key => [
              Number(key),
              segmentation.config.visibility.getSegmentIndexVisibility(
                viewportId,
                { segmentationId: id, type },
                Number(key)
              ),
            ])
          )
        );
      Object.keys(current.segments).forEach(key =>
        service.setSegmentVisibilityForAllViewports(
          id,
          Number(key),
          Number(key) === segment.segmentIndex
        )
      );
      return { changed: 0, message: '当前标注集只显示选中的 Mask；可恢复进入前的显隐状态。' };
    },
    restoreMaskVisibility: () => {
      const id = service.getActiveSegmentation(
        viewportGridService.getActiveViewportId()
      )?.segmentationId;
      const saved = id && previous.get(id),
        current = id && service.getSegmentation(id);
      if (!saved || !current) throw new Error('当前标注集没有待恢复的单独显示状态。');
      for (const [index, visible] of saved)
        if (current.segments[index])
          service.setSegmentVisibilityForAllViewports(id, index, visible);
      previous.delete(id);
      return { changed: 0, message: '已恢复单独显示前各 Mask 的显隐状态。' };
    },
    hasMaskVisibilitySnapshot: ({ segmentationId }) => previous.has(segmentationId),
  };
}

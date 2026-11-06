import {
  VolumeViewport,
  StackViewport,
  cache,
  utilities,
  Types,
  metaData,
} from '@cornerstonejs/core';
import { roiSelection } from './maskRoi';
import type { MaskRoi } from './maskRoi';
import { describeHistoryMemo } from './maskHistory';
import type { MaskHistoryDetail } from './maskHistory';
import { segmentation, utilities as toolUtilities } from '@cornerstonejs/tools';
import {
  createSliceMapping,
  fillHolesSlice,
  getAlignedPlaneAxis,
  splitMaskSlice,
  thresholdSlice,
} from './maskAlgorithms';

type VoxelManager = Types.IVoxelManager<number>;
type CreatedSegment = { segmentIndex: number; label: string };

/** Adapt the pure 2D operations to OHIF's real labelmaps and shared undo history. */
export default function createMaskCommands({
  servicesManager,
  commandsManager,
}: Pick<withAppTypes, 'servicesManager' | 'commandsManager'>) {
  const { segmentationService, viewportGridService, cornerstoneViewportService } =
    servicesManager.services;

  function getSlice() {
    commandsManager?.run('rejectPreview');
    const viewportId = viewportGridService.getActiveViewportId();
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const active = segmentationService.getActiveSegmentation(viewportId);
    const segment = segmentationService.getActiveSegment(viewportId);
    if (!viewport || !active || !segment) {
      throw new Error('请先在分割列表中新建或选择一个 Mask，并选择影像视口。');
    }
    const { segmentationId } = active;
    const { segmentIndex } = segment;
    if (segmentation.segmentLocking.isSegmentIndexLocked(segmentationId, segmentIndex)) {
      throw new Error('当前 Mask 已锁定，请先解锁。');
    }
    const labelmap = active.representationData.Labelmap as {
      volumeId?: string;
      imageIds?: string[];
      referencedImageIds?: string[];
    };
    if (!labelmap) {
      throw new Error('这些工具仅适用于 Labelmap 类型的 Mask。');
    }

    let voxelManager: VoxelManager;
    let mapping: ReturnType<typeof createSliceMapping>;
    let getIntensities: () => Float64Array;
    let maxSegmentIndex: number;
    let indexToWorld: (index: number) => number[];
    let seriesInstanceUID: string;

    if (viewport instanceof VolumeViewport) {
      const volume = labelmap.volumeId
        ? cache.getVolume(labelmap.volumeId)
        : toolUtilities.segmentation.getOrCreateSegmentationVolume(segmentationId);
      if (!volume?.voxelManager || !volume.imageData) {
        throw new Error(
          '当前切片的 Mask 体数据尚未就绪，请等待加载完成，或先回到原始 CT 切片编辑。'
        );
      }
      voxelManager = volume.voxelManager as VoxelManager;
      const camera = viewport.getCamera();
      const axis = getAlignedPlaneAxis(volume.direction, camera.viewPlaneNormal);
      const point = utilities.transformWorldToIndex(volume.imageData, camera.focalPoint);
      mapping = createSliceMapping(volume.dimensions, axis, Math.round(point[axis]));
      indexToWorld = index => {
        const value = mapping.toIndex(index),
          [w, h] = volume.dimensions;
        return utilities.transformIndexToWorld(volume.imageData, [
          value % w,
          Math.floor(value / w) % h,
          Math.floor(value / (w * h)),
        ]);
      };
      const sourceId = cache.getVolume(viewport.getVolumeId())?.imageIds?.[0];
      seriesInstanceUID = sourceId && metaData.get('instance', sourceId)?.SeriesInstanceUID;
      maxSegmentIndex = volume.dataType === 'Uint16Array' ? 65535 : 255;
      getIntensities = () => {
        const source = cache.getVolume(viewport.getVolumeId());
        if (!source?.voxelManager || !source.imageData) {
          throw new Error('原始影像尚未加载完成，无法执行阈值选区。');
        }
        if (source.isDynamicVolume()) {
          throw new Error('请先使用普通静态影像；本工具暂不处理动态体数据。');
        }
        // Reject mismatched geometry rather than sampling another series at the same index.
        for (const key of ['dimensions', 'origin', 'spacing', 'direction'] as const) {
          if (source[key].some((value, index) => Math.abs(value - volume[key][index]) > 0.0001)) {
            throw new Error('当前影像与 Mask 的空间信息不匹配，请选择对应的影像序列。');
          }
        }
        const values = new Float64Array(mapping.width * mapping.height);
        for (let index = 0; index < values.length; index++) {
          const sourceIndex = mapping.toIndex(index);
          const frameIndex = Math.floor(
            sourceIndex / (source.dimensions[0] * source.dimensions[1])
          );
          const image = cache.getImage(source.imageIds[frameIndex]);
          if (!image || image.color) {
            throw new Error('原始切片尚未完整加载，或不是灰度影像，请等待加载完成。');
          }
          const raw = (source.voxelManager as VoxelManager).getAtIndex(sourceIndex);
          values[index] =
            image.isPreScaled || image.preScale?.scaled
              ? raw
              : raw * (image.slope ?? 1) + (image.intercept ?? 0);
        }
        return values;
      };
    } else if (viewport instanceof StackViewport) {
      const labelImageIds = labelmap.imageIds?.length
        ? labelmap.imageIds
        : labelmap.volumeId
          ? cache.getVolume(labelmap.volumeId)?.imageIds
          : undefined;
      if (!labelImageIds?.length) {
        throw new Error('当前切片的 Mask 数据尚未就绪，请等待加载完成或重新选择分割图层。');
      }
      const imageId = viewport.getCurrentImageId();
      const referenceIndex = labelmap.referencedImageIds?.indexOf(imageId) ?? -1;
      // Match explicit image references; using the viewport's slice number is unsafe.
      const labelImageId =
        referenceIndex >= 0
          ? labelImageIds[referenceIndex]
          : labelImageIds.find(id => cache.getImage(id)?.referencedImageId === imageId);
      const labelImage = labelImageId ? cache.getImage(labelImageId) : undefined;
      if (!labelImage?.voxelManager) {
        throw new Error('未找到与当前切片对应的 Mask，请等待加载或重新选择影像。');
      }
      voxelManager = labelImage.voxelManager as VoxelManager;
      mapping = createSliceMapping([labelImage.columns, labelImage.rows, 1], 2, 0);
      indexToWorld = index =>
        utilities.transformIndexToWorld(viewport.getImageData().imageData, [
          index % mapping.width,
          Math.floor(index / mapping.width),
          0,
        ]);
      seriesInstanceUID = metaData.get('instance', imageId)?.SeriesInstanceUID;
      maxSegmentIndex = labelImage.dataType === 'Uint16Array' ? 65535 : 255;
      getIntensities = () => {
        const image = cache.getImage(imageId);
        if (
          !image ||
          image.color ||
          image.columns !== mapping.width ||
          image.rows !== mapping.height
        ) {
          throw new Error('原始灰度影像尚未加载，或其尺寸与 Mask 不一致。');
        }
        const raw = image.getPixelData();
        const values = new Float64Array(raw.length);
        for (let index = 0; index < raw.length; index++) {
          values[index] =
            image.isPreScaled || image.preScale?.scaled
              ? raw[index]
              : raw[index] * (image.slope ?? 1) + (image.intercept ?? 0);
        }
        return values;
      };
    } else {
      throw new Error('请先点击 CT 切片窗口再操作；三维模型预览窗口不支持这些二维编辑工具。');
    }

    const pixels = new Uint32Array(mapping.width * mapping.height);
    for (let index = 0; index < pixels.length; index++) {
      const value = voxelManager.getAtIndex(mapping.toIndex(index));
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('Mask 数据尚未完整加载，请稍后再试。');
      }
      pixels[index] = value;
    }
    return {
      active,
      segment,
      segmentationId,
      segmentIndex,
      voxelManager,
      mapping,
      pixels,
      getIntensities,
      maxSegmentIndex,
      indexToWorld,
      seriesInstanceUID,
    };
  }

  function commit(
    slice: ReturnType<typeof getSlice>,
    result: Uint32Array,
    created: CreatedSegment[] = [],
    detail: Partial<MaskHistoryDetail> = {}
  ) {
    const { segmentationId, segmentIndex, voxelManager, mapping, pixels } = slice;
    let changed = 0;
    for (let index = 0; index < pixels.length; index++) {
      if (pixels[index] !== result[index]) changed++;
    }
    if (!changed) return 0;

    const memo = toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo(
      segmentationId,
      voxelManager
    );
    for (const config of created) segmentationService.addSegment(segmentationId, config);
    for (let index = 0; index < pixels.length; index++) {
      if (pixels[index] !== result[index]) {
        memo.voxelManager.setAtIndex(mapping.toIndex(index), result[index]);
      }
    }
    memo.commitMemo();
    if (created.length) {
      const restorePixels = memo.restoreMemo.bind(memo);
      memo.restoreMemo = (isUndo = true) => {
        if (!isUndo) {
          for (const config of created) {
            if (
              segmentationService.getSegmentation(segmentationId)?.segments[config.segmentIndex]
            ) {
              throw new Error('新 Mask 编号已被使用，无法重做拆分。');
            }
          }
          for (const config of created) segmentationService.addSegment(segmentationId, config);
        }
        restorePixels(isUndo);
        if (isUndo) {
          for (const config of created) {
            segmentationService.removeSegment(segmentationId, config.segmentIndex);
          }
        }
        segmentationService.setActiveSegment(segmentationId, segmentIndex);
      };
    }
    describeHistoryMemo(memo, {
      title: '当前切片编辑',
      segmentationId,
      segmentIndex,
      changed,
      target: `${slice.active.label || '标注集'} / ${slice.segment.label || 'Mask'}`,
      ...detail,
    });
    utilities.HistoryMemo.DefaultHistoryMemo.push(memo);
    segmentationService.setActiveSegment(segmentationId, segmentIndex);
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId);
    return changed;
  }

  return {
    thresholdMaskSlice: ({ lower, upper, replace = false, roi = undefined as MaskRoi }) => {
      const slice = getSlice();
      const { pixels, mapping, segmentIndex } = slice;
      let selection: Uint8Array;
      if (roi) {
        if (roi.seriesInstanceUID !== slice.seriesInstanceUID)
          throw new Error('ROI 与当前序列不匹配。');
        const origin = slice.indexToWorld(0);
        const x =
          mapping.width > 1 ? slice.indexToWorld(1).map((v, i) => v - origin[i]) : [0, 0, 0];
        const y =
          mapping.height > 1
            ? slice.indexToWorld(mapping.width).map((v, i) => v - origin[i])
            : [0, 0, 0];
        selection = roiSelection(roi, mapping.width, mapping.height, origin, x, y);
      }
      const result = thresholdSlice(
        pixels,
        slice.getIntensities(),
        mapping.width,
        mapping.height,
        segmentIndex,
        lower,
        upper,
        replace,
        selection
      );
      const changed = commit(slice, result, [], {
        title: '单片阈值',
        parameters: {
          '下限 HU': lower,
          '上限 HU': upper,
          模式: replace ? '替换' : '追加',
          范围: roi ? 'ROI' : '当前切片',
        },
      });
      return { changed, message: `当前切片阈值选区完成，更新 ${changed} 个像素。` };
    },
    fillMaskHoles: () => {
      const slice = getSlice();
      const { pixels, mapping, segmentIndex } = slice;
      const result = fillHolesSlice(pixels, mapping.width, mapping.height, segmentIndex);
      const changed = commit(slice, result, [], { title: '单片填洞' });
      return {
        changed,
        message: changed
          ? `已填充当前切片 ${changed} 个空洞像素。`
          : '当前切片没有可填充的封闭空洞。',
      };
    },
    splitMaskComponents: () => {
      const slice = getSlice();
      const { active, pixels, mapping, segmentIndex } = slice;
      const result = splitMaskSlice(
        pixels,
        mapping.width,
        mapping.height,
        segmentIndex,
        Object.keys(active.segments).map(Number),
        slice.maxSegmentIndex
      );
      if (result.componentCount < 2) {
        return {
          changed: 0,
          message:
            result.componentCount === 0
              ? '当前切片没有选中 Mask 的像素。'
              : '当前 Mask 仍然连通。请先用橡皮擦切断连接，再点击拆分。',
        };
      }
      const created = result.created.map((item, index) => ({
        segmentIndex: item.segmentIndex,
        label: `${slice.segment.label || 'Mask'} / ${index + 2}`,
      }));
      const changed = commit(slice, result.pixels, created, {
        title: '单片拆分',
        parameters: { 区域数: result.componentCount },
      });
      return {
        changed,
        message: `当前切片已拆为 ${result.componentCount} 个 Mask，最大区域保留原名称。`,
      };
    },
  };
}

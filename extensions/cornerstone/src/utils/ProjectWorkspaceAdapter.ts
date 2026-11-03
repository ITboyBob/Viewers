import { cloneDeep } from 'lodash';
import { cache, imageLoader } from '@cornerstonejs/core';
import { annotation, segmentation, Enums, utilities } from '@cornerstonejs/tools';
import type { LocalProject, ProjectWorkspaceAdapter } from '@ohif/core';
import type { Types as ToolTypes } from '@cornerstonejs/tools';
import type { Types as CoreTypes } from '@cornerstonejs/core';

type Pixels = CoreTypes.PixelDataTypedArray;
type Frame = { referenceId: string; rows: number; columns: number; pixels: Pixels };
type Snapshot = {
  taskId: string;
  annotations: ToolTypes.Annotation[];
  measurements: Record<string, unknown>[];
  segmentations: Array<{
    segmentationId: string;
    label: string;
    segments: ToolTypes.Segmentation['segments'];
    frames: Frame[];
    colors: Record<number, CoreTypes.Color>;
    visible: Record<number, boolean>;
  }>;
};
type Events = {
  EVENTS: Record<string, string>;
  subscribe(event: string, listener: () => void): { unsubscribe(): void };
};
/** 只依赖原生能力契约，避免适配器反向耦合整个业务服务实现。 */
type Services = {
  measurementService: Events & {
    getMeasurements(): Array<{ uid: string; [key: string]: unknown }>;
    getSource(
      name: string,
      version: string
    ):
      | {
          annotationToMeasurement(
            tool: string,
            data: { uid: string; annotation: ToolTypes.Annotation }
          ): unknown;
        }
      | undefined;
  };
  segmentationService: Events & {
    getSegmentations(): ToolTypes.Segmentation[];
    getRepresentationsForSegmentation(
      id: string
    ): Array<{ viewportId: string; representations: ToolTypes.SegmentationRepresentation[] }>;
    getSegmentColor(viewport: string, id: string, index: number): CoreTypes.Color;
    setSegmentColor(viewport: string, id: string, index: number, color: CoreTypes.Color): void;
    setSegmentVisibility(viewport: string, id: string, index: number, visible: boolean): void;
    addOrUpdateSegmentation(input: ToolTypes.SegmentationPublicInput): void;
    addSegmentationRepresentation(
      viewport: string,
      input: {
        segmentationId: string;
        type: typeof Enums.SegmentationRepresentations.Labelmap;
        suppressEvents: boolean;
      }
    ): Promise<void>;
  };
  toolGroupService: { getToolGroupForViewport(viewport: string): ToolTypes.IToolGroup | void };
  cornerstoneViewportService: {
    getCornerstoneViewport(viewport: string): CoreTypes.IViewport | null;
  };
  viewportGridService: {
    getState(): { viewports: Map<string, unknown> };
    getActiveViewportId(): string;
  };
};
const check = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw new Error('任务恢复已取消');
  }
};

/** 文件级ID和经过边界验证的多帧ID都属于原任务；不按UID全局放行。 */
function imageBelongs(project: LocalProject, imageId: string | undefined) {
  if (!imageId) {
    return false;
  }
  return project.successes.some(item => {
    if (imageId === item.image_id) {
      return true;
    }
    const prefix = item.image_id + '&frame=';
    if (!imageId.startsWith(prefix)) {
      return false;
    }
    const value = imageId.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(value)) {
      return false;
    }
    const frame = Number(value),
      count = Number(item.dataset?.NumberOfFrames);
    return Number.isSafeInteger(frame) && Number.isSafeInteger(count) && frame <= count;
  });
}

/** 仅在恢复期间阻断输入；不让Mode本体重渲染触发额外的原生表示事件。 */
function blockWorkspace(signal: AbortSignal) {
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'status');
  overlay.textContent = '正在恢复任务…';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:100000;background:#0009;color:#fff;display:grid;place-items:center';
  const block = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.body.appendChild(overlay);
  window.addEventListener('keydown', block, true);
  const close = () => {
    overlay.remove();
    window.removeEventListener('keydown', block, true);
    signal.removeEventListener('abort', close);
  };
  signal.addEventListener('abort', close, { once: true });
  return close;
}

/** 只保存数据副本，不保存服务、视口、DOM或渲染对象。 */
export default function createProjectWorkspaceAdapter(services: Services): ProjectWorkspaceAdapter {
  return {
    capture(project: LocalProject): Snapshot {
      const belongs = (imageId: string | undefined) => imageBelongs(project, imageId);
      const annotations = annotation.state
        .getAllAnnotations()
        .filter(item => belongs(item.metadata.referencedImageId));
      const ids = new Set(annotations.map(item => item.annotationUID));
      const measurements = services.measurementService
        .getMeasurements()
        .filter(item => ids.has(item.uid))
        .map(item =>
          Object.fromEntries(
            Object.entries(item).filter(
              ([key, value]) => key !== 'source' && typeof value !== 'function'
            )
          )
        );
      const segmentations = services.segmentationService.getSegmentations().map(mask => {
        if (!mask.representationData.Labelmap) {
          throw new Error('当前分割类型不支持内存恢复，请先导出');
        }
        const frames = (
          segmentation.getLabelmapImageIds(mask.segmentationId) as unknown as string[]
        ).map((imageId, index) => {
          const image = cache.getImage(imageId);
          const referenceId =
            image?.referencedImageId ??
            ('referencedImageIds' in mask.representationData.Labelmap
              ? mask.representationData.Labelmap.referencedImageIds?.[index]
              : undefined);
          if (!image || !referenceId || !belongs(referenceId)) {
            throw new Error('Mask与当前任务影像不匹配，无法保留');
          }
          return {
            referenceId,
            rows: image.rows,
            columns: image.columns,
            pixels: image.voxelManager.getScalarData().slice() as Pixels,
          };
        });
        const representation = services.segmentationService.getRepresentationsForSegmentation(
          mask.segmentationId
        )[0];
        const colors: Record<number, CoreTypes.Color> = {},
          visible: Record<number, boolean> = {};
        if (representation) {
          for (const index of Object.keys(mask.segments).map(Number)) {
            colors[index] = [
              ...services.segmentationService.getSegmentColor(
                representation.viewportId,
                mask.segmentationId,
                index
              ),
            ] as CoreTypes.Color;
            visible[index] = representation.representations[0]?.segments?.[index]?.visible ?? true;
          }
        }
        return {
          segmentationId: mask.segmentationId,
          label: mask.label,
          segments: cloneDeep(mask.segments),
          frames,
          colors,
          visible,
        };
      });
      return {
        taskId: project.task_id!,
        annotations: cloneDeep(annotations),
        measurements: cloneDeep(measurements),
        segmentations,
      };
    },
    async restore(project: LocalProject, value: unknown, signal: AbortSignal) {
      check(signal);
      const state = value as Snapshot;
      if (state.taskId !== project.task_id) {
        throw new Error('任务快照不匹配');
      }
      const unblock = blockWorkspace(signal);
      try {
        const belongs = (imageId: string | undefined) => imageBelongs(project, imageId);
        const viewportIds = () =>
          [...services.viewportGridService.getState().viewports.keys()].filter(id => {
            const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
            return viewport?.getImageData()?.imageData;
          });
        const deadline = Date.now() + 15000;
        while (!viewportIds().length) {
          check(signal);
          if (Date.now() > deadline) {
            throw new Error('影像视口尚未就绪，任务恢复失败，请返回后重试');
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        check(signal);
        for (const mask of state.segmentations) {
          if (mask.frames.some(frame => !belongs(frame.referenceId))) {
            throw new Error('Mask快照包含其他任务影像');
          }
          // 派生标签图重新建立几何和缓存ID；不复用退出时被清理的表示或像素对象。
          for (const frame of mask.frames) {
            await imageLoader.loadAndCacheImage(frame.referenceId);
            check(signal);
          }
          const images = await imageLoader.createAndCacheDerivedLabelmapImages(
            mask.frames.map(frame => frame.referenceId)
          );
          check(signal);
          images.forEach((image, index) => {
            const frame = mask.frames[index];
            if (image.rows !== frame.rows || image.columns !== frame.columns) {
              throw new Error('Mask恢复尺寸不匹配');
            }
            const pixels = image.voxelManager.getScalarData();
            if (pixels.length !== frame.pixels.length) {
              throw new Error('Mask恢复像素数量不匹配');
            }
            pixels.set(frame.pixels);
          });
          services.segmentationService.addOrUpdateSegmentation({
            segmentationId: mask.segmentationId,
            representation: {
              type: Enums.SegmentationRepresentations.Labelmap,
              data: {
                imageIds: images.map(image => image.imageId),
                referencedImageIds: mask.frames.map(frame => frame.referenceId),
              },
            },
            config: { label: mask.label, segments: cloneDeep(mask.segments) },
          });
          for (const viewportId of viewportIds()) {
            check(signal);
            await services.segmentationService.addSegmentationRepresentation(viewportId, {
              segmentationId: mask.segmentationId,
              type: Enums.SegmentationRepresentations.Labelmap,
              suppressEvents: true,
            });
            check(signal);
            for (const [index, color] of Object.entries(mask.colors)) {
              services.segmentationService.setSegmentColor(
                viewportId,
                mask.segmentationId,
                Number(index),
                color
              );
            }
            for (const [index, visible] of Object.entries(mask.visible)) {
              services.segmentationService.setSegmentVisibility(
                viewportId,
                mask.segmentationId,
                Number(index),
                visible
              );
            }
            segmentation.activeSegmentation.setActiveSegmentation(viewportId, mask.segmentationId);
          }
        }
        const source = services.measurementService.getSource('Cornerstone3DTools', '0.1');
        for (const item of state.annotations) {
          check(signal);
          if (!belongs(item.metadata.referencedImageId)) {
            throw new Error('测量快照包含其他任务影像');
          }
          const measurement = state.measurements.find(value => value.uid === item.annotationUID);
          for (const viewportId of viewportIds()) {
            const group = services.toolGroupService.getToolGroupForViewport(viewportId);
            if (!group) {
              throw new Error('测量恢复工具组尚未就绪');
            }
            if (!group.hasTool(item.metadata.toolName)) {
              group.addTool(item.metadata.toolName);
              group.setToolPassive(item.metadata.toolName);
            }
          }
          const native = cloneDeep(item);
          annotation.state.getAnnotationManager().addAnnotation(native);
          if (measurement) {
            if (!source?.annotationToMeasurement) {
              throw new Error('测量恢复来源不可用');
            }
            const uid = source.annotationToMeasurement(item.metadata.toolName, {
              uid: item.annotationUID,
              annotation: native,
            });
            if (!uid) {
              throw new Error('测量恢复失败，请返回列表重试');
            }
          }
        }
        check(signal);
        // 原生表示及测量统计包含1000ms防抖；全部静默后才允许业务时间桥接。
        const nativeStatsDebounceMs = 1000;
        let lastEvent = Date.now();
        const stops = [services.measurementService, services.segmentationService].flatMap(service =>
          Object.values(service.EVENTS ?? {}).map(event =>
            service.subscribe?.(event, () => {
              lastEvent = Date.now();
            })
          )
        );
        try {
          utilities.triggerAnnotationRenderForViewportIds(viewportIds());
          const until = Date.now() + 15000;
          while (Date.now() - lastEvent < nativeStatsDebounceMs + 100) {
            check(signal);
            if (Date.now() > until) {
              throw new Error('原生任务状态尚未稳定，请返回列表重试');
            }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        } finally {
          stops.forEach(stop => stop?.unsubscribe());
        }
        check(signal);
      } finally {
        unblock();
      }
    },
  };
}

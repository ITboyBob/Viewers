import {
  StackViewport,
  VolumeViewport,
  cache,
  imageLoader,
  utilities,
  Types,
} from '@cornerstonejs/core';
import { segmentation, utilities as toolUtilities } from '@cornerstonejs/tools';
import { thresholdSlice } from './maskAlgorithms';
import { markSeedComponent, analyzeMaskComponents } from './volumeAlgorithms';
import { reportMaskOperation } from './maskOperationEvents';
import type { MaskSplitPreview, VolumeSplitAnalysis } from './splitMaskTypes';

type VoxelManager = Types.IVoxelManager<number>;
type LabelmapData = { volumeId?: string; imageIds?: string[]; referencedImageIds?: string[] };
type MaskFrame = { image: Types.IImage; referenceId: string; voxelManager: VoxelManager };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function growInWorker(mask: Uint8Array, dimensions: number[], seed: number[]) {
  if (typeof Worker === 'undefined')
    return Promise.resolve(markSeedComponent(mask, dimensions, seed));
  return new Promise<ReturnType<typeof markSeedComponent>>((resolve, reject) => {
    const worker = new Worker(new URL('./regionGrow.worker.ts', import.meta.url));
    worker.onmessage = event => {
      worker.terminate();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = event => {
      event.preventDefault();
      worker.terminate();
      reject(new Error('区域生长计算失败，请缩小数据范围后重试。'));
    };
    worker.postMessage({ mask, dimensions, seed }, [mask.buffer]);
  });
}

function splitInWorker(mask: Uint8Array, dimensions: number[], minimumVoxels: number) {
  if (typeof Worker === 'undefined')
    return Promise.resolve(analyzeMaskComponents(mask, dimensions, minimumVoxels));
  return new Promise<VolumeSplitAnalysis>((resolve, reject) => {
    const worker = new Worker(new URL('./regionGrow.worker.ts', import.meta.url));
    worker.onmessage = event => {
      worker.terminate();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = event => {
      event.preventDefault();
      worker.terminate();
      reject(new Error('三维拆分分析失败，请减小数据范围后重试。'));
    };
    worker.postMessage({ task: 'split', mask, dimensions, minimumVoxels }, [mask.buffer]);
  });
}

/** Whole-series operations preserve source image geometry and share OHIF's undo stack. */
export default function createVolumeMaskCommands({
  servicesManager,
  commandsManager,
}: Pick<withAppTypes, 'servicesManager' | 'commandsManager'>) {
  const {
    segmentationService,
    viewportGridService,
    cornerstoneViewportService,
    displaySetService,
  } = servicesManager.services;
  let operationBusy = false;
  let pendingSplit:
    | {
        preview: MaskSplitPreview;
        target: ReturnType<typeof targetFor>;
        volume: ReturnType<typeof maskVolumeFor>;
        analysis: VolumeSplitAnalysis;
      }
    | undefined;

  function targetFor(viewportId = viewportGridService.getActiveViewportId()) {
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!(viewport instanceof StackViewport || viewport instanceof VolumeViewport)) {
      throw new Error('请先点击 CT 切片窗口，再执行 Mask 编辑。');
    }
    const active = segmentationService.getActiveSegmentation(viewportId);
    const segment = segmentationService.getActiveSegment(viewportId);
    if (!active?.representationData.Labelmap || !segment)
      throw new Error('请先新建或选择一个 Mask。');
    if (
      segmentation.segmentLocking.isSegmentIndexLocked(active.segmentationId, segment.segmentIndex)
    ) {
      throw new Error('当前 Mask 已锁定，请先解锁。');
    }
    return {
      viewport,
      viewportId,
      segmentationId: active.segmentationId,
      segmentIndex: segment.segmentIndex,
      labelmap: active.representationData.Labelmap as LabelmapData,
    };
  }

  function ensureTarget(target: ReturnType<typeof targetFor>) {
    const active = segmentationService.getActiveSegmentation(
      viewportGridService.getActiveViewportId()
    );
    const segment = segmentationService.getActiveSegment(viewportGridService.getActiveViewportId());
    if (
      active?.segmentationId !== target.segmentationId ||
      segment?.segmentIndex !== target.segmentIndex
    ) {
      throw new Error('当前 Mask 已切换，操作已取消，请重新执行。');
    }
    if (
      segmentation.segmentLocking.isSegmentIndexLocked(target.segmentationId, target.segmentIndex)
    ) {
      throw new Error('当前 Mask 已被锁定，操作已取消。');
    }
  }

  function blockDrawing() {
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const elements =
      cornerstoneViewportService
        .getRenderingEngine()
        ?.getViewports()
        .map(v => v.element) || [];
    const eventNames = [
      'pointerdown',
      'mousedown',
      'touchstart',
      'pointermove',
      'mousemove',
      'touchmove',
    ];
    elements.forEach(element =>
      eventNames.forEach(name =>
        element.addEventListener(name, block, { capture: true, passive: false })
      )
    );
    const blockUndo = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase()))
        block(event);
    };
    window.addEventListener('keydown', blockUndo, true);
    return () => {
      elements.forEach(element =>
        eventNames.forEach(name => element.removeEventListener(name, block, true))
      );
      window.removeEventListener('keydown', blockUndo, true);
    };
  }

  async function exclusive<T extends { changed: number; message: string }>(
    message: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (operationBusy) throw new Error('已有 Mask 操作正在处理，请稍候。');
    operationBusy = true;
    reportMaskOperation('start', message);
    const unblock = typeof window === 'undefined' ? () => {} : blockDrawing();
    try {
      commandsManager?.run('rejectPreview');
      const result = await operation();
      reportMaskOperation('complete', result.message);
      return result;
    } catch (error) {
      reportMaskOperation('error', error instanceof Error ? error.message : '操作失败。');
      throw error;
    } finally {
      unblock();
      operationBusy = false;
    }
  }

  type LabelmapMemo = ReturnType<
    typeof toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo<number>
  >;
  function saveHistory(segmentationId: string, memos: LabelmapMemo[]) {
    if (!memos.length) return;
    utilities.HistoryMemo.DefaultHistoryMemo.push({
      id: utilities.uuidv4(),
      operationType: 'labelmap',
      restoreMemo(isUndo = true) {
        (isUndo ? [...memos].reverse() : memos).forEach(memo => memo.restoreMemo(isUndo));
      },
    });
    segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId);
  }

  function rollback(segmentationId: string, memos: LabelmapMemo[]) {
    if (segmentationService.getSegmentation(segmentationId)) {
      [...memos].reverse().forEach(memo => {
        if (memo.commitMemo()) memo.restoreMemo(true);
      });
    }
  }

  function frameData(target: ReturnType<typeof targetFor>): MaskFrame[] {
    // The 4.5.13 declaration says string, while the runtime API returns image IDs.
    const labelIds: unknown = segmentation.getLabelmapImageIds(target.segmentationId);
    if (!Array.isArray(labelIds) || !labelIds.length)
      throw new Error('当前 Mask 的切片数据尚未就绪。');
    return (labelIds as string[]).map((id, index) => {
      const image = cache.getImage(id);
      const referenceId = image?.referencedImageId || target.labelmap.referencedImageIds?.[index];
      if (!image?.voxelManager || !referenceId)
        throw new Error('无法找到 Mask 对应的原始切片，未修改任何数据。');
      return { image, referenceId, voxelManager: image.voxelManager as VoxelManager };
    });
  }

  async function thresholdSeries({ lower, upper, replace = true }) {
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
      throw new Error('阈值下限不能大于上限，且必须是有效数字。');
    }
    const target = targetFor();
    const frames = frameData(target);
    const loaded = new Array<Types.IImage>(frames.length);
    let next = 0;
    let completed = 0;
    // Load every source frame before writing any mask, with bounded concurrency.
    const loadResults = await Promise.allSettled(
      Array.from({ length: Math.min(4, frames.length) }, async () => {
        while (next < frames.length) {
          const index = next++;
          const frame = frames[index];
          const image =
            cache.getImage(frame.referenceId) ||
            (await imageLoader.loadAndCacheImage(frame.referenceId));
          if (
            image.color ||
            image.columns !== frame.image.columns ||
            image.rows !== frame.image.rows
          ) {
            throw new Error('原始影像与 Mask 的尺寸不一致，或不是灰度影像。');
          }
          loaded[index] = image;
          reportMaskOperation('progress', `正在载入切片 ${++completed}/${frames.length}…`);
        }
      })
    );
    const loadFailure = loadResults.find(result => result.status === 'rejected');
    if (loadFailure?.status === 'rejected') throw loadFailure.reason;
    const memos: LabelmapMemo[] = [];
    let changed = 0;
    try {
      for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
        ensureTarget(target);
        const frame = frames[frameIndex];
        const image = loaded[frameIndex];
        const labels = frame.voxelManager.getScalarData();
        const raw = image.getPixelData();
        const intensities =
          image.isPreScaled || image.preScale?.scaled
            ? raw
            : Float64Array.from(raw, value => value * (image.slope ?? 1) + (image.intercept ?? 0));
        const result = thresholdSlice(
          labels,
          intensities,
          image.columns,
          image.rows,
          target.segmentIndex,
          lower,
          upper,
          replace
        );
        const memo = toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo(
          target.segmentationId,
          frame.voxelManager
        );
        memos.push(memo);
        for (let i = 0; i < result.length; i++) {
          if (labels[i] !== result[i]) {
            memo.voxelManager.setAtIndex(i, result[i]);
            changed++;
          }
        }
        memo.commitMemo();
        reportMaskOperation('progress', `正在应用阈值 ${frameIndex + 1}/${frames.length}…`);
        if (frameIndex % 4 === 3) await pause();
      }
      ensureTarget(target);
      saveHistory(
        target.segmentationId,
        memos.filter(memo => memo.commitMemo())
      );
      return {
        changed,
        message: `整组 ${frames.length} 张切片阈值选区完成，更新 ${changed} 个像素。`,
      };
    } catch (error) {
      rollback(target.segmentationId, memos);
      throw error;
    }
  }

  function maskVolumeFor(target: ReturnType<typeof targetFor>) {
    const volume = target.labelmap.volumeId
      ? cache.getVolume(target.labelmap.volumeId)
      : toolUtilities.segmentation.getOrCreateSegmentationVolume(target.segmentationId);
    if (volume?.voxelManager && volume.imageData) {
      const displaySetId = viewportGridService.getDisplaySetsUIDsForViewport(
        target.viewportId
      )?.[0];
      if (
        displaySetId &&
        displaySetService.getDisplaySetByUID(displaySetId)?.isReconstructable === false
      ) {
        throw new Error('这组切片的空间信息不满足三维连通要求，请导入完整且间距一致的同一序列。');
      }
      return {
        voxelManager: volume.voxelManager as VoxelManager,
        dimensions: [...volume.dimensions],
        imageData: volume.imageData,
        spacing: [...volume.spacing],
        maximumLabel: volume.dataType === 'Uint16Array' ? 65535 : 255,
      };
    }
    const frames = frameData(target);
    if (frames.length !== 1 || !(target.viewport instanceof StackViewport)) {
      throw new Error('无法建立三维 Mask，请等待影像加载完成，或检查是否导入了完整序列。');
    }
    const frame = frames[0];
    const image = target.viewport.getImageData();
    return {
      voxelManager: frame.voxelManager,
      dimensions: [frame.image.columns, frame.image.rows, 1],
      imageData: image.imageData,
      spacing: [...image.spacing],
      maximumLabel: frame.image.dataType === 'Uint16Array' ? 65535 : 255,
    };
  }

  async function packMask(
    target: ReturnType<typeof targetFor>,
    volume: ReturnType<typeof maskVolumeFor>
  ) {
    const { dimensions, voxelManager } = volume;
    const count = dimensions[0] * dimensions[1] * dimensions[2];
    const binary = new Uint8Array(count);
    const plane = dimensions[0] * dimensions[1];
    for (let index = 0; index < count; index++) {
      binary[index] = voxelManager.getAtIndex(index) === target.segmentIndex ? 1 : 0;
      if (index > 0 && index % (plane * 16) === 0) {
        ensureTarget(target);
        await pause();
      }
    }
    return binary;
  }

  async function growFromSeed({
    worldPoint,
    viewportId,
  }: {
    worldPoint: Types.Point3;
    viewportId?: string;
  }) {
    const target = targetFor(viewportId);
    const volume = maskVolumeFor(target);
    const { dimensions, voxelManager } = volume;
    const seed = utilities.transformWorldToIndex(volume.imageData, worldPoint).map(Math.round);
    if (dimensions[2] === 1) seed[2] = 0;
    const binary = await packMask(target, volume);
    const count = binary.length;
    const plane = dimensions[0] * dimensions[1];
    reportMaskOperation('progress', '正在计算种子点的三维连通区域…');
    const { mask, kept } = await growInWorker(binary, dimensions, seed);
    ensureTarget(target);
    const memo = toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo(
      target.segmentationId,
      voxelManager
    );
    let changed = 0;
    try {
      for (let index = 0; index < count; index++) {
        if (mask[index] !== 2 && voxelManager.getAtIndex(index) === target.segmentIndex) {
          memo.voxelManager.setAtIndex(index, 0);
          changed++;
        }
        if (index > 0 && index % (plane * 16) === 0) {
          ensureTarget(target);
          await pause();
        }
      }
      if (memo.commitMemo()) saveHistory(target.segmentationId, [memo]);
      return {
        changed,
        message: `区域生长完成，保留 ${kept} 个连通像素，清除 ${changed} 个不连通像素。`,
      };
    } catch (error) {
      rollback(target.segmentationId, [memo]);
      throw error;
    }
  }

  async function analyzeSplit({ minimumVoxels = 1 }) {
    pendingSplit = undefined;
    const target = targetFor();
    const volume = maskVolumeFor(target);
    const binary = await packMask(target, volume);
    reportMaskOperation('progress', '正在分析整组 Mask 的三维连通区域…');
    const analysis = await splitInWorker(binary, volume.dimensions, minimumVoxels);
    ensureTarget(target);
    const voxelVolume =
      volume.dimensions[2] > 1 && volume.spacing.every(value => Number.isFinite(value) && value > 0)
        ? volume.spacing.reduce((product, value) => product * value, 1)
        : null;
    const preview: MaskSplitPreview = {
      id: utilities.uuidv4(),
      minimumVoxels,
      sliceCount: volume.dimensions[2],
      ignoredRegions: analysis.ignoredRegions,
      ignoredVoxels: analysis.ignoredVoxels,
      components: analysis.components.map((component, index) => ({
        ...component,
        keepOriginal: index === 0,
        volumeMm3: voxelVolume === null ? null : component.voxelCount * voxelVolume,
      })),
    };
    pendingSplit = { preview, target, volume, analysis };
    return {
      changed: 0,
      preview,
      message:
        analysis.components.length > 1
          ? `分析完成：找到 ${analysis.components.length} 个可拆分区域，应用前原 Mask 保持不变。`
          : analysis.components.length === 1
            ? '当前只有 1 个达到大小要求的三维连通区域；如需分开粘连结构，请先在相关切片断开连接。'
            : '没有达到最小大小要求的区域；原 Mask 未改变。',
    };
  }

  async function applySplit({ previewId }: { previewId: string }) {
    const plan = pendingSplit;
    if (!plan || plan.preview.id !== previewId) throw new Error('拆分预览已失效，请重新分析。');
    pendingSplit = undefined;
    const { target, volume, analysis } = plan;
    ensureTarget(target);
    if (analysis.components.length < 2)
      return { changed: 0, applied: false, message: '当前没有需要应用的三维拆分。' };
    const used = new Set(
      Object.keys(segmentationService.getSegmentation(target.segmentationId).segments).map(Number)
    );
    // Cornerstone 4.5 uses label 255 for temporary brush previews.
    used.add(255);
    const plane = volume.dimensions[0] * volume.dimensions[1];
    for (let index = 0; index < analysis.mask.length; index++) {
      const label = volume.voxelManager.getAtIndex(index);
      used.add(label);
      if ((label === target.segmentIndex) !== (analysis.mask[index] !== 0)) {
        throw new Error('分析后 Mask 已发生修改，请重新分析后再拆分。');
      }
      if (index > 0 && index % (plane * 16) === 0) {
        ensureTarget(target);
        await pause();
      }
    }
    const sourceLabel =
      segmentationService.getSegmentation(target.segmentationId).segments[target.segmentIndex]
        .label || 'Mask';
    const created: { segmentIndex: number; label: string }[] = [];
    const assignments = new Map<number, number>([
      [analysis.components[0].code, target.segmentIndex],
      [255, target.segmentIndex],
    ]);
    let next = 1;
    for (const component of analysis.components.slice(1)) {
      while (used.has(next) && next <= volume.maximumLabel) next++;
      if (next > volume.maximumLabel) throw new Error('可用 Mask 编号不足，原 Mask 未改变。');
      assignments.set(component.code, next);
      created.push({ segmentIndex: next, label: `${sourceLabel} / ${created.length + 2}` });
      used.add(next++);
    }
    ensureTarget(target);
    const memo = toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo(
      target.segmentationId,
      volume.voxelManager
    );
    const registered: number[] = [];
    let changed = 0;
    try {
      for (const config of created) {
        registered.push(config.segmentIndex);
        segmentationService.addSegment(target.segmentationId, config);
      }
      segmentationService.setActiveSegment(target.segmentationId, target.segmentIndex);
      for (let index = 0; index < analysis.mask.length; index++) {
        const label = assignments.get(analysis.mask[index]);
        if (
          label !== undefined &&
          label !== target.segmentIndex &&
          volume.voxelManager.getAtIndex(index) === target.segmentIndex
        ) {
          memo.voxelManager.setAtIndex(index, label);
          changed++;
        }
        if (index > 0 && index % (plane * 16) === 0) {
          ensureTarget(target);
          await pause();
        }
      }
      ensureTarget(target);
      memo.commitMemo();
      const restorePixels = memo.restoreMemo.bind(memo);
      memo.restoreMemo = (isUndo = true) => {
        if (!segmentationService.getSegmentation(target.segmentationId)) return;
        if (!isUndo) {
          if (
            created.some(
              config =>
                segmentationService.getSegmentation(target.segmentationId).segments[
                  config.segmentIndex
                ]
            )
          ) {
            throw new Error('拆分结果的 Mask 编号已被其他图层占用，无法重做。');
          }
          created.forEach(config => segmentationService.addSegment(target.segmentationId, config));
        }
        restorePixels(isUndo);
        if (isUndo)
          created.forEach(config =>
            segmentationService.removeSegment(target.segmentationId, config.segmentIndex)
          );
        segmentationService.setActiveSegment(target.segmentationId, target.segmentIndex);
      };
      saveHistory(target.segmentationId, [memo]);
      return {
        changed,
        applied: true,
        message: `三维拆分完成：整组分为 ${analysis.components.length} 个 Mask，小区域仍保留在原 Mask。`,
      };
    } catch (error) {
      rollback(target.segmentationId, [memo]);
      registered.forEach(index => {
        if (segmentationService.getSegmentation(target.segmentationId)?.segments[index])
          segmentationService.removeSegment(target.segmentationId, index);
      });
      if (segmentationService.getSegmentation(target.segmentationId)?.segments[target.segmentIndex])
        segmentationService.setActiveSegment(target.segmentationId, target.segmentIndex);
      throw error;
    }
  }

  function locateSplit({ previewId, code }: { previewId: string; code: number }) {
    const plan = pendingSplit;
    if (!plan || plan.preview.id !== previewId) throw new Error('拆分预览已失效，请重新分析。');
    ensureTarget(plan.target);
    const component = plan.analysis.components.find(item => item.code === code);
    if (!component) throw new Error('未找到该拆分区域。');
    const [width, height] = plan.volume.dimensions;
    const index = component.seedIndex;
    const world = utilities.transformIndexToWorld(plan.volume.imageData, [
      index % width,
      Math.floor(index / width) % height,
      Math.floor(index / (width * height)),
    ]);
    const viewport = cornerstoneViewportService.getCornerstoneViewport(
      viewportGridService.getActiveViewportId()
    );
    if (!(viewport instanceof StackViewport || viewport instanceof VolumeViewport)) {
      throw new Error('请先选择 CT 切片窗口，再定位拆分区域。');
    }
    viewport.jumpToWorld(world);
    viewport.render();
    return { changed: 0, message: '已定位到选中的区域；应用拆分前 Mask 未改变。' };
  }

  return {
    thresholdMaskSeries: options =>
      exclusive('正在准备整组切片阈值选区…', () => thresholdSeries(options)),
    growMaskFromSeed: options => exclusive('正在准备区域生长…', () => growFromSeed(options)),
    analyzeMaskSplit: options => exclusive('正在准备三维拆分分析…', () => analyzeSplit(options)),
    applyMaskSplit: options => exclusive('正在应用整组三维拆分…', () => applySplit(options)),
    locateMaskSplitRegion: locateSplit,
    discardMaskSplitPreview: ({ previewId }: { previewId?: string } = {}) => {
      if (!previewId || pendingSplit?.preview.id === previewId) pendingSplit = undefined;
      return { changed: 0, message: '已关闭拆分预览，Mask 未改变。' };
    },
  };
}

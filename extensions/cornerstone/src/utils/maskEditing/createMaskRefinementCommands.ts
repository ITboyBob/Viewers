import { utilities, cache, imageLoader, metaData } from '@cornerstonejs/core';
import { utilities as toolUtilities, segmentation } from '@cornerstonejs/tools';
import {
  refineMask,
  MAX_REFINEMENT_VOXELS,
  MAX_INTERPOLATION_KEYFRAMES,
  interpolationKeyframes,
} from './refinementAlgorithms';
import type { RefinementOptions } from './refinementAlgorithms';
import { publishRefinementPreview, publishRefinementTask } from './maskRefinementEvents';
import type { MaskRefinementPreview, MaskRefinementTask } from './maskRefinementEvents';
import { reportMaskOperation } from './maskOperationEvents';
import { maskRoiSettings, roiSelection, roiContains } from './maskRoi';
import type { MaskRoi } from './maskRoi';

export const refinementLabels = {
  dilate: '三维膨胀',
  erode: '三维腐蚀',
  open: '三维开运算',
  close: '三维闭运算',
  smooth: '三维平滑（先开后闭）',
  largest: '保留最大连通区域',
  removeSmall: '删除小碎片',
  removeSeed: '点选删除连通区域',
  fillCavities: '三维空腔填充',
  huGrow: 'HU 灰度区域生长',
  interpolate: '关键层插值',
  boolean: 'Mask 布尔运算',
  cut: '三维切面裁剪',
};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type CalculationTask = MaskRefinementTask & {
  cancelled: boolean;
  cancelWorker?: () => void;
  lastReportAt: number;
};
const cancellationError = () => new Error('已取消精修计算，Mask 未改变。');
function calculate(
  state: Uint8Array,
  dimensions: number[],
  spacing: number[],
  options: RefinementOptions,
  task: CalculationTask,
  progress: (completed: number, total: number) => void
) {
  if (typeof Worker === 'undefined')
    return Promise.resolve(refineMask(state, dimensions, spacing, options, progress));
  return new Promise<ReturnType<typeof refineMask>>((resolve, reject) => {
    const worker = new Worker(new URL('./refinement.worker.ts', import.meta.url));
    const stop = () => {
      task.cancelWorker = undefined;
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    task.cancelWorker = () => {
      stop();
      reject(cancellationError());
    };
    worker.onmessage = event => {
      if (task.cancelled) return;
      if (event.data.type === 'progress') {
        progress(event.data.completed, event.data.total);
        return;
      }
      stop();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = event => {
      event.preventDefault();
      stop();
      reject(new Error('三维精修计算失败，请减小半径或数据范围后重试。'));
    };
    try {
      worker.postMessage({ state, dimensions, spacing, options }, [state.buffer]);
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

/** Shares batch exclusion, target validation and history with the other whole-series edits. */
export default function createMaskRefinementCommands({
  servicesManager,
  exclusive,
  targetFor,
  ensureTarget,
  maskVolumeFor,
  saveHistory,
  rollback,
  frameData,
}) {
  const service = servicesManager.services.segmentationService;
  let calculation: CalculationTask;
  let huParameters = { lower: 150, upper: 2000, replace: false, useRoi: false };
  let pending: {
    preview: MaskRefinementPreview;
    state: Uint8Array;
    result: Uint8Array;
    target: ReturnType<typeof targetFor>;
    volume: ReturnType<typeof maskVolumeFor>;
    roi?: MaskRoi;
    operand?: { segmentationId: string; segmentIndex: number; mask: Uint8Array };
  };
  const stateAt = (value: number, segmentIndex: number) =>
    value === 0 ? 0 : value === segmentIndex ? 1 : 2;

  function taskEvent(task: CalculationTask, phase = task.phase, message = task.message) {
    publishRefinementTask({
      id: task.id,
      segmentationId: task.segmentationId,
      segmentIndex: task.segmentIndex,
      phase,
      stage: task.stage,
      percent: task.percent,
      message,
    });
  }
  function cancel({ taskId }: { taskId?: string } = {}) {
    const task = calculation;
    if (!task || (taskId && task.id !== taskId) || task.cancelled)
      return { changed: 0, cancelled: false, message: '当前没有可取消的精修计算。' };
    task.cancelled = true;
    task.phase = 'cancelling';
    taskEvent(task, 'cancelling', '正在取消精修计算…');
    task.cancelWorker?.();
    return { changed: 0, cancelled: true, message: '正在取消精修计算…' };
  }
  function check(task: CalculationTask) {
    if (task.cancelled || calculation !== task) throw cancellationError();
  }
  function progress(
    task: CalculationTask,
    stage: MaskRefinementTask['stage'],
    percent: number,
    message: string
  ) {
    check(task);
    const newStage = stage !== task.stage;
    task.stage = stage;
    task.percent = Math.max(task.percent, Math.min(100, Math.round(percent)));
    task.message = message;
    if (!newStage && performance.now() - task.lastReportAt < 100 && task.percent !== 100) return;
    task.lastReportAt = performance.now();
    taskEvent(task);
    reportMaskOperation('progress', message);
  }

  function discard({ previewId }: { previewId?: string } = {}) {
    // A stale preview token must never cancel a newer calculation.
    if (!previewId) cancel();
    if (!previewId || pending?.preview.id === previewId) {
      pending = undefined;
      publishRefinementPreview();
    }
    return { changed: 0, message: '已关闭精修预览，Mask 未改变。' };
  }
  async function verifyOperand(plan: NonNullable<typeof pending>) {
    if (!plan.operand) return;
    const other = service.getSegmentation(plan.operand.segmentationId);
    if (!other?.segments[plan.operand.segmentIndex] || !other.representationData.Labelmap)
      throw new Error('参与布尔运算的源 Mask 已被删除，请重新预览。');
    const source = maskVolumeFor({
      ...plan.target,
      segmentationId: other.segmentationId,
      labelmap: other.representationData.Labelmap,
    });
    let yieldAt = performance.now() + 20;
    const plane = plan.volume.dimensions[0] * plan.volume.dimensions[1];
    for (let i = 0; i < plan.operand.mask.length; i++) {
      if (
        Number(source.voxelManager.getAtIndex(i) === plan.operand.segmentIndex) !==
        plan.operand.mask[i]
      )
        throw new Error('布尔运算的源 Mask 已变化，已取消本次应用。');
      if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
        ensureTarget(plan.target);
        await pause();
        yieldAt = performance.now() + 20;
      }
    }
    if (!service.getSegmentation(plan.operand.segmentationId)?.segments[plan.operand.segmentIndex])
      throw new Error('布尔运算的源 Mask 已被删除，已取消本次应用。');
  }
  async function verify(plan: NonNullable<typeof pending>, task?: CalculationTask) {
    if (task) check(task);
    ensureTarget(plan.target);
    if (
      plan.roi &&
      JSON.stringify(maskRoiSettings.get(plan.roi.seriesInstanceUID)) !== JSON.stringify(plan.roi)
    )
      throw new Error('ROI 已改变，请重新生成预览。');
    const current = maskVolumeFor(targetFor());
    let operandVolume;
    if (plan.operand) {
      const other = service.getSegmentation(plan.operand.segmentationId);
      if (!other?.segments[plan.operand.segmentIndex] || !other.representationData.Labelmap)
        throw new Error('参与布尔运算的源 Mask 已被删除，请重新预览。');
      operandVolume = maskVolumeFor({
        ...plan.target,
        segmentationId: plan.operand.segmentationId,
        labelmap: other.representationData.Labelmap,
      });
    }
    if (
      current.imageData !== plan.volume.imageData ||
      current.dimensions.some((v, i) => v !== plan.volume.dimensions[i]) ||
      current.spacing.some((v, i) => Math.abs(v - plan.volume.spacing[i]) > 0.0001)
    )
      throw new Error('Mask 体数据或布局已变化，请重新生成精修预览。');
    const plane = current.dimensions[0] * current.dimensions[1];
    let yieldAt = performance.now() + 20;
    for (let i = 0; i < plan.state.length; i++) {
      if (
        operandVolume &&
        Number(operandVolume.voxelManager.getAtIndex(i) === plan.operand.segmentIndex) !==
          plan.operand.mask[i]
      )
        throw new Error('布尔运算的源 Mask 已变化，请重新预览。');
      if (stateAt(current.voxelManager.getAtIndex(i), plan.target.segmentIndex) !== plan.state[i])
        throw new Error('预览后 Mask 已发生修改，请重新预览；未应用过期结果。');
      if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
        if (task)
          progress(
            task,
            'validate',
            90 + (i / plan.state.length) * 10,
            '正在校验精修预览与当前选区…'
          );
        ensureTarget(plan.target);
        await pause();
        yieldAt = performance.now() + 20;
      }
    }
    if (task) check(task);
    ensureTarget(plan.target);
  }
  const actions = {
    previewMaskRefinement: (
      options: RefinementOptions & {
        worldPoint?: [number, number, number];
        viewportId?: string;
        cutFromView?: boolean;
        cutOffsetMm?: number;
        keepPositive?: boolean;
      }
    ) =>
      exclusive('正在准备整组 Mask 精修预览…', async () => {
        discard();
        const target = targetFor(options.viewportId);
        const task: CalculationTask = {
          id: utilities.uuidv4(),
          segmentationId: target.segmentationId,
          segmentIndex: target.segmentIndex,
          phase: 'running',
          stage: 'prepare',
          percent: 0,
          message: '正在准备精修快照…',
          cancelled: false,
          lastReportAt: 0,
        };
        calculation = task;
        taskEvent(task);
        let phase: MaskRefinementTask['phase'] = 'error';
        try {
          check(task);
          const volume = maskVolumeFor(target);
          const dataSetId =
            servicesManager.services.viewportGridService.getDisplaySetsUIDsForViewport(
              target.viewportId
            )?.[0];
          if (
            dataSetId &&
            servicesManager.services.displaySetService.getDisplaySetByUID(dataSetId)
              ?.isDynamicVolume
          )
            throw new Error('整组三维精修暂不处理动态体数据，请使用静态 DICOM 序列。');
          const { dimensions, spacing, voxelManager } = volume;
          const displaySet =
            dataSetId && servicesManager.services.displaySetService.getDisplaySetByUID(dataSetId);
          const sourceImageId = displaySet?.imageIds?.[0];
          const series =
            sourceImageId && metaData.get('instance', sourceImageId)?.SeriesInstanceUID;
          const roi =
            options.useRoi && series ? structuredClone(maskRoiSettings.get(series)) : undefined;
          if (options.useRoi && !roi) throw new Error('请先在“阈值”页框选 ROI。');
          if (dimensions[2] < 2)
            throw new Error('整组三维精修需要至少两张空间一致的切片，请导入完整序列。');
          const count = dimensions.reduce((a, b) => a * b, 1);
          if (count > MAX_REFINEMENT_VOXELS)
            throw new Error('当前 Mask 超出本地精修处理上限，请减小影像范围。');
          const state = new Uint8Array(count),
            plane = dimensions[0] * dimensions[1];
          let yieldAt = performance.now() + 20;
          for (let i = 0; i < count; i++) {
            const value = voxelManager.getAtIndex(i);
            if (
              !Number.isInteger(value) ||
              value < 0 ||
              value > volume.maximumLabel ||
              value === 255
            )
              throw new Error('Mask 包含无效标签或未提交预览，请先确认或取消笔刷预览。');
            state[i] = stateAt(value, target.segmentIndex);
            if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
              progress(task, 'prepare', (i / count) * 20, '正在读取整组 Mask 快照…');
              ensureTarget(target);
              await pause();
              yieldAt = performance.now() + 20;
            }
          }
          check(task);
          const parameters = { ...options };
          if (parameters.operation === 'interpolate') {
            parameters.keyframes = interpolationKeyframes(parameters, dimensions[2]);
            parameters.startSlice = parameters.keyframes[0];
            parameters.endSlice = parameters.keyframes[parameters.keyframes.length - 1];
          }
          let operand: { segmentationId: string; segmentIndex: number; mask: Uint8Array };
          if (parameters.operation === 'cut' && parameters.cutFromView) {
            const camera = target.viewport.getCamera(),
              normal = [...camera.viewPlaneNormal];
            const length = Math.hypot(...normal),
              offset = parameters.cutOffsetMm ?? 0;
            if (
              !Number.isFinite(offset) ||
              Math.abs(offset) > 1000 ||
              !Number.isFinite(length) ||
              length < 1e-9
            )
              throw new Error('切面偏移应为 -1000 至 1000 mm。');
            for (let i = 0; i < 3; i++) normal[i] /= length;
            const origin = utilities.transformIndexToWorld(volume.imageData, [0, 0, 0]);
            const basis = [0, 1, 2].map(axis => {
              const p: [number, number, number] = [0, 0, 0];
              p[axis] = 1;
              return utilities
                .transformIndexToWorld(volume.imageData, p)
                .map((v, i) => v - origin[i]);
            });
            parameters.cutPlane = {
              normal: basis.map(axis => axis.reduce((sum, v, i) => sum + v * normal[i], 0)),
              offset:
                camera.focalPoint.reduce((sum, v, i) => sum + (v - origin[i]) * normal[i], 0) +
                offset,
              keepPositive: parameters.keepPositive !== false,
            };
          }
          if (parameters.operation === 'boolean') {
            if (Object.keys(service.getSegmentation(target.segmentationId).segments).length !== 1)
              throw new Error('请先“复制当前 Mask 为独立副本”，再对单 Mask 标注集执行布尔运算。');
            const other = service.getSegmentation(parameters.operandSegmentationId);
            if (
              !other?.segments[parameters.operandSegmentIndex] ||
              !other.representationData.Labelmap ||
              other.segmentationId === target.segmentationId
            )
              throw new Error('请选择另一个独立标注集中的源 Mask。');
            const otherIds: unknown = segmentation.getLabelmapImageIds(other.segmentationId);
            const otherReference =
              Array.isArray(otherIds) && cache.getImage(otherIds[0])?.referencedImageId;
            const sourceMeta = sourceImageId && metaData.get('instance', sourceImageId),
              otherMeta = otherReference && metaData.get('instance', otherReference);
            if (
              !sourceMeta ||
              !otherMeta ||
              ['StudyInstanceUID', 'SeriesInstanceUID', 'FrameOfReferenceUID'].some(
                key => !sourceMeta[key] || sourceMeta[key] !== otherMeta[key]
              )
            )
              throw new Error('两个 Mask 必须引用同一组原始 DICOM。');
            const otherVolume = maskVolumeFor({
              ...target,
              segmentationId: other.segmentationId,
              labelmap: other.representationData.Labelmap,
            });
            if (
              otherVolume.dimensions.some((v, i) => v !== dimensions[i]) ||
              otherVolume.spacing.some((v, i) => Math.abs(v - spacing[i]) > 1e-4)
            )
              throw new Error('两个 Mask 的体空间不一致。');
            for (const point of [
              [0, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ]) {
              const a = utilities.transformIndexToWorld(volume.imageData, [
                  point[0],
                  point[1],
                  point[2],
                ]),
                b = utilities.transformIndexToWorld(otherVolume.imageData, [
                  point[0],
                  point[1],
                  point[2],
                ]);
              if (a.some((v, i) => Math.abs(v - b[i]) > 1e-4))
                throw new Error('两个 Mask 的位置或方向不一致。');
            }
            const mask = new Uint8Array(count);
            for (let i = 0; i < count; i++) {
              mask[i] =
                otherVolume.voxelManager.getAtIndex(i) === parameters.operandSegmentIndex ? 1 : 0;
              if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
                check(task);
                ensureTarget(target);
                await pause();
                yieldAt = performance.now() + 20;
              }
            }
            operand = {
              segmentationId: other.segmentationId,
              segmentIndex: parameters.operandSegmentIndex,
              mask,
            };
            parameters.operandMask = mask;
          }
          let selection: Uint8Array;
          if (roi) {
            selection = new Uint8Array(count);
            for (let z = 0; z < dimensions[2]; z++) {
              const origin = utilities.transformIndexToWorld(volume.imageData, [0, 0, z]);
              const dx = utilities
                .transformIndexToWorld(volume.imageData, [1, 0, z])
                .map((v, i) => v - origin[i]);
              const dy = utilities
                .transformIndexToWorld(volume.imageData, [0, 1, z])
                .map((v, i) => v - origin[i]);
              selection.set(
                roiSelection(roi, dimensions[0], dimensions[1], origin, dx, dy),
                z * plane
              );
              if (z % 4 === 3) {
                check(task);
                ensureTarget(target);
                await pause();
              }
            }
          }
          if (parameters.operation === 'removeSeed' || parameters.operation === 'huGrow') {
            if (!parameters.worldPoint)
              throw new Error(
                parameters.operation === 'huGrow'
                  ? '请在切片上点选 HU 范围内的目标。'
                  : '请在切片上点选当前 Mask 内要删除的区域。'
              );
            if (roi && !roiContains(roi, parameters.worldPoint))
              throw new Error('请在 ROI 内点选种子。');
            parameters.seed = utilities
              .transformWorldToIndex(volume.imageData, parameters.worldPoint)
              .map(Math.round);
          }
          if (parameters.operation === 'huGrow') {
            if (
              !Number.isFinite(options.lower) ||
              !Number.isFinite(options.upper) ||
              options.lower > options.upper
            )
              throw new Error('请填写有效的 HU 上下限。');
            const candidates = new Uint8Array(count),
              frames = frameData(target),
              seen = new Set<number>();
            for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
              check(task);
              ensureTarget(target);
              const referenceId = frames[frameIndex].referenceId;
              const image =
                cache.getImage(referenceId) || (await imageLoader.loadAndCacheImage(referenceId));
              const instance = metaData.get('instance', referenceId);
              if (
                !image ||
                image.color ||
                Number(instance?.NumberOfFrames || 1) !== 1 ||
                instance?.SeriesInstanceUID !== series ||
                image.columns !== dimensions[0] ||
                image.rows !== dimensions[1]
              )
                throw new Error('原始静态灰度切片与 Mask 尺寸或序列不一致。');
              const origin = instance.ImagePositionPatient?.map(Number),
                orientation = instance.ImageOrientationPatient?.map(Number),
                pixelSpacing = instance.PixelSpacing?.map(Number);
              if (
                origin?.length !== 3 ||
                orientation?.length !== 6 ||
                pixelSpacing?.length !== 2 ||
                pixelSpacing.some(v => v <= 0) ||
                ![...origin, ...orientation, ...pixelSpacing].every(Number.isFinite)
              )
                throw new Error('原始切片空间信息不完整。');
              const point = volume.imageData.worldToIndex(origin);
              const dx = volume.imageData
                .worldToIndex(origin.map((v, i) => v + orientation[i] * pixelSpacing[1]))
                .map((v, i) => v - point[i]);
              const dy = volume.imageData
                .worldToIndex(origin.map((v, i) => v + orientation[i + 3] * pixelSpacing[0]))
                .map((v, i) => v - point[i]);
              const z = Math.round(point[2]);
              if (
                point.some((v, i) => Math.abs(v - [0, 0, z][i]) > 0.001) ||
                dx.some((v, i) => Math.abs(v - [1, 0, 0][i]) > 0.001) ||
                dy.some((v, i) => Math.abs(v - [0, 1, 0][i]) > 0.001) ||
                z < 0 ||
                z >= dimensions[2] ||
                seen.has(z)
              )
                throw new Error('原始切片与 Mask 体空间不一致，未执行灰度生长。');
              seen.add(z);
              const raw = image.getPixelData(),
                offset = z * plane;
              if (raw.length !== plane) throw new Error('原始切片像素长度与 Mask 不匹配。');
              for (let i = 0; i < plane; i++) {
                const value =
                  image.isPreScaled || image.preScale?.scaled
                    ? raw[i]
                    : raw[i] * (image.slope ?? 1) + (image.intercept ?? 0);
                if (
                  state[offset + i] !== 2 &&
                  (!selection || selection[offset + i]) &&
                  Number.isFinite(value) &&
                  value >= options.lower &&
                  value <= options.upper
                )
                  candidates[offset + i] = 1;
              }
              progress(task, 'prepare', 20, `正在读取 HU 切片 ${frameIndex + 1}/${frames.length}…`);
              await pause();
            }
            if (seen.size !== dimensions[2]) throw new Error('原始切片尚未完整载入。');
            const [sx, sy, sz] = parameters.seed;
            if (
              sx < 0 ||
              sy < 0 ||
              sz < 0 ||
              sx >= dimensions[0] ||
              sy >= dimensions[1] ||
              sz >= dimensions[2] ||
              !candidates[sx + dimensions[0] * sy + plane * sz]
            )
              throw new Error('种子不在 HU 范围内、ROI 外或已被其他 Mask 占用，请重新点选。');
            parameters.eligibility = candidates;
          }
          const input = state.slice();
          if (selection && ['largest', 'removeSmall', 'removeSeed'].includes(options.operation))
            for (let i = 0; i < count; i++) if (!selection[i] && input[i] === 1) input[i] = 0;
          progress(
            task,
            'compute',
            20,
            `正在计算${refinementLabels[options.operation] || '精修'}…`
          );
          const result = await calculate(
            input,
            [...dimensions],
            [...spacing],
            parameters,
            task,
            (completed, total) =>
              progress(
                task,
                'compute',
                20 + (completed / total) * 65,
                `正在计算${refinementLabels[options.operation] || '精修'}…`
              )
          );
          check(task);
          const preview: MaskRefinementPreview = {
            id: utilities.uuidv4(),
            operation: options.operation,
            segmentationId: target.segmentationId,
            segmentIndex: target.segmentIndex,
            label:
              service.getSegmentation(target.segmentationId)?.segments[target.segmentIndex]
                ?.label || 'Mask',
            before: 0,
            after: 0,
            added: 0,
            removed: 0,
            sliceCount: dimensions[2],
            voxelVolumeMm3: spacing.reduce((a, b) => a * b, 1),
            components: result.components,
            removedComponents: result.removedComponents,
            radiusMm: options.radiusMm,
            minimumVolumeMm3: options.minimumVolumeMm3,
            maximumCavityVolumeMm3: options.maximumCavityVolumeMm3,
            cavities: result.cavities,
            eligibleCavities: result.eligibleCavities,
            roi: Boolean(roi),
            lower: options.lower,
            upper: options.upper,
            startSlice: parameters.startSlice,
            endSlice: parameters.endSlice,
            keyframes: parameters.keyframes,
            replaceIntermediate: options.replaceIntermediate,
            interpolatedSlices: result.interpolatedSlices,
            skippedSlices: result.skippedSlices,
            booleanOperation: options.booleanOperation,
            operandLabel: operand
              ? `${service.getSegmentation(operand.segmentationId)?.label || '标注集'} / ${service.getSegmentation(operand.segmentationId)?.segments[operand.segmentIndex]?.label || 'Mask'}`
              : undefined,
            cutOffsetMm: options.cutOffsetMm,
            keepPositive: options.keepPositive,
          };
          yieldAt = performance.now() + 20;
          for (let i = 0; i < count; i++) {
            if (selection && !selection[i]) result.mask[i] = state[i] === 1 ? 1 : 0;
            if (state[i] === 2) result.mask[i] = 0;
            preview.before += Number(state[i] === 1);
            preview.after += result.mask[i];
            preview.added += Number(state[i] === 0 && result.mask[i] === 1);
            preview.removed += Number(state[i] === 1 && result.mask[i] === 0);
            if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
              progress(task, 'validate', 85 + (i / count) * 5, '正在统计精修增删体素…');
              await pause();
              yieldAt = performance.now() + 20;
            }
          }
          const plan = { preview, state, result: result.mask, target, volume, roi, operand };
          await verify(plan, task);
          check(task);
          progress(task, 'validate', 100, '精修预览计算完成。');
          // Progress listeners may synchronously request cancellation at the final checkpoint.
          check(task);
          task.phase = 'complete';
          calculation = undefined;
          pending = plan;
          publishRefinementPreview(preview);
          phase = 'complete';
          return {
            changed: 0,
            preview,
            message: `预览完成：预计新增 ${preview.added.toLocaleString()}、删除 ${preview.removed.toLocaleString()} 个体素；应用前 Mask 未改变。`,
          };
        } catch (error) {
          if (task.cancelled) {
            phase = 'cancelled';
            return { changed: 0, cancelled: true, message: cancellationError().message };
          }
          throw error;
        } finally {
          if (calculation === task) calculation = undefined;
          taskEvent(
            task,
            phase,
            phase === 'cancelled'
              ? cancellationError().message
              : phase === 'error'
                ? '精修计算未完成。'
                : '精修预览已就绪。'
          );
        }
      }),
    applyMaskRefinement: ({ previewId }: { previewId: string }) =>
      exclusive('正在应用整组 Mask 精修…', async () => {
        const plan = pending;
        if (!plan || plan.preview.id !== previewId) throw new Error('精修预览已失效，请重新预览。');
        discard({ previewId });
        await verify(plan);
        if (!plan.preview.added && !plan.preview.removed)
          return {
            changed: 0,
            applied: false,
            message: '当前参数不产生选区变化，未增加撤销记录。',
          };
        const memo = toolUtilities.segmentation.LabelmapMemo.createLabelmapMemo(
          plan.target.segmentationId,
          plan.volume.voxelManager
        );
        const plane = plan.volume.dimensions[0] * plan.volume.dimensions[1];
        let changed = 0,
          yieldAt = performance.now() + 20;
        try {
          for (let i = 0; i < plan.state.length; i++) {
            const value = plan.volume.voxelManager.getAtIndex(i);
            if (stateAt(value, plan.target.segmentIndex) !== plan.state[i])
              throw new Error('应用期间 Mask 已变化，已取消本次精修。');
            const next =
              plan.state[i] === 2 ? value : plan.result[i] ? plan.target.segmentIndex : 0;
            if (next !== value) {
              memo.voxelManager.setAtIndex(i, next);
              changed++;
            }
            if (i > 0 && i % plane === 0 && performance.now() >= yieldAt) {
              ensureTarget(plan.target);
              await pause();
              yieldAt = performance.now() + 20;
            }
          }
          ensureTarget(plan.target);
          await verifyOperand(plan);
          ensureTarget(plan.target);
          memo.commitMemo();
          const p = plan.preview;
          saveHistory(plan.target.segmentationId, [memo], {
            title: refinementLabels[p.operation],
            changed,
            added: p.added,
            removed: p.removed,
            parameters: {
              范围: p.roi ? 'ROI' : '整组',
              ...(['dilate', 'erode', 'open', 'close', 'smooth'].includes(p.operation)
                ? { '半径 mm': p.radiusMm }
                : {}),
              ...(p.operation === 'huGrow' ? { '下限 HU': p.lower, '上限 HU': p.upper } : {}),
              ...(p.operation === 'interpolate'
                ? {
                    起始层: p.startSlice,
                    结束层: p.endSlice,
                    关键层: p.keyframes?.join(', ') || `${p.startSlice}, ${p.endSlice}`,
                    已有中间层: p.replaceIntermediate ? '替换（关键层保留）' : '跳过',
                    '计算层数 / 跳过层数': `${p.interpolatedSlices} / ${p.skippedSlices}`,
                  }
                : {}),
              ...(p.operation === 'removeSmall' ? { '最小体积 mm³': p.minimumVolumeMm3 } : {}),
              ...(p.operation === 'fillCavities'
                ? {
                    '空腔最大体积 mm³': p.maximumCavityVolumeMm3 ?? '不限制',
                    '全组封闭空腔 / 符合门槛': `${p.cavities} / ${p.eligibleCavities}`,
                    背景连通: '26 邻接',
                  }
                : {}),
              ...(p.operation === 'boolean'
                ? { 运算: p.booleanOperation, '源 Mask': p.operandLabel }
                : {}),
              ...(p.operation === 'cut'
                ? {
                    '切面偏移 mm': p.cutOffsetMm ?? 0,
                    保留侧: p.keepPositive === false ? '反侧' : '法向侧',
                  }
                : {}),
            },
          });
          return {
            changed,
            applied: true,
            message: `${refinementLabels[plan.preview.operation]}完成：新增 ${plan.preview.added.toLocaleString()}、删除 ${plan.preview.removed.toLocaleString()} 个体素，可整组撤销。`,
          };
        } catch (error) {
          rollback(plan.target.segmentationId, [memo]);
          throw error;
        }
      }),
    getMaskRefinementPreviewData: ({ previewId }: { previewId: string }) => {
      if (!pending || pending.preview.id !== previewId) return;
      try {
        ensureTarget(pending.target);
      } catch {
        return;
      }
      return {
        state: pending.state,
        result: pending.result,
        imageData: pending.volume.imageData,
        dimensions: pending.volume.dimensions,
      };
    },
    discardMaskRefinementPreview: discard,
    cancelMaskRefinementCalculation: cancel,
    getMaskInterpolationKeyframes: () =>
      exclusive('正在读取当前 Mask 的已标注层…', async () => {
        const target = targetFor(),
          volume = maskVolumeFor(target),
          [w, h, depth] = volume.dimensions,
          plane = w * h;
        if (plane * depth > MAX_REFINEMENT_VOXELS)
          throw new Error('当前 Mask 超出本地精修处理上限，请分段选择关键层。');
        const keyframes: number[] = [];
        let yieldAt = performance.now() + 20;
        for (let z = 0; z < depth; z++) {
          for (let i = z * plane; i < (z + 1) * plane; i++) {
            if (volume.voxelManager.getAtIndex(i) === target.segmentIndex) {
              keyframes.push(z + 1);
              break;
            }
          }
          if (keyframes.length > MAX_INTERPOLATION_KEYFRAMES)
            throw new Error(
              `已标注层超过 ${MAX_INTERPOLATION_KEYFRAMES} 张，请手动选择最多 ${MAX_INTERPOLATION_KEYFRAMES} 张关键层。`
            );
          if (performance.now() >= yieldAt) {
            ensureTarget(target);
            reportMaskOperation('progress', `正在读取已标注层：${z + 1} / ${depth}…`);
            await pause();
            yieldAt = performance.now() + 20;
          }
        }
        ensureTarget(target);
        return {
          changed: 0,
          keyframes,
          total: depth,
          message: `读取到 ${keyframes.length} 张已标注层，请确认关键层列表后再预览。`,
        };
      }),
    getMaskRefinementSliceContext: () => {
      const target = targetFor(),
        volume = maskVolumeFor(target);
      const origin = utilities.transformIndexToWorld(volume.imageData, [0, 0, 0]);
      const next = utilities.transformIndexToWorld(volume.imageData, [0, 0, 1]);
      const axis = next.map((v, i) => v - origin[i]),
        normal = target.viewport.getCamera().viewPlaneNormal;
      const cosine = axis.reduce((sum, v, i) => sum + v * normal[i], 0) / Math.hypot(...axis);
      if (Math.abs(cosine) < 0.9999)
        throw new Error('设置插值关键层时，请选择与原始扫描方向一致的轴向切片窗口。');
      const index = utilities.transformWorldToIndex(
        volume.imageData,
        target.viewport.getCamera().focalPoint
      );
      return {
        slice: Math.max(1, Math.min(volume.dimensions[2], Math.round(index[2]) + 1)),
        total: volume.dimensions[2],
      };
    },
    configureMaskHuGrow: (options: typeof huParameters) => {
      huParameters = { ...options };
      return { changed: 0, message: 'HU 灰度生长参数已设置。' };
    },
    previewMaskHuGrowFromSeed: (options: {
      worldPoint: [number, number, number];
      viewportId?: string;
    }) => actions.previewMaskRefinement({ ...huParameters, ...options, operation: 'huGrow' }),
  };
  return actions;
}

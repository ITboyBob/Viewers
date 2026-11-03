import { utilities } from '@cornerstonejs/core';
import { utilities as toolUtilities } from '@cornerstonejs/tools';
import { refineMask, MAX_REFINEMENT_VOXELS } from './refinementAlgorithms';
import type { RefinementOptions } from './refinementAlgorithms';
import { publishRefinementPreview, publishRefinementTask } from './maskRefinementEvents';
import type { MaskRefinementPreview, MaskRefinementTask } from './maskRefinementEvents';
import { reportMaskOperation } from './maskOperationEvents';

export const refinementLabels = {
  dilate: '三维膨胀',
  erode: '三维腐蚀',
  open: '三维开运算',
  close: '三维闭运算',
  smooth: '三维平滑（先开后闭）',
  largest: '保留最大连通区域',
  removeSmall: '删除小碎片',
  removeSeed: '点选删除连通区域',
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
}) {
  const service = servicesManager.services.segmentationService;
  let calculation: CalculationTask;
  let pending: {
    preview: MaskRefinementPreview;
    state: Uint8Array;
    result: Uint8Array;
    target: ReturnType<typeof targetFor>;
    volume: ReturnType<typeof maskVolumeFor>;
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
  async function verify(plan: NonNullable<typeof pending>, task?: CalculationTask) {
    if (task) check(task);
    ensureTarget(plan.target);
    const current = maskVolumeFor(targetFor());
    if (
      current.imageData !== plan.volume.imageData ||
      current.dimensions.some((v, i) => v !== plan.volume.dimensions[i]) ||
      current.spacing.some((v, i) => Math.abs(v - plan.volume.spacing[i]) > 0.0001)
    )
      throw new Error('Mask 体数据或布局已变化，请重新生成精修预览。');
    const plane = current.dimensions[0] * current.dimensions[1];
    let yieldAt = performance.now() + 20;
    for (let i = 0; i < plan.state.length; i++) {
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
  return {
    previewMaskRefinement: (
      options: RefinementOptions & { worldPoint?: [number, number, number]; viewportId?: string }
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
          if (parameters.operation === 'removeSeed') {
            if (!parameters.worldPoint) throw new Error('请在切片上点选当前 Mask 内要删除的区域。');
            parameters.seed = utilities
              .transformWorldToIndex(volume.imageData, parameters.worldPoint)
              .map(Math.round);
          }
          progress(
            task,
            'compute',
            20,
            `正在计算${refinementLabels[options.operation] || '精修'}…`
          );
          const result = await calculate(
            state.slice(),
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
          };
          yieldAt = performance.now() + 20;
          for (let i = 0; i < count; i++) {
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
          const plan = { preview, state, result: result.mask, target, volume };
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
          memo.commitMemo();
          saveHistory(plan.target.segmentationId, [memo]);
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
  };
}

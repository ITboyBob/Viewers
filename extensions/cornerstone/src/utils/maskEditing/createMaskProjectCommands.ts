import { StackViewport, VolumeViewport, cache, metaData, utilities } from '@cornerstonejs/core';
import { segmentation, Enums } from '@cornerstonejs/tools';
import {
  MAX_PROJECT_FILE_BYTES,
  validateProjectSource,
  matchProjectFrames,
  MaskProjectManifest,
  ProjectSource,
  ProjectSegment,
} from './maskProjectCodec';
import { reportMaskOperation } from './maskOperationEvents';
import { maskProgress } from './maskProgress';
import { putMaskDraft, readMaskDraft } from './maskDraftStorage';

type ProjectResult = { changed: number; message: string; segmentationId?: string };
type Exclusive = (
  message: string,
  operation: () => Promise<ProjectResult>
) => Promise<ProjectResult>;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function projectWorker(
  data,
  bytes: Uint8Array
): Promise<{
  archive?: Uint8Array;
  labels?: Uint8Array;
  manifest?: MaskProjectManifest;
  fingerprint?: string;
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./maskProject.worker.ts', import.meta.url));
    worker.onmessage = event => {
      worker.terminate();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
    };
    worker.onerror = event => {
      event.preventDefault();
      worker.terminate();
      reject(new Error('标注文件处理失败，请检查文件后重试。'));
    };
    worker.postMessage(data, [bytes.buffer]);
  });
}

/** Local editing state, separate from the interoperable DICOM SEG export. */
export default function createMaskProjectCommands(
  { servicesManager, commandsManager }: Pick<withAppTypes, 'servicesManager' | 'commandsManager'>,
  exclusive: Exclusive
) {
  const {
    segmentationService: service,
    viewportGridService,
    cornerstoneViewportService,
    displaySetService,
  } = servicesManager.services;
  const type = Enums.SegmentationRepresentations.Labelmap;

  function context(viewportId = viewportGridService.getActiveViewportId()) {
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (!(viewport instanceof StackViewport || viewport instanceof VolumeViewport))
      throw new Error('请先选择 CT 切片窗口，再保存或载入标注文件。');
    const displaySetId = viewportGridService.getDisplaySetsUIDsForViewport(viewportId)?.[0];
    const displaySet = displaySetService.getDisplaySetByUID(displaySetId);
    if (
      !displaySet?.imageIds?.length ||
      ('isDynamicVolume' in displaySet && displaySet.isDynamicVolume)
    )
      throw new Error('请先载入完整的静态 DICOM 序列；暂不支持动态或增强多帧影像。');
    return { viewportId, displaySetId, displaySet };
  }

  function ensureContext(target: ReturnType<typeof context>) {
    const now = context();
    if (
      now.viewportId !== target.viewportId ||
      now.displaySetId !== target.displaySetId ||
      now.displaySet !== target.displaySet
    )
      throw new Error('影像或窗口已切换，载入已取消，请在目标序列上重试。');
  }

  function sourceFor(imageIds: string[]): ProjectSource {
    const instances = imageIds.map(id => metaData.get('instance', id));
    const first = instances[0];
    if (
      !first ||
      instances.some(
        instance =>
          !instance ||
          Number(instance.NumberOfFrames || 1) !== 1 ||
          instance.StudyInstanceUID !== first.StudyInstanceUID ||
          instance.SeriesInstanceUID !== first.SeriesInstanceUID ||
          instance.FrameOfReferenceUID !== first.FrameOfReferenceUID
      )
    )
      throw new Error('原始切片元数据不完整或包含多个序列，暂不支持此影像。');
    const source: ProjectSource = {
      studyInstanceUID: first.StudyInstanceUID,
      seriesInstanceUID: first.SeriesInstanceUID,
      frameOfReferenceUID: first.FrameOfReferenceUID,
      frames: instances.map(instance => ({
        sopInstanceUID: instance.SOPInstanceUID || instance.SopInstanceUID,
        rows: Number(instance.Rows),
        columns: Number(instance.Columns),
        position: instance.ImagePositionPatient?.map(Number),
        orientation: instance.ImageOrientationPatient?.map(Number),
        spacing: instance.PixelSpacing?.map(Number),
      })),
    };
    validateProjectSource(source);
    return source;
  }

  function framesFor(id: string) {
    const current = service.getSegmentation(id);
    const labelmap = current?.representationData.Labelmap as
      | { volumeId?: string; referencedImageIds?: string[] }
      | undefined;
    const ids: unknown = segmentation.getLabelmapImageIds(id);
    if (!labelmap || !Array.isArray(ids) || !ids.length) throw new Error('标注切片数据尚未就绪。');
    const volume = labelmap.volumeId ? cache.getVolume(labelmap.volumeId) : undefined;
    return ids.map((imageId: string, index: number) => {
      const image = cache.getImage(imageId);
      const referenceId =
        image?.referencedImageId ||
        labelmap.referencedImageIds?.[index] ||
        volume?.referencedImageIds?.[index];
      if (!image?.voxelManager || !referenceId) throw new Error('找不到标注对应的原始切片。');
      return { image, referenceId };
    });
  }

  async function capture(segmentationId?: string, viewportId?: string) {
    const target = context(viewportId);
    const current = segmentationId
      ? service.getSegmentation(segmentationId)
      : service.getActiveSegmentation(target.viewportId);
    if (!current?.representationData.Labelmap) throw new Error('请先选择要保存的标注集。');
    // Snapshot metadata and pixels in one turn, before worker compression or any await.
    const id = current.segmentationId;
    const revision = maskProgress.get(id).revision;
    const frames = framesFor(id);
    const source = sourceFor(frames.map(frame => frame.referenceId));
    matchProjectFrames(source, sourceFor(target.displaySet.imageIds));
    const labels = new Uint8Array(validateProjectSource(source));
    let offset = 0;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      const pixels = frame.image.getPixelData();
      const geometry = source.frames[index];
      if (
        !(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) ||
        pixels.length !== geometry.rows * geometry.columns ||
        frame.image.rows !== geometry.rows ||
        frame.image.columns !== geometry.columns
      )
        throw new Error('本地标注文件仅支持尺寸匹配的 8 位 Mask，请使用 DICOM SEG 导出其他数据。');
      labels.set(pixels, offset);
      offset += pixels.length;
    }
    const segments: ProjectSegment[] = Object.values(current.segments).map((segment: any) => {
      const style = service.getStyle({
        viewportId: target.viewportId,
        segmentationId: id,
        segmentIndex: segment.segmentIndex,
        type,
      }) as ProjectSegment['style'];
      return {
        index: segment.segmentIndex,
        label: segment.label || '',
        color: [
          ...service.getSegmentColor(target.viewportId, id, segment.segmentIndex),
        ] as ProjectSegment['color'],
        visible: segmentation.config.visibility.getSegmentIndexVisibility(
          target.viewportId,
          { segmentationId: id, type },
          segment.segmentIndex
        ),
        locked: segmentation.segmentLocking.isSegmentIndexLocked(id, segment.segmentIndex),
        style: {
          fillAlpha: style.fillAlpha,
          outlineWidth: style.outlineWidth,
          renderFill: style.renderFill,
          renderOutline: style.renderOutline,
        },
      };
    });
    const manifest: MaskProjectManifest = {
      format: 'OHIF_MASK_PROJECT',
      version: 1,
      createdAt: new Date().toISOString(),
      label: current.label || '标注集',
      source,
      segments,
      activeSegmentIndex:
        Object.values(current.segments).find(segment => segment.active)?.segmentIndex ?? null,
      labelmap: { encoding: 'uint8', byteLength: labels.length, sha256: '' },
    };
    const { archive, fingerprint } = await projectWorker(
      { task: 'save', manifest, labels },
      labels
    );
    return { archive, manifest, id, revision, fingerprint };
  }

  const actions = {
    saveMaskProject: () =>
      exclusive('正在保存本地标注文件…', async () => {
        const { archive, manifest, id, revision, fingerprint } = await capture();
        const blob = new Blob([archive], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        const name =
          manifest.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '标注集';
        anchor.download = `${name}.ohifmask`;
        anchor.click();
        if (service.getSegmentation(id)) maskProgress.saved(id, revision, fingerprint);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return {
          changed: 0,
          message: `已保存 ${manifest.segments.length} 个 Mask 的本地标注文件；请同时保留原始 DICOM。`,
        };
      }),

    loadMaskProject: ({ file, isDraft = false }: { file: File; isDraft?: boolean }) =>
      exclusive('正在校验并载入标注文件…', async () => {
        const target = context();
        if (!file || !file.size || file.size > MAX_PROJECT_FILE_BYTES)
          throw new Error('标注文件为空或过大，请选择有效的 .ohifmask 文件。');
        const archive = new Uint8Array(await file.arrayBuffer());
        const { manifest, labels, fingerprint } = await projectWorker(
          { task: 'load', archive },
          archive
        );
        ensureContext(target);
        // Reject the wrong series, missing slices and altered geometry before creating any state.
        matchProjectFrames(manifest.source, sourceFor(target.displaySet.imageIds));
        const previousId = service.getActiveSegmentation(target.viewportId)?.segmentationId;
        const previousIndex = service.getActiveSegment(target.viewportId)?.segmentIndex;
        const id = utilities.uuidv4();
        let createdImageIds: string[] = [];
        function ensureCreatedTarget() {
          ensureContext(target);
          if (
            !service.getSegmentation(id) ||
            service.getActiveSegmentation(target.viewportId)?.segmentationId !== id
          )
            throw new Error('标注集已切换或删除，载入已取消，请重新执行。');
        }
        let name = manifest.label || '标注集';
        const names = new Set(service.getSegmentations().map(item => item.label));
        for (let suffix = 2; names.has(name); suffix++)
          name = `${manifest.label || '标注集'} (${suffix})`;
        try {
          const created = await commandsManager.run('createLabelmapForViewport', {
            viewportId: target.viewportId,
            options: {
              segmentationId: id,
              label: name,
              createInitialSegment: true,
              displaySetInstanceUID: target.displaySetId,
            },
          });
          if (created !== id) throw new Error('未能为当前影像创建标注集。');
          ensureContext(target);
          const frames = framesFor(id);
          createdImageIds = frames.map(frame => frame.image.imageId);
          const mapping = matchProjectFrames(
            manifest.source,
            sourceFor(frames.map(f => f.referenceId))
          );
          for (let i = 0; i < mapping.length; i++) {
            const image = frames[mapping[i]].image;
            const source = manifest.source.frames[i];
            if (
              image.rows !== source.rows ||
              image.columns !== source.columns ||
              image.getPixelData().length !== source.rows * source.columns
            )
              throw new Error('新标注集的切片尺寸不匹配，载入已取消。');
          }
          for (const segment of manifest.segments)
            service.addSegment(id, { segmentIndex: segment.index, label: segment.label });
          if (!manifest.segments.some(segment => segment.index === 1)) service.removeSegment(id, 1);
          let offset = 0;
          let nextYield = performance.now() + 20;
          for (let saved = 0; saved < mapping.length; saved++) {
            const frame = frames[mapping[saved]];
            const count =
              manifest.source.frames[saved].rows * manifest.source.frames[saved].columns;
            for (let i = 0; i < count; i++) {
              const value = labels[offset + i];
              if (value) frame.image.voxelManager.setAtIndex(i, value);
            }
            offset += count;
            if (performance.now() >= nextYield) {
              reportMaskOperation('progress', `正在恢复切片 ${saved + 1}/${mapping.length}…`);
              await pause();
              ensureCreatedTarget();
              nextYield = performance.now() + 20;
            }
          }
          ensureCreatedTarget();
          for (const segment of manifest.segments) {
            service.setSegmentLabel(id, segment.index, segment.label);
            service.setSegmentColorForAllViewports(id, segment.index, segment.color);
            service.setSegmentVisibilityForAllViewports(id, segment.index, segment.visible);
            service.setSegmentLocked(id, segment.index, segment.locked);
            const style = segment.style;
            const patch = {
              ...style,
              fillAlphaInactive: style.fillAlpha,
              outlineWidthInactive: style.outlineWidth,
              renderFillInactive: style.renderFill,
              renderOutlineInactive: style.renderOutline,
            };
            service.setStyle({ type, segmentationId: id, segmentIndex: segment.index }, patch);
            service
              .getViewportIdsWithSegmentation(id)
              .forEach(viewportId =>
                service.setStyle(
                  { type, segmentationId: id, segmentIndex: segment.index, viewportId },
                  patch
                )
              );
          }
          service.setActiveSegmentation(target.viewportId, id);
          if (manifest.activeSegmentIndex !== null)
            service.setActiveSegment(id, manifest.activeSegmentIndex);
          segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(id);
          cornerstoneViewportService.getRenderingEngine()?.render();
          if (!isDraft) maskProgress.saved(id, maskProgress.get(id).revision, fingerprint);
          return {
            changed: 0,
            segmentationId: id,
            message: `已载入 ${manifest.segments.length} 个 Mask 到新标注集，可继续编辑；原有标注集已保留。`,
          };
        } catch (error) {
          const activeId = service.getActiveSegmentation(target.viewportId)?.segmentationId;
          if (service.getSegmentation(id)) {
            service
              .getViewportIdsWithSegmentation(id)
              .forEach(viewportId =>
                service.removeSegmentationRepresentations(viewportId, { segmentationId: id })
              );
            service.remove(id);
          }
          createdImageIds.forEach(imageId => {
            if (cache.getImage(imageId)) cache.removeImageLoadObject(imageId);
          });
          if ((!activeId || activeId === id) && previousId && service.getSegmentation(previousId)) {
            service.setActiveSegmentation(target.viewportId, previousId);
            if (previousIndex) service.setActiveSegment(previousId, previousIndex);
          }
          throw error;
        }
      }),
    backupMaskProject: ({ segmentationId }: { segmentationId: string }) =>
      exclusive('正在本地暂存标注…', async () => {
        const viewportId = service.getViewportIdsWithSegmentation(segmentationId).find(id => {
          const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
          return viewport instanceof StackViewport || viewport instanceof VolumeViewport;
        });
        if (!viewportId) throw new Error('标注集尚未关联切片窗口，请手动保存标注文件。');
        const { archive, manifest, id, revision, fingerprint } = await capture(
          segmentationId,
          viewportId
        );
        const savedAt = new Date().toISOString();
        const blob = new Blob([archive], { type: 'application/zip' });
        await putMaskDraft(
          {
            key: `${manifest.source.seriesInstanceUID}:${id}`,
            seriesInstanceUID: manifest.source.seriesInstanceUID,
            segmentationId: id,
            label: manifest.label,
            savedAt,
            size: blob.size,
          },
          blob
        );
        if (service.getSegmentation(id)) maskProgress.drafted(id, revision, savedAt, fingerprint);
        return { changed: 0, message: '已本地暂存标注；建议定期保存标注文件。' };
      }),
    restoreMaskDraft: async ({ key }: { key: string }) => {
      const blob = await readMaskDraft(key);
      return actions.loadMaskProject({ file: new File([blob], '恢复.ohifmask'), isDraft: true });
    },
  };
  return actions;
}

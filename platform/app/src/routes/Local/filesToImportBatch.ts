import type { BatchFailure, BatchSuccess, ImportBatch, ImportSelection } from '@ohif/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import FileLoaderService from './fileLoaderService';

// 只记录本调用实际添加的索引，不按文件名或全局缓存推测所有权。
const ownedFiles = new WeakMap<ImportBatch, number[]>();
const uid = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(value);
const fileIndex = (imageId: unknown): number | undefined => {
  if (typeof imageId !== 'string' || !/^dicomfile:(0|[1-9][0-9]*)$/.test(imageId)) {
    return;
  }
  const index = Number(imageId.slice('dicomfile:'.length));
  return Number.isSafeInteger(index) ? index : undefined;
};
function removeOwned(index: number | undefined): boolean {
  if (index === undefined) {
    return true;
  }
  try {
    dicomImageLoader.wadouri.fileManager.remove(index);
    return true;
  } catch (error) {
    return false;
  }
}
function folderTitle(input: ImportSelection): string | undefined {
  if (input.kind !== 'folder') {
    return;
  }
  const roots = input.files.map(file => file.webkitRelativePath?.split('/')[0]);
  const root = roots[0];
  const hasPaths = roots.some(Boolean);
  const inferred = root && roots.every(value => value === root) ? root : undefined;
  if (hasPaths && (!inferred || (input.folderName && input.folderName !== inferred))) {
    throw new Error('请重新选择单一文件夹');
  }
  const title = inferred || input.folderName;
  if (!title || title.includes('/') || title.includes('\\') || !title.trim()) {
    throw new Error('请重新选择单一文件夹');
  }
  return title;
}
export default async function filesToImportBatch(input: ImportSelection): Promise<ImportBatch> {
  const files = [...input.files];
  const kind = input.kind;
  const batch_id = crypto.randomUUID();
  const folder_name = folderTitle({ ...input, files });
  const indexes: number[] = [];
  const results = await Promise.all(
    files.map(async (file, selection_index) => {
      let index: number | undefined;
      let invalid = false;
      try {
        const loader = new FileLoaderService(file);
        const image_id = loader.addFile(file);
        index = fileIndex(image_id);
        if (index === undefined) {
          invalid = true;
          throw new Error();
        }
        const image = await loader.loadFile(file, image_id);
        const raw = await loader.getDataset(image, image_id);
        if (!raw || ![raw.StudyInstanceUID, raw.SeriesInstanceUID, raw.SOPInstanceUID].every(uid)) {
          invalid = true;
          throw new Error();
        }
        indexes.push(index);
        const result: BatchSuccess = Object.freeze({
          selection_index,
          file_name: file.name,
          ...(file.webkitRelativePath ? { relative_path: file.webkitRelativePath } : {}),
          image_id,
          study_uid: raw.StudyInstanceUID,
          series_uid: raw.SeriesInstanceUID,
          sop_uid: raw.SOPInstanceUID,
          dataset: { ...raw, url: image_id, imageId: image_id },
        });
        return { success: result };
      } catch (error) {
        const cleaned = removeOwned(index);
        const failure: BatchFailure = {
          selection_index,
          file_name: file.name,
          reason: !cleaned ? 'CLEANUP_FAILED' : invalid ? 'INVALID_DATASET' : 'PARSE_FAILED',
        };
        return { failure };
      }
    })
  );
  const successes = results.flatMap(result => (result.success ? [result.success] : []));
  const batch: ImportBatch = Object.freeze({
    batch_id,
    kind,
    ...(folder_name ? { folder_name } : {}),
    successes: Object.freeze(successes),
    failures: Object.freeze(
      results.flatMap(result => (result.failure ? [Object.freeze(result.failure)] : []))
    ),
    study_uids: Object.freeze([...new Set(successes.map(item => item.study_uid))]),
  });
  ownedFiles.set(
    batch,
    indexes.sort((a, b) => a - b)
  );
  return batch;
}
/** 幂等释放本批次拥有的文件；清理失败只报告结果，不purge或触碰其他批次。 */
export function releaseImportBatch(batch: ImportBatch): boolean {
  const indexes = ownedFiles.get(batch) ?? [];
  ownedFiles.delete(batch);
  return indexes.map(removeOwned).every(Boolean);
}

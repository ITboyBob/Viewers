export type MaskDraft = {
  key: string;
  seriesInstanceUID: string;
  segmentationId: string;
  label: string;
  savedAt: string;
  size: number;
};
const MAX_BYTES = 192 * 1024 * 1024;
const MAX_DRAFTS = 6;
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ohif-mask-drafts', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'key' });
      request.result.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开浏览器暂存空间，请手动保存标注文件。'));
    request.onblocked = () => reject(new Error('暂存空间被旧页面占用，请关闭旧页面后重试。'));
  });
}
export async function listMaskDrafts(seriesInstanceUID: string): Promise<MaskDraft[]> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAll();
      request.onsuccess = () =>
        resolve(
          request.result
            .filter(item => item.seriesInstanceUID === seriesInstanceUID)
            .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
        );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function putMaskDraft(draft: MaskDraft, blob: Blob) {
  if (blob.size > MAX_BYTES || draft.size !== blob.size) throw new Error('暂存文件大小无效。');
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['drafts', 'files'], 'readwrite');
      const metadata = transaction.objectStore('drafts'),
        files = transaction.objectStore('files');
      const request = metadata.getAll();
      request.onsuccess = () => {
        try {
          const previous = request.result
            .filter(item => item.key !== draft.key)
            .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
          let bytes = blob.size,
            count = 1;
          for (const item of previous) {
            if (++count > MAX_DRAFTS || bytes + item.size > MAX_BYTES) {
              metadata.delete(item.key);
              files.delete(item.key);
            } else bytes += item.size;
          }
          metadata.put(draft);
          files.put(blob, draft.key);
        } catch {
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(
          new Error(
            '本地暂存失败，可能是浏览器空间不足；上次成功的暂存仍保留，请手动保存标注文件。'
          )
        );
    });
  } finally {
    db.close();
  }
}
export async function readMaskDraft(key: string): Promise<Blob> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get(key);
      request.onsuccess = () =>
        request.result instanceof Blob
          ? resolve(request.result)
          : reject(new Error('本地暂存不存在，可能已被浏览器清理，请载入标注文件。'));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

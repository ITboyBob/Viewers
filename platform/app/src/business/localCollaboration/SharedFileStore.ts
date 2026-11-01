import type {
  SharedFileBundle,
  SharedFileManifest,
  SharedFilePort,
  SharedFileRecord,
} from '@ohif/core';

type FailureCode =
  | 'cache_invalid'
  | 'context_conflict'
  | 'storage_unavailable'
  | 'quota_exceeded'
  | 'cancelled';
export class SharedFileError extends Error {
  constructor(readonly code: FailureCode) {
    super(
      {
        cache_invalid: '共享文件不完整，请重新确认来源',
        context_conflict: '本地任务共享上下文冲突',
        storage_unavailable: '本地共享存储不可用',
        quota_exceeded: '本地共享存储空间不足',
        cancelled: '本次共享已取消',
      }[code]
    );
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.length > 0;
const uid = (value: unknown) =>
  typeof value === 'string' && value.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const keys = (value: Record<string, unknown>, allowed: string) =>
  Object.keys(value).every(key => allowed.split(' ').includes(key));
const invalid = () => {
  throw new SharedFileError('cache_invalid');
};
const classify = (error: unknown) =>
  error instanceof SharedFileError
    ? error
    : new SharedFileError(
        (error as DOMException)?.name === 'QuotaExceededError'
          ? 'quota_exceeded'
          : 'storage_unavailable'
      );

/** 严格白名单校验，绝不让运行句柄、dataset、凭证混入持久记录。 */
export function validateSharedManifest(value: unknown): SharedFileManifest {
  if (
    !record(value) ||
    !keys(
      value,
      'cache_version cache_state task_id batch_id source_participant_id title team_id importer_uid mode_path files'
    ) ||
    value.cache_version !== 1 ||
    value.cache_state !== 'ready' ||
    ![
      value.task_id,
      value.batch_id,
      value.source_participant_id,
      value.title,
      value.team_id,
      value.importer_uid,
    ].every(text) ||
    typeof value.mode_path !== 'string' ||
    !['segmentation/dicomlocal', 'microscopy'].includes(value.mode_path) ||
    !Array.isArray(value.files) ||
    !value.files.length
  ) {
    return invalid();
  }
  let previous = -1;
  for (const item of value.files) {
    if (
      !record(item) ||
      !keys(item, 'selection_index file_name study_uid series_uid sop_uid byte_length') ||
      !integer(item.selection_index) ||
      item.selection_index <= previous ||
      !text(item.file_name) ||
      ![item.study_uid, item.series_uid, item.sop_uid].every(uid) ||
      !integer(item.byte_length)
    ) {
      return invalid();
    }
    previous = item.selection_index;
  }
  return Object.freeze({
    cache_version: 1,
    cache_state: 'ready',
    task_id: value.task_id,
    batch_id: value.batch_id,
    source_participant_id: value.source_participant_id,
    title: value.title,
    team_id: value.team_id,
    importer_uid: value.importer_uid,
    mode_path: value.mode_path,
    files: Object.freeze(
      value.files.map(item =>
        Object.freeze({
          selection_index: item.selection_index,
          file_name: item.file_name,
          study_uid: item.study_uid,
          series_uid: item.series_uid,
          sop_uid: item.sop_uid,
          byte_length: item.byte_length,
        })
      )
    ),
  }) as SharedFileManifest;
}
export function validateSharedBundle(value: unknown): SharedFileBundle {
  if (!record(value) || !keys(value, 'manifest files')) {
    return invalid();
  }
  const manifest = validateSharedManifest(value.manifest);
  if (!Array.isArray(value.files) || value.files.length !== manifest.files.length) {
    return invalid();
  }
  const files = value.files.map((file, index) => {
    const item = manifest.files[index];
    if (
      !record(file) ||
      !keys(file, 'batch_id selection_index blob') ||
      file.batch_id !== manifest.batch_id ||
      file.selection_index !== item.selection_index ||
      !(file.blob instanceof Blob) ||
      file.blob.size !== item.byte_length
    ) {
      return invalid();
    }
    return Object.freeze({
      batch_id: file.batch_id,
      selection_index: file.selection_index,
      blob: file.blob,
    });
  });
  return Object.freeze({ manifest, files: Object.freeze(files) });
}

export class SharedFileStore implements SharedFilePort {
  constructor(
    private readonly options: { indexedDB?: IDBFactory | null; basePath?: string } = {}
  ) {}

  private open(signal: AbortSignal): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new SharedFileError('cancelled'));
        return;
      }
      let factory: IDBFactory | undefined | null;
      try {
        factory =
          this.options.indexedDB === undefined ? globalThis.indexedDB : this.options.indexedDB;
      } catch {
        reject(new SharedFileError('storage_unavailable'));
        return;
      }
      if (!factory) {
        reject(new SharedFileError('storage_unavailable'));
        return;
      }
      let request: IDBOpenDBRequest;
      let stopped = false;
      const fail = (error: unknown) => {
        stopped = true;
        signal.removeEventListener('abort', abort);
        reject(classify(error));
      };
      const abort = () => fail(new SharedFileError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        request = factory.open(`colla.local-shared.v1:${this.options.basePath ?? '/'}`, 1);
      } catch (error) {
        fail(error);
        return;
      }
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          db.createObjectStore('manifests', { keyPath: 'task_id' });
          db.createObjectStore('files', { keyPath: ['batch_id', 'selection_index'] });
        } catch (error) {
          request.transaction?.abort();
          fail(error);
        }
      };
      request.onblocked = () => fail(new SharedFileError('storage_unavailable'));
      request.onerror = () => fail(request.error);
      request.onsuccess = () => {
        signal.removeEventListener('abort', abort);
        if (stopped || signal.aborted) {
          request.result.close();
          reject(new SharedFileError('cancelled'));
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    operation: (
      tx: IDBTransaction,
      done: (value: T) => void,
      fail: (error: unknown) => void
    ) => void
  ): Promise<T> {
    const db = await this.open(signal);
    try {
      if (signal.aborted) {
        throw new SharedFileError('cancelled');
      }
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(['manifests', 'files'], mode);
        } catch (error) {
          reject(classify(error));
          return;
        }
        let result: T;
        let failure: Error | null = null;
        const cleanup = () => signal.removeEventListener('abort', abort);
        const fail = (error: unknown) => {
          failure = classify(error);
          try {
            tx.abort();
          } catch {
            cleanup();
            reject(failure);
          }
        };
        const abort = () => fail(new SharedFileError('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => {
          cleanup();
          signal.aborted ? reject(new SharedFileError('cancelled')) : resolve(result);
        };
        tx.onabort = () => {
          cleanup();
          reject(failure ?? classify(tx.error));
        };
        tx.onerror = event => {
          failure ??= classify((event.target as IDBRequest | null)?.error ?? tx.error);
        };
        try {
          operation(
            tx,
            value => {
              result = value;
            },
            fail
          );
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      db.close();
    }
  }

  private readFiles(
    tx: IDBTransaction,
    manifest: SharedFileManifest,
    done: (bundle: SharedFileBundle) => void,
    fail: (error: unknown) => void
  ) {
    const files: SharedFileRecord[] = new Array(manifest.files.length);
    let remaining = files.length;
    manifest.files.forEach((item, index) => {
      const request = tx.objectStore('files').get([manifest.batch_id, item.selection_index]);
      request.onsuccess = () => {
        try {
          files[index] = request.result;
          if (--remaining === 0) {
            done(validateSharedBundle({ manifest, files }));
          }
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  async publish(input: SharedFileBundle, signal: AbortSignal): Promise<SharedFileManifest> {
    const bundle = validateSharedBundle(input);
    return this.transaction('readwrite', signal, (tx, done, fail) => {
      const store = tx.objectStore('manifests');
      const existing = store.get(bundle.manifest.task_id);
      existing.onsuccess = () => {
        try {
          if (existing.result !== undefined) {
            const manifest = validateSharedManifest(existing.result);
            if (JSON.stringify(manifest) !== JSON.stringify(bundle.manifest)) {
              throw new SharedFileError('context_conflict');
            }
            this.readFiles(tx, manifest, result => done(result.manifest), fail);
            return;
          }
          // add 而非 put：任何复合文件键冲突都会中止同一事务，不能覆盖旧源。
          bundle.files.forEach(file => tx.objectStore('files').add(file));
          store.add(bundle.manifest);
          done(bundle.manifest);
        } catch (error) {
          fail(error);
        }
      };
    });
  }

  read(
    task: string,
    batch: string,
    source: string,
    signal: AbortSignal
  ): Promise<SharedFileBundle> {
    return this.transaction('readonly', signal, (tx, done, fail) => {
      const request = tx.objectStore('manifests').get(task);
      request.onsuccess = () => {
        try {
          const manifest = validateSharedManifest(request.result);
          if (
            manifest.task_id !== task ||
            manifest.batch_id !== batch ||
            manifest.source_participant_id !== source
          ) {
            throw new SharedFileError('context_conflict');
          }
          this.readFiles(tx, manifest, done, fail);
        } catch (error) {
          fail(error);
        }
      };
    });
  }
}

import { SharedFileStore } from './SharedFileStore';
import type { SharedFileBundle } from '@ohif/core';

function bundle(): SharedFileBundle {
  return {
    manifest: {
      cache_version: 1,
      cache_state: 'ready',
      task_id: 'task',
      batch_id: 'batch',
      source_participant_id: 'source',
      title: '影像',
      team_id: 'team',
      importer_uid: 'a',
      mode_path: 'segmentation/dicomlocal',
      files: [
        {
          selection_index: 2,
          file_name: '影像.dcm',
          study_uid: '1.2',
          series_uid: '1.3',
          sop_uid: '1.4',
          byte_length: 3,
        },
      ],
    },
    files: [{ batch_id: 'batch', selection_index: 2, blob: new Blob(['abc']) }],
  };
}
const signal = () => new AbortController().signal;
test.each([
  'version',
  'empty',
  'duplicate',
  'missing',
  'length',
  'uid',
  'mode',
  'order',
  'foreign',
  'private',
])('不完整或不允许的共享输入不得被报告为已提交：%s', async kind => {
  const value = bundle() as unknown as {
    manifest: Record<string, unknown> & { files: Record<string, unknown>[] };
    files: Record<string, unknown>[];
  };
  if (kind === 'version') {
    value.manifest.cache_version = 2;
  }
  if (kind === 'empty') {
    value.manifest.files = [];
  }
  if (kind === 'duplicate') {
    value.manifest.files.push({ ...value.manifest.files[0] });
  }
  if (kind === 'missing') {
    value.files = [];
  }
  if (kind === 'length') {
    value.files[0].blob = new Blob(['ab']);
  }
  if (kind === 'uid') {
    value.manifest.files[0].sop_uid = 'invalid';
  }
  if (kind === 'mode') {
    value.manifest.mode_path = 'https://example.com';
  }
  if (kind === 'order') {
    value.manifest.files.push({ ...value.manifest.files[0], selection_index: 0 });
  }
  if (kind === 'foreign') {
    value.files[0].batch_id = 'other';
  }
  if (kind === 'private') {
    value.manifest.token = 'not-permitted';
  }
  await expect(
    new SharedFileStore().publish(value as unknown as SharedFileBundle, signal())
  ).rejects.toMatchObject({
    code: 'cache_invalid',
  });
});
test('浏览器没有IDB时显式不可用，取消不能返回ready', async () => {
  await expect(new SharedFileStore().publish(bundle(), signal())).rejects.toMatchObject({
    code: 'storage_unavailable',
  });
  const controller = new AbortController();
  controller.abort();
  await expect(new SharedFileStore().publish(bundle(), controller.signal)).rejects.toMatchObject({
    code: 'cancelled',
  });
});

/** 仅验证适配器控制流；提交／回滚的浏览器语义另由真实Chrome测试确认。 */
function controlledIDB() {
  const tables = { manifests: new Map(), files: new Map() };
  const controls = {
    addError: null as Error | null,
    asyncAddError: null as Error | null,
    openError: null as Error | null,
    blocked: false,
    openThrow: false,
    transactionThrow: false,
    afterAdd: undefined as (() => void) | undefined,
  };
  const db = {
    close: jest.fn(),
    createObjectStore: jest.fn(),
    transaction: () => {
      if (controls.transactionThrow) {
        throw new Error('transaction');
      }
      const draft = { manifests: new Map(tables.manifests), files: new Map(tables.files) };
      let pending = 0,
        ended = false;
      const tx = {
        onabort: undefined as (() => void) | undefined,
        oncomplete: undefined as (() => void) | undefined,
        onerror: undefined as ((event: { target: { error: Error } }) => void) | undefined,
        error: null as Error | null,
        abort() {
          if (ended) {
            throw new Error('ended');
          }
          ended = true;
          queueMicrotask(() => tx.onabort?.());
        },
        objectStore: (name: 'manifests' | 'files') => ({
          get: key => {
            const request: { result?: unknown; onsuccess?: () => void } = {};
            pending++;
            queueMicrotask(() => {
              if (ended) {
                return;
              }
              request.result = draft[name].get(JSON.stringify(key));
              request.onsuccess?.();
              pending--;
              finish();
            });
            return request;
          },
          add: value => {
            if (controls.addError) {
              throw controls.addError;
            }
            if (controls.asyncAddError) {
              pending++;
              queueMicrotask(() => {
                if (ended) {
                  return;
                }
                tx.onerror?.({ target: { error: controls.asyncAddError! } });
                tx.error = controls.asyncAddError;
                tx.abort();
                pending--;
              });
              return {};
            }
            const key = JSON.stringify(
              name === 'files' ? [value.batch_id, value.selection_index] : value.task_id
            );
            if (draft[name].has(key)) {
              throw new Error('duplicate');
            }
            draft[name].set(key, value);
            controls.afterAdd?.();
            return {};
          },
        }),
      };
      const finish = () =>
        queueMicrotask(() => {
          if (pending || ended) {
            return;
          }
          ended = true;
          tables.manifests = draft.manifests;
          tables.files = draft.files;
          tx.oncomplete?.();
        });
      return tx;
    },
  };
  const factory = {
    open: () => {
      if (controls.openThrow) {
        throw new Error('open');
      }
      const request = {
        result: db,
        error: null as Error | null,
        onblocked: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        onupgradeneeded: undefined as (() => void) | undefined,
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        if (controls.blocked) {
          request.onblocked?.();
          request.onsuccess?.();
          return;
        }
        if (controls.openError) {
          request.error = controls.openError;
          request.onerror?.();
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return {
    tables,
    controls,
    db,
    store: new SharedFileStore({ indexedDB: factory, basePath: '/test/' }),
  };
}
test('受控IDB适配器提交后才返回、同上下文复用且完整读取', async () => {
  const { store, db } = controlledIDB();
  const value = bundle();
  await expect(store.publish(value as unknown as SharedFileBundle, signal())).resolves.toEqual(
    value.manifest
  );
  await expect(store.publish(value as unknown as SharedFileBundle, signal())).resolves.toEqual(
    value.manifest
  );
  await expect(store.read('task', 'batch', 'source', signal())).resolves.toEqual(value);
  await expect(store.read('task', 'other', 'source', signal())).rejects.toMatchObject({
    code: 'context_conflict',
  });
  await expect(
    store.publish(
      { ...value, manifest: { ...value.manifest, source_participant_id: 'other' } },
      signal()
    )
  ).rejects.toMatchObject({ code: 'context_conflict' });
  expect(db.close).toHaveBeenCalledTimes(5);
});
test('缺Blob／未知清单版本拒绝整次读取，受控配额和事务中止不得报告ready', async () => {
  const { store, tables, controls } = controlledIDB();
  await store.publish(bundle(), signal());
  tables.files.clear();
  await expect(store.read('task', 'batch', 'source', signal())).rejects.toMatchObject({
    code: 'cache_invalid',
  });
  tables.manifests.set(JSON.stringify('task'), { ...bundle().manifest, cache_version: 2 });
  await expect(store.read('task', 'batch', 'source', signal())).rejects.toMatchObject({
    code: 'cache_invalid',
  });
  const fresh = controlledIDB();
  fresh.controls.addError = new DOMException('quota', 'QuotaExceededError');
  await expect(fresh.store.publish(bundle(), signal())).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(fresh.tables.manifests.size).toBe(0);
  fresh.controls.addError = null;
  const controller = new AbortController();
  fresh.controls.afterAdd = () => controller.abort();
  await expect(fresh.store.publish(bundle(), controller.signal)).rejects.toMatchObject({
    code: 'cancelled',
  });
  expect(fresh.tables.manifests.size).toBe(0);
  controls.transactionThrow = true;
  await expect(store.read('task', 'batch', 'source', signal())).rejects.toMatchObject({
    code: 'storage_unavailable',
  });
});
test.each(['openThrow', 'openError', 'blocked'])('受控打开故障%s与晚打开资源关闭', async kind => {
  const { store, controls } = controlledIDB();
  if (kind === 'openError') {
    controls.openError = new Error('open');
  } else if (kind === 'blocked') {
    controls.blocked = true;
  } else {
    controls.openThrow = true;
  }
  await expect(store.publish(bundle(), signal())).rejects.toMatchObject({
    code: 'storage_unavailable',
  });
});
test('打开期间取消时晚成功连接仍关闭', async () => {
  const { store, db } = controlledIDB();
  const controller = new AbortController();
  const pending = store.publish(bundle(), controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(db.close).toHaveBeenCalled();
});
test('相同清单字段顺序不同仍幂等', async () => {
  const { store } = controlledIDB();
  const value = bundle();
  await store.publish(value, signal());
  await expect(
    store.publish(
      { ...value, manifest: { files: value.manifest.files, ...value.manifest } },
      signal()
    )
  ).resolves.toEqual(value.manifest);
});
test('异步request配额错误保留分类', async () => {
  const failing = controlledIDB();
  failing.controls.asyncAddError = new DOMException('quota', 'QuotaExceededError');
  await expect(failing.store.publish(bundle(), signal())).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
});

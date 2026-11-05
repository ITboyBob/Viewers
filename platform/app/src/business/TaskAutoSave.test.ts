import { Blob } from 'buffer';
import { webcrypto, randomUUID } from 'crypto';
import { TaskAutoSave } from './TaskAutoSave';
Object.assign(global, { Blob });
Object.defineProperty(global.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
Object.defineProperty(global.crypto, 'randomUUID', { value: randomUUID, configurable: true });
const tick = () => new Promise(r => setTimeout(r, 25));
test('变化自动提交、连续变化合并，成功后清除未确认状态', async () => {
  let callback = () => {};
  const service = {
    EVENTS: { ADDED: 'added' },
    subscribe: (_e: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task', can_edit: true };
  const storage: any = {
    results: jest.fn(async () => ({ revision: 0, objects: [], access: { can_edit: true } })),
    save: jest.fn(async () => ({ revision: 1, objects: [], access: { can_edit: true } })),
  };
  const adapter: any = {
    exportArtifacts: jest
      .fn()
      .mockResolvedValue([{ type: 'SEG', blob: new Blob(['pixels']) }])
      .mockResolvedValueOnce([]),
    setReadOnly: jest.fn(),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 5);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  callback();
  await tick();
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(saver.hasPending).toBe(false);
  saver.stop();
});
test('只读不提交；恢复失败不进入可编辑状态', async () => {
  const project: any = { task_id: 'task' };
  const storage: any = {
    results: async () => ({ revision: 0, objects: [], access: { can_edit: false } }),
    save: jest.fn(),
  };
  const adapter: any = { setReadOnly: jest.fn() };
  const saver = new TaskAutoSave(project, storage, adapter, [], () => true);
  await saver.restore(new AbortController().signal);
  await saver.start();
  expect(project.can_edit).toBe(false);
  expect(storage.save).not.toHaveBeenCalled();
  saver.stop();
});

test('修订冲突暂停，不覆盖，不继续发起写入', async () => {
  let callback = () => {};
  const service: any = {
    EVENTS: { MODIFIED: 'modified' },
    subscribe: (_: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task', can_edit: true };
  const storage: any = {
    results: async () => ({ revision: 0, objects: [], access: { can_edit: true } }),
    save: jest.fn(async () => {
      throw Object.assign(new Error('conflict'), { status: 409 });
    }),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    exportArtifacts: jest
      .fn()
      .mockResolvedValue([{ type: 'SR', blob: new Blob(['data']) }])
      .mockResolvedValueOnce([]),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  await tick();
  await tick();
  expect(project.can_edit).toBe(false);
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('保存冲突');
  callback();
  window.dispatchEvent(new Event('online'));
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(1);
  saver.stop();
});
test('服务端真实空成果用于删除，重开存在成果时不把删除误判为未变化', async () => {
  let callback = () => {};
  const service: any = {
    EVENTS: { REMOVED: 'removed' },
    subscribe: (_: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const blob = new Blob(['old']);
  const project: any = { task_id: 'task' };
  const storage: any = {
    results: async () => ({
      revision: 3,
      objects: [{ object_id: 'id', type: 'SEG' }],
      access: { can_edit: true },
    }),
    readArtifacts: async () => [{ type: 'SEG', blob }],
    save: jest.fn(async () => ({ revision: 4, objects: [], access: { can_edit: true } })),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    importArtifacts: jest.fn(),
    exportArtifacts: jest
      .fn()
      .mockResolvedValue([])
      .mockResolvedValueOnce([{ type: 'SEG', blob }]),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  await tick();
  await tick();
  expect(storage.save.mock.calls[0][1]).toBe(3);
  expect(storage.save.mock.calls[0][2]).toEqual([]);
  expect(saver.hasPending).toBe(false);
  saver.stop();
});
test('非内容事件和已停止实例不保存，断连阻断编辑', async () => {
  const callbacks: Record<string, () => void> = {};
  const service: any = {
    EVENTS: { UPDATED: 'updated', SELECTION: 'selection' },
    subscribe: (e: string, fn: any) => {
      callbacks[e] = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task' };
  const storage: any = {
    results: async () => ({ revision: 0, objects: [], access: { can_edit: true } }),
    save: jest.fn(),
  };
  const saver = new TaskAutoSave(
    project,
    storage,
    { setReadOnly: jest.fn() } as any,
    [service],
    () => true,
    1
  );
  await saver.restore(new AbortController().signal);
  await saver.start();
  expect(callbacks.selection).toBeUndefined();
  window.dispatchEvent(new Event('offline'));
  expect(project.can_edit).toBe(false);
  callbacks.updated();
  await tick();
  expect(storage.save).not.toHaveBeenCalled();
  saver.stop();
  callbacks.updated();
  await tick();
  expect(storage.save).not.toHaveBeenCalled();
});

test('响应失败保留同一操作，重连先查询再补交，不允许离线继续修改', async () => {
  let callback = () => {};
  const service: any = {
    EVENTS: { ADDED: 'added' },
    subscribe: (_: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task' },
    artifacts = [{ type: 'SEG', blob: new Blob(['new']) }];
  const storage: any = {
    results: jest.fn(async () => ({ revision: 0, objects: [], access: { can_edit: true } })),
    save: jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ revision: 1, objects: [], access: { can_edit: true } }),
    forgetPending: jest.fn(),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    exportArtifacts: jest.fn().mockResolvedValue(artifacts).mockResolvedValueOnce([]),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  await tick();
  await tick();
  expect(project.can_edit).toBe(false);
  expect(saver.hasPending).toBe(true);
  const before = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(true);
  window.dispatchEvent(new Event('online'));
  await tick();
  await tick();
  expect(storage.results).toHaveBeenCalledTimes(2);
  expect(storage.save).toHaveBeenCalledTimes(2);
  expect(storage.save.mock.calls[0][3]).toBe(storage.save.mock.calls[1][3]);
  expect(project.can_edit).toBe(true);
  expect(saver.hasPending).toBe(false);
  saver.stop();
  expect(storage.forgetPending).toHaveBeenCalledWith('task');
});
test.each([401, 403, 404, 413, 422])('明确失败 %s 暂停而不无限重试', async status => {
  let callback = () => {};
  const service: any = {
    EVENTS: { ADDED: 'added' },
    subscribe: (_: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task' };
  const storage: any = {
    results: async () => ({ revision: 0, objects: [], access: { can_edit: true } }),
    save: jest.fn(async () => {
      throw Object.assign(new Error('rejected'), { status });
    }),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    exportArtifacts: jest
      .fn()
      .mockResolvedValue([{ type: 'SR', blob: new Blob(['data']) }])
      .mockResolvedValueOnce([]),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  await tick();
  await tick();
  expect(project.can_edit).toBe(false);
  expect(storage.save).toHaveBeenCalledTimes(1);
  saver.stop();
});
test('错误成果清单、已取消和失活恢复不开放编辑', async () => {
  for (const value of [
    { revision: -1, objects: [], access: { can_edit: true } },
    { revision: 0, objects: [], access: {} },
  ]) {
    const project: any = { task_id: 'task' },
      saver = new TaskAutoSave(
        project,
        { results: async () => value } as any,
        { setReadOnly: jest.fn() } as any,
        [],
        () => true
      );
    await expect(saver.restore(new AbortController().signal)).rejects.toThrow();
    expect(project.can_edit).toBe(false);
    saver.stop();
  }
  const controller = new AbortController();
  controller.abort();
  const saver = new TaskAutoSave(
    { task_id: 'task' } as any,
    { results: async () => ({ revision: 0, objects: [], access: { can_edit: true } }) } as any,
    {} as any,
    [],
    () => false
  );
  await expect(saver.restore(controller.signal)).rejects.toThrow();
  await saver.start();
  saver.stop();
});

test('保存失败暂停期间完成的原生操作仍在补交后保存，不遗漏新结果', async () => {
  let callback = () => {};
  const service: any = {
    EVENTS: { UPDATED: 'updated' },
    subscribe: (_: any, fn: any) => {
      callback = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const project: any = { task_id: 'task' };
  let content = 'first';
  let revision = 0;
  const storage: any = {
    results: jest.fn(async () => ({ revision, objects: [], access: { can_edit: true } })),
    save: jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementation(async () => ({
        revision: ++revision,
        objects: [],
        access: { can_edit: true },
      })),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    exportArtifacts: jest
      .fn(async () => [{ type: 'SEG', blob: new Blob([content]) }])
      .mockResolvedValueOnce([]),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  callback();
  await tick();
  await tick();
  expect(project.can_edit).toBe(false);
  // 断连之前已经发起的原生异步操作，可能在编辑暂停之后才完成。
  content = 'finished-background-operation';
  callback();
  const retry = document.querySelector<HTMLButtonElement>('button[aria-label="重试保存"]');
  expect(retry).not.toBeNull();
  retry!.click();
  await tick();
  await tick();
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(3);
  expect(await storage.save.mock.calls[2][2][0].blob.text()).toBe(content);
  expect(storage.save.mock.calls[2][1]).toBe(1);
  expect(saver.hasPending).toBe(false);
  saver.stop();
});

test('重连等待原生操作结束，未改变成果时重新校验权限，不永久停在只读', async () => {
  let busy = false;
  const project: any = { task_id: 'task' };
  const storage: any = {
    results: jest.fn(async () => ({ revision: 0, objects: [], access: { can_edit: true } })),
    save: jest.fn(),
  };
  const adapter: any = {
    setReadOnly: jest.fn(),
    isBusy: () => busy,
    exportArtifacts: jest.fn(async () => []),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [], () => true, 1);
  await saver.restore(new AbortController().signal);
  await saver.start();
  busy = true;
  window.dispatchEvent(new Event('offline'));
  window.dispatchEvent(new Event('online'));
  await tick();
  expect(project.can_edit).toBe(false);
  busy = false;
  await tick();
  await tick();
  expect(storage.results).toHaveBeenCalledTimes(2);
  expect(project.can_edit).toBe(true);
  expect(storage.save).not.toHaveBeenCalled();
  expect(saver.hasPending).toBe(false);
  saver.stop();
});

test('仅新增分割被拒绝不全局只读、不无限重试，移除新增实体后仍能正常保存', async () => {
  let change = () => {};
  const project: any = { task_id: 'task', can_edit: true, can_add_segmentation: false };
  const service: any = {
    EVENTS: { MODIFIED: 'modified' },
    subscribe: (_: any, fn: any) => {
      change = fn;
      return { unsubscribe: jest.fn() };
    },
  };
  const access = { can_edit: true, collaboration_permission: 'view', can_add_segmentation: false };
  const storage: any = {
    results: jest.fn().mockResolvedValue({ revision: 0, objects: [], access }),
    save: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('没有新增分割权限'), {
          status: 403,
          reason: 'SEGMENTATION_CREATE_FORBIDDEN',
        })
      )
      .mockResolvedValue({ revision: 1, objects: [], access }),
  };
  const adapter: any = {
    exportArtifacts: jest.fn().mockResolvedValue([{ type: 'SEG', blob: new Blob(['new']) }]),
    setReadOnly: jest.fn(),
  };
  const saver = new TaskAutoSave(project, storage, adapter, [service], () => true, 5);
  await saver.restore(new AbortController().signal);
  await saver.start();
  adapter.setReadOnly.mockClear();
  adapter.exportArtifacts.mockResolvedValue([{ type: 'SEG', blob: new Blob(['forbidden']) }]);
  change();
  await tick();
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(1);
  expect(project.can_edit).toBe(true);
  expect(adapter.setReadOnly).not.toHaveBeenCalledWith(true);
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(1);
  adapter.exportArtifacts.mockResolvedValue([
    { type: 'SEG', blob: new Blob(['existing updated']) },
  ]);
  change();
  await tick();
  await tick();
  expect(storage.save).toHaveBeenCalledTimes(2);
  expect(saver.hasPending).toBe(false);
  saver.stop();
});

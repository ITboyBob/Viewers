import { randomUUID } from 'crypto';
import { Blob, File } from 'buffer';
Object.assign(global, { Blob, File });
Object.defineProperty(global.crypto, 'randomUUID', { value: randomUUID, configurable: true });
import { BusinessApiClient } from './BusinessApiClient';
import { TaskStorageService } from './TaskStorageService';

test('二进制请求保留凭据、不JSON化，读取不经过JSON解析', async () => {
  const payload = new Blob(['dicom']);
  const transport = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 200, blob: async () => payload });
  const api = new BusinessApiClient({ fetch: transport, getToken: () => 'credential' });
  await expect(api.request('/tasks/id/files/file', { responseType: 'blob' })).resolves.toBe(
    payload
  );
  transport.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: true }) });
  await api.request('/task-imports/id/files/file', { method: 'PUT', binaryBody: payload });
  expect(transport.mock.calls[1][1].body).toBe(payload);
  expect(transport.mock.calls[1][1].headers.Authorization).toBe('Bearer credential');
});

test('暂存只上传成功子集；重试沿用文件身份，完成后才返回任务', async () => {
  const file = new File(['1234'], 'a.dcm');
  const project = {
    team_id: 'team',
    title: 'a.dcm',
    registration_key: 'key',
    kind: 'files',
    mode_path: 'segmentation/dicomlocal',
    successes: [
      {
        selection_index: 0,
        file_name: 'a.dcm',
        study_uid: '1.2',
        series_uid: '1.2.3',
        sop_uid: '1.2.3.4',
      },
    ],
  } as any;
  const request = jest.fn(async (path: string, options: any) => {
    if (path.endsWith('/task-imports')) return { import_id: 'import', uploaded_files: [] };
    if (path.endsWith('/complete')) return { task_id: 'task' };
    return true;
  });
  const projects = { getSelection: () => ({ files: [file] }) } as any;
  const storage = new TaskStorageService({ request }, projects, {} as any);
  await expect(storage.register(project, new AbortController().signal)).resolves.toEqual({
    task_id: 'task',
  });
  const first = request.mock.calls[0][1].body.files[0].file_id;
  await storage.register(project, new AbortController().signal);
  expect(request.mock.calls[3][1].body.files[0].file_id).toBe(first);
  expect(request.mock.calls[1][1].binaryBody).toBe(file);
});

test('后端原图按清单重新建立项目，不登记替代任务', async () => {
  const materials: any = {
    task: { task_id: 'task' },
    source: {
      kind: 'folder',
      folder_name: 'study',
      files: [
        {
          file_id: 'file',
          file_name: 'a.dcm',
          relative_path: 'study/a.dcm',
          selection_index: 1,
          size: 4,
        },
      ],
    },
    access: { can_edit: true },
  };
  const request = jest
    .fn()
    .mockResolvedValueOnce(materials)
    .mockResolvedValueOnce(new Blob(['data']));
  const restoreStored = jest.fn().mockResolvedValue({ task_id: 'task' });
  const service = new TaskStorageService(
    { request },
    { restoreStored } as any,
    { getSnapshot: () => ({ context: { user: { uid: 'b' } } }) } as any
  );
  await expect(service.open('task', new AbortController().signal)).resolves.toEqual({
    task_id: 'task',
  });
  expect(restoreStored.mock.calls[0][1].files[0].name).toBe('a.dcm');
  expect(restoreStored.mock.calls[0][1].files[0].webkitRelativePath).toBe('study/a.dcm');
  expect(request.mock.calls.every(([url]) => !url.includes('complete'))).toBe(true);
});
test.each(['shape', 'size', 'identity', 'missing-adapter'])(
  '原图恢复拒绝错误响应或已变化账号 %s',
  async kind => {
    let uid = 'b';
    const materials: any = {
      task: { task_id: 'task' },
      source: {
        kind: 'files',
        files: [{ file_id: 'f', file_name: 'a', selection_index: 0, size: 4 }],
      },
      access: { can_edit: true },
    };
    if (kind === 'shape') materials.task.task_id = 'other';
    const request = jest.fn(async (path: string) => {
      if (path.endsWith('materials')) return materials;
      if (kind === 'identity') uid = 'c';
      return new Blob([kind === 'size' ? 'x' : 'data']);
    });
    const service = new TaskStorageService(
      { request },
      {} as any,
      { getSnapshot: () => ({ context: { user: { uid } } }) } as any
    );
    await expect(service.open('task', new AbortController().signal)).rejects.toThrow();
  }
);
test('成果按清单读取，拒绝不支持的类型或错误修订', async () => {
  const request = jest.fn().mockResolvedValue(new Blob(['data']));
  const service = new TaskStorageService({ request }, {} as any, {} as any);
  const value: any = { revision: 0, objects: [{ object_id: 'id', type: 'SEG' }] };
  expect((await service.readArtifacts('task', value, new AbortController().signal))[0].type).toBe(
    'SEG'
  );
  await expect(
    service.readArtifacts('task', { ...value, revision: NaN }, new AbortController().signal)
  ).rejects.toThrow();
  await expect(
    service.readArtifacts(
      'task',
      { ...value, objects: [{ object_id: 'id', type: 'unknown' }] },
      new AbortController().signal
    )
  ).rejects.toThrow();
});
test('上传响应丢失时沿用操作和对象ID；不同基础修订不得复用操作', async () => {
  let fail = true;
  const request = jest.fn(async (path: string, options: any) => {
    if (path.includes('result-files') && fail) {
      fail = false;
      throw new Error('network');
    }
    if (path.endsWith('commit'))
      return { revision: 1, objects: options.body.objects, access: { can_edit: true } };
    return true;
  });
  const service = new TaskStorageService({ request }, {} as any, {} as any),
    artifacts: any = [{ type: 'SEG', blob: new Blob(['data']) }],
    signal = new AbortController().signal;
  await expect(service.save('task', 0, artifacts, 'op', signal)).rejects.toThrow();
  const uploaded = request.mock.calls[0][0];
  await expect(service.save('other', 0, artifacts, 'op', signal)).rejects.toThrow();
  const result = await service.save('task', 0, artifacts, 'op', signal);
  expect(result.revision).toBe(1);
  expect(request.mock.calls[1][0]).toBe(uploaded);
  expect(request.mock.calls[2][1].body.base_revision).toBe(0);
  service.forgetPending('task');
  await service.results('task');
  expect(request).toHaveBeenLastCalledWith('/tasks/task/results', { signal: undefined });
});
test('缺失原始文件或错误暂存响应不伪造创建成功', async () => {
  const service = new TaskStorageService(
    { request: jest.fn() } as any,
    { getSelection: () => undefined } as any,
    {} as any
  );
  await expect(service.register({} as any, new AbortController().signal)).rejects.toThrow();
});

import { TaskService } from './TaskService';
import { BusinessApiError } from './BusinessApiClient';
import type { BusinessApi, LocalProject, LocalProjects } from '@ohif/core';
const key = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';
const project = () =>
  ({
    batch_id: 'batch',
    kind: 'files',
    successes: [],
    failures: [],
    study_uids: ['1'],
    importer_uid: 'actor',
    team_id: 'team',
    title: '合成.dcm',
    registration_key: key,
    mode_path: 'segmentation/dicomlocal',
    phase: 'ready',
  }) as LocalProject;
const task = () => ({
  task_id: taskId,
  team_id: 'team',
  title: '合成.dcm',
  assignee_uid: 'actor',
  metadata: {},
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
});
let request: jest.Mock, current: boolean, service: TaskService, p: LocalProject;
beforeEach(() => {
  current = true;
  p = project();
  request = jest.fn().mockResolvedValue(task());
  service = new TaskService(
    { request } as BusinessApi,
    { isCurrent: () => current } as unknown as LocalProjects
  );
});
test('集中请求只传title和同次登记key，后端有效响应才填入真实ID及时间', async () => {
  expect(await service.register(p)).toEqual(task());
  expect(request).toHaveBeenCalledWith(
    '/teams/team/tasks',
    expect.objectContaining({
      method: 'POST',
      body: { title: '合成.dcm' },
      idempotencyKey: key,
      signal: expect.any(AbortSignal),
    })
  );
  expect(p.task_id).toBe(taskId);
  expect(p.phase).toBe('registered');
  expect(await service.register(p)).toEqual(task());
  expect(request).toHaveBeenCalledTimes(1);
});
test('双击返回同一个inflight Promise，pending不能生成临时ID', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const a = service.register(p),
    b = service.register(p);
  expect(a).toBe(b);
  expect(request).toHaveBeenCalledTimes(1);
  expect(p.task_id).toBeUndefined();
  finish(task());
  await a;
});
test.each([
  new BusinessApiError(500, 'INTERNAL_ERROR', '暂不可用'),
  new BusinessApiError(0, 'TIMEOUT', '超时'),
  new BusinessApiError(0, 'NETWORK_ERROR', '丢响应'),
])('失败可以同次重试，不自动重发或换key %#', async error => {
  request.mockRejectedValueOnce(error);
  await expect(service.register(p)).rejects.toBe(error);
  expect(p.phase).toBe('ready');
  await service.register(p);
  expect(request.mock.calls.map(call => call[1].idempotencyKey)).toEqual([key, key]);
});
test.each([
  {},
  { ...task(), task_id: '' },
  { ...task(), team_id: 'forged' },
  { ...task(), assignee_uid: 'other' },
  { ...task(), title: 'changed' },
  { ...task(), metadata: { path: 'private' } },
  { ...task(), metadata: [] },
  { ...task(), created_at: 'bad' },
  { ...task(), updated_at: '2020-01-01T00:00:00Z' },
  { ...task(), status: 'draft' },
])('损坏或错配响应不能激活project %#', async response => {
  request.mockResolvedValue(response);
  await expect(service.register(p)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(p.task_id).toBeUndefined();
  expect(p.phase).toBe('ready');
});
test('身份变化后的晚响应不得填入旧project', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = service.register(p);
  current = false;
  finish(task());
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(p.task_id).toBeUndefined();
});
test('取消后即使底层忽略AbortSignal并晚成功也不得登记为有效', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = service.register(p);
  service.cancel(p);
  service.cancel(p);
  finish(task());
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  expect(p.task_id).toBeUndefined();
});
test.each([401, 403, 404])('身份或团队资格错误%s使项目失效', async status => {
  request.mockRejectedValue(new BusinessApiError(status, 'DENIED', '资格失效'));
  await expect(service.register(p)).rejects.toMatchObject({ status });
  expect(p.phase).toBe('invalid');
});
test('不允许登记失效上下文或错误phase', async () => {
  current = false;
  await expect(service.register(p)).rejects.toMatchObject({ code: 'CANCELLED' });
  current = true;
  p.phase = 'disposed';
  await expect(service.register(p)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(request).not.toHaveBeenCalled();
  service.cancel(p);
});

test('集中API意外同步抛错也必须清除inflight，后续可用同key重试', async () => {
  const error = new BusinessApiError(0, 'NETWORK_ERROR', '同步失败');
  request.mockImplementationOnce(() => {
    throw error;
  });
  await expect(service.register(p)).rejects.toBe(error);
  await expect(service.register(p)).resolves.toEqual(task());
  expect(request).toHaveBeenCalledTimes(2);
});

test('更新时间仅PATCH空对象，返回狭义ID和时间，不上传事件内容或换标题', async () => {
  await service.register(p);
  request.mockClear();
  const signal = new AbortController().signal;
  const timestamp = { task_id: taskId, updated_at: '2026-11-01T00:00:00.001Z' };
  request.mockResolvedValue(timestamp);
  expect(await service.touch(p, signal)).toEqual(timestamp);
  expect(request).toHaveBeenCalledWith(`/teams/team/tasks/${taskId}/updated-at`, {
    method: 'PATCH',
    body: {},
    signal,
  });
  expect(p.title).toBe('合成.dcm');
});
test.each([
  {},
  null,
  [],
  { task_id: 'other', updated_at: '2026-11-01T00:00:01Z' },
  { task_id: taskId, updated_at: 'bad' },
  { task_id: taskId, updated_at: '2026-11-01T00:00:00Z' },
  { task_id: taskId, updated_at: '2026-11-01T00:00:01Z', title: 'changed' },
])('更新时间拒绝错ID、非递增时间或额外字段 %#', async value => {
  await service.register(p);
  request.mockResolvedValue(value);
  await expect(service.touch(p, new AbortController().signal)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});
test('未登记、已失效或已取消不得发出touch', async () => {
  const controller = new AbortController();
  await expect(service.touch(p, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  await service.register(p);
  current = false;
  await expect(service.touch(p, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  current = true;
  controller.abort();
  await expect(service.touch(p, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(request).toHaveBeenCalledTimes(1);
});

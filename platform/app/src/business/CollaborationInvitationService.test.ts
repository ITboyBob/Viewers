import { CollaborationInvitationService } from './CollaborationInvitationService';
const record = {
  invitation_id: 'i',
  task_id: 'task',
  invitee: { uid: 'u', username: 'Bob' },
  permission: 'view',
  decision: 'pending',
  created_at: '2026-11-06T00:00:00Z',
  expires_at: '2026-11-06T00:05:00Z',
};
test('发送真实用户名和权限；不传发起人、收件人 ID 或有效期', async () => {
  const request = jest.fn().mockResolvedValue(record),
    api = new CollaborationInvitationService({ request });
  await api.send('task ?#', ' Bob ', 'view');
  expect(request).toHaveBeenCalledWith('/tasks/task%20%3F%23/collaboration-invitations', {
    method: 'POST',
    body: { username: 'Bob', permission: 'view' },
    signal: undefined,
  });
  await expect(api.send('task', '', 'edit')).rejects.toThrow();
});
test('发送记录保留服务端期限；通知读取全部分页且失败不降级', async () => {
  const request = jest.fn().mockResolvedValue({
    data: [record],
    meta: { page: 1, page_size: 100, total: 1, server_time: record.created_at },
  });
  const api = new CollaborationInvitationService({ request });
  expect(await api.listSent('task')).toEqual({ data: [record], server_time: record.created_at });
  request
    .mockResolvedValueOnce(Array.from({ length: 100 }, () => record))
    .mockResolvedValueOnce([record]);
  expect(await api.listNotifications()).toHaveLength(101);
  request.mockRejectedValueOnce(new Error('网络失败'));
  await expect(api.listNotifications()).rejects.toThrow('网络失败');
});
test('接受与拒绝使用独立协作接口，未读数量和标读响应严格校验', async () => {
  const request = jest.fn().mockResolvedValue({ unread_count: 2 }),
    api = new CollaborationInvitationService({ request });
  request.mockResolvedValueOnce({
    invitation: { ...record, decision: 'accepted' },
    task_id: 'task',
    mode_path: 'segmentation/dicomlocal',
  });
  await api.accept('i ?');
  await api.reject('i ?');
  expect(request.mock.calls[0]).toEqual([
    '/collaboration-invitations/i%20%3F/accept',
    { method: 'POST', signal: undefined },
  ]);
  expect(await api.unreadCount()).toBe(2);
  expect(await api.markRead(['i'])).toBe(2);
  request.mockResolvedValueOnce({ unread_count: -1 });
  await expect(api.unreadCount()).rejects.toThrow();
});

test('多页本人记录需稳定快照；跨页丢失记录不能伪装恢复成功', async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ ...record, invitation_id: `i-${i}` }));
  const request = jest.fn(async (resource: string) => {
    const page = Number(new URL(resource, 'https://unit.test').searchParams.get('page'));
    return {
      data: items.slice((page - 1) * 100, page * 100),
      meta: { page, page_size: 100, total: 101, server_time: record.created_at },
    };
  });
  const api = new CollaborationInvitationService({ request });
  expect((await api.listSent('task')).data).toHaveLength(101);
  expect(request).toHaveBeenCalledTimes(4);
  request.mockImplementation(async () => ({
    data: [],
    meta: { page: 1, page_size: 100, total: 1, server_time: record.created_at },
  }));
  await expect(api.listSent('task')).rejects.toMatchObject({ code: 'INVITATION_LIST_CHANGED' });
});
test.each([
  { data: [], meta: { page: 2, page_size: 100, total: 0, server_time: record.created_at } },
  {
    data: [{ ...record, task_id: 'other' }],
    meta: { page: 1, page_size: 100, total: 1, server_time: record.created_at },
  },
])('本人发送记录不采纳错误分页或其他工作台的记录', async value => {
  const api = new CollaborationInvitationService({ request: jest.fn().mockResolvedValue(value) });
  await expect(api.listSent('task')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
test('接受响应不允许任意模式地址；非法权限不发出真实写入', async () => {
  const request = jest
    .fn()
    .mockResolvedValue({
      task_id: 'task',
      invitation: { ...record, decision: 'accepted' },
      mode_path: 'https://other.invalid',
    });
  const api = new CollaborationInvitationService({ request });
  await expect(api.accept('i')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  request.mockClear();
  await expect(api.send('task', 'Bob', 'admin' as any)).rejects.toMatchObject({ status: 422 });
  expect(request).not.toHaveBeenCalled();
});

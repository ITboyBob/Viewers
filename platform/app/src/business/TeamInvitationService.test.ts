import { TeamInvitationService } from './TeamInvitationService';

const invitation = { invitation_id: 'i', decision: 'pending' };
function setup() {
  const request = jest.fn().mockResolvedValue(invitation);
  return { request, service: new TeamInvitationService({ request }) };
}

test('真实发送仅包含用户名，并编码团队资源标识', async () => {
  const { service, request } = setup();
  expect(await service.send('team ?#', '  Bob  ')).toBe(invitation);
  expect(request).toHaveBeenCalledWith('/teams/team%20%3F%23/invitations', {
    method: 'POST',
    body: { username: 'Bob' },
    signal: undefined,
  });
});

test.each(['', '   '])('空用户名 %p 不发请求', async username => {
  const { service, request } = setup();
  await expect(service.send('t', username)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

test.each(['accepted', 'rejected'] as const)('处理 %s 无业务请求体', async decision => {
  const { service, request } = setup();
  await service.decide('id ?#', decision);
  expect(request).toHaveBeenCalledWith(
    `/invitations/id%20%3F%23/${decision === 'accepted' ? 'accept' : 'reject'}`,
    { method: 'POST', signal: undefined }
  );
});

test.each(['members', 'notifications'])('%s 拉取全部分页，不把首页当作全集', async kind => {
  const { service, request } = setup();
  const first = Array.from({ length: 100 }, (_, i) => ({ uid: String(i) }));
  request.mockResolvedValueOnce(first).mockResolvedValueOnce([{ uid: 'last' }]);
  const abort = new AbortController();
  const result =
    kind === 'members'
      ? await service.listMembers('t', abort.signal)
      : await service.listNotifications(abort.signal);
  expect(result).toHaveLength(101);
  const resource = kind === 'members' ? '/teams/t/members' : '/notifications/team-invitations';
  expect(request.mock.calls).toEqual([
    [`${resource}?page=1&page_size=100`, { signal: abort.signal }],
    [`${resource}?page=2&page_size=100`, { signal: abort.signal }],
  ]);
});

test('列表失败和格式错误向上传递，不降级为空列表或 mock', async () => {
  const { service, request } = setup();
  request.mockRejectedValueOnce(new Error('无法连接'));
  await expect(service.listMembers('t')).rejects.toThrow('无法连接');
  request.mockResolvedValueOnce({ items: [] });
  await expect(service.listNotifications()).rejects.toThrow();
});

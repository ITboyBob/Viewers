import { TeamPageService } from './TeamPageService';
import { BusinessApiError } from './BusinessApiClient';

const team = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const otherTask = '20000000-0000-4000-8000-000000000002';
const uid = '30000000-0000-4000-8000-000000000001';
const card = () => ({
  task_id: task,
  team_id: team,
  title: '肝脏轮廓标注',
  subtitle: '示例文件',
  preview_key: 'abdominal-ct',
});
const list = () => ({ items: [card()], total: 1, mock: true });
const recent = () => ({
  ...list(),
  items: [{ ...card(), last_entered_at: '2026-11-01T08:00:00Z' }],
});
const members = () => ({
  task_id: task,
  owner_uid: uid,
  members: [{ uid, username: '真实创建者' }],
  mock: false,
});
const setup = (value: unknown) => {
  const request = jest.fn().mockResolvedValue(value);
  return { request, service: new TeamPageService({ request }) };
};

test('三个 GET 沿集中客户端请求，透传取消且不发送用户参数或写入', async () => {
  const { request, service } = setup(list());
  const signal = new AbortController().signal;
  await expect(service.listTeamTasks(team, signal)).resolves.toEqual(list());
  expect(request).toHaveBeenLastCalledWith(`/teams/${team}/tasks`, { signal });
  request.mockResolvedValue(recent());
  await expect(service.listRecentTasks(signal)).resolves.toEqual(recent());
  expect(request).toHaveBeenLastCalledWith('/tasks/recent', { signal });
  request.mockResolvedValue(members());
  await expect(service.listTaskMembers(task, signal)).resolves.toEqual(members());
  expect(request).toHaveBeenLastCalledWith(`/tasks/${task}/members`, { signal });
  expect(request.mock.calls.every(([, options]) => !options.body && !options.method)).toBe(true);
});

test('路径 ID 编码，不把原始路径片段拼接进请求', async () => {
  const { request, service } = setup(null);
  await expect(service.listTeamTasks('a/b ?')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(request.mock.calls[0][0]).toBe('/teams/a%2Fb%20%3F/tasks');
  await expect(service.listTaskMembers('a/b ?')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  expect(request.mock.calls[1][0]).toBe('/tasks/a%2Fb%20%3F/members');
});

test.each([
  null,
  [],
  {},
  { ...list(), mock: false },
  { ...list(), mock: undefined },
  { ...list(), total: 2 },
  { ...list(), total: -1 },
  { ...list(), total: 1.5 },
  { ...list(), items: {} },
  { items: [card(), card()], total: 2, mock: true },
  ...['task_id', 'team_id', 'title', 'subtitle', 'preview_key'].map(key => ({
    ...list(),
    items: [{ ...card(), [key]: '' }],
  })),
  { ...list(), items: [{ ...card(), preview_key: 'https://private.invalid/image' }] },
  { ...list(), items: [{ ...card(), team_id: otherTask }] },
])('拒绝不符合列表契约的响应 %#', async value => {
  const { service } = setup(value);
  await expect(service.listTeamTasks(team)).rejects.toMatchObject({
    status: 502,
    code: 'INVALID_RESPONSE',
  });
});

test('空列表与 none 预览合法，最近任务允许非入队团队', async () => {
  const { request, service } = setup({ items: [], total: 0, mock: true });
  await expect(service.listTeamTasks(team)).resolves.toEqual({ items: [], total: 0, mock: true });
  const value = recent();
  value.items[0].team_id = otherTask;
  value.items[0].preview_key = 'none';
  request.mockResolvedValue(value);
  await expect(service.listRecentTasks()).resolves.toEqual(value);
});

test.each([
  list(),
  { ...recent(), items: [{ ...recent().items[0], last_entered_at: 'invalid' }] },
  { ...recent(), items: [{ ...recent().items[0], last_entered_at: '2026-11-01T08:00:00+08:00' }] },
  {
    items: [
      { ...recent().items[0], last_entered_at: '2026-11-01T08:00:00Z' },
      { ...recent().items[0], task_id: otherTask, last_entered_at: '2026-11-02T08:00:00Z' },
    ],
    total: 2,
    mock: true,
  },
  {
    items: [{ ...recent().items[0], task_id: otherTask }, recent().items[0]],
    total: 2,
    mock: true,
  },
])('最近任务拒绝缺失时间、非 UTC 与不稳定排序 %#', async value => {
  await expect(setup(value).service.listRecentTasks()).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

test.each([
  null,
  {},
  { ...members(), mock: true },
  { ...members(), task_id: otherTask },
  { ...members(), owner_uid: otherTask },
  { ...members(), members: [] },
  { ...members(), members: [members().members[0], members().members[0]] },
  { ...members(), members: [{ uid: '', username: '示例用户甲' }] },
  { ...members(), members: [{ uid, username: ' ' }] },
])('名单必须绑定目标且唯一 Owner 在唯一成员中 %#', async value => {
  await expect(setup(value).service.listTaskMembers(task)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

test.each(['CANCELLED', 'NETWORK_ERROR', 'UNAUTHORIZED'])(
  '原客户端错误 %s 不被伪装为空列表',
  async code => {
    const error = new BusinessApiError(code === 'UNAUTHORIZED' ? 401 : 0, code, '读取失败');
    const request = jest.fn().mockRejectedValue(error);
    const service = new TeamPageService({ request });
    await expect(service.listRecentTasks()).rejects.toBe(error);
    await expect(service.listTaskMembers(task)).rejects.toBe(error);
  }
);

test('ISO UTC 保留微秒／纳秒精度，毫秒内真实时间优先于任务 id', async () => {
  const items = [
    { ...recent().items[0], task_id: otherTask, last_entered_at: '2026-11-01T08:00:00.123456789Z' },
    { ...recent().items[0], last_entered_at: '2026-11-01T08:00:00.123456788Z' },
  ];
  const value = { items, total: 2, mock: true };
  await expect(setup(value).service.listRecentTasks()).resolves.toEqual(value);
  await expect(
    setup({ ...value, items: [...items].reverse() }).service.listRecentTasks()
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('小数末尾零表示同一时刻时按任务 id 排序，仍拒绝无效日历日期', async () => {
  const value = {
    items: [
      { ...recent().items[0], last_entered_at: '2026-11-01T08:00:00.1Z' },
      {
        ...recent().items[0],
        task_id: otherTask,
        last_entered_at: '2026-11-01T08:00:00.100000000Z',
      },
    ],
    total: 2,
    mock: true,
  };
  await expect(setup(value).service.listRecentTasks()).resolves.toEqual(value);
  await expect(
    setup({
      ...recent(),
      items: [{ ...recent().items[0], last_entered_at: '2026-02-30T08:00:00Z' }],
    }).service.listRecentTasks()
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

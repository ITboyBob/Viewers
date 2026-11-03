import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BusinessServices, BusinessSessionSnapshot, TeamTaskList } from '@ohif/core';
import TeamPageContainer from './TeamPageContainer';
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });
const h = React.createElement;
const team = '10000000-0000-4000-8000-000000000001';
const uid = '30000000-0000-4000-8000-000000000001';
const data = (title = '团队任务甲', teamId = team): TeamTaskList => ({
  items: [
    {
      task_id: '20000000-0000-4000-8000-000000000001',
      team_id: teamId,
      title,
      assignee_uid: '30000000-0000-4000-8000-000000000001',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    },
  ],
  total: 1,
  mock: false,
});
function setup() {
  let value: BusinessSessionSnapshot = {
    status: 'authenticated',
    currentTeamId: '10000000-0000-4000-8000-000000000002',
    error: null,
    context: {
      user: { uid, username: '林医生', avatar_url: null },
      default_team_id: team,
      expires_at: '2027-01-01T00:00:00Z',
      memberships: [
        {
          team_id: '10000000-0000-4000-8000-000000000002',
          owner_uid: '30000000-0000-4000-8000-000000000003',
          name: '已加入团队',
          role: 'annotator',
        },
        { team_id: team, owner_uid: uid, name: '林医生的团队', role: 'owner' },
      ],
    },
  };
  const listeners = new Set<() => void>();
  const api = {
    listTeamTasks: jest.fn().mockResolvedValue(data()),
    listRecentTasks: jest.fn().mockResolvedValue({
      ...data('非入队最近任务', '10000000-0000-4000-8000-000000000003'),
      items: [
        {
          ...data('非入队最近任务', '10000000-0000-4000-8000-000000000003').items[0],
          last_entered_at: '2026-11-01T00:00:00Z',
        },
      ],
    }),
    listTaskMembers: jest.fn(),
  };
  const services = {
    teamPage: api,
    session: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as BusinessServices;
  return {
    services,
    api,
    get snapshot() {
      return value;
    },
    update(next: BusinessSessionSnapshot) {
      act(() => {
        value = next;
        listeners.forEach(listener => listener());
      });
    },
  };
}
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(cleanup);

test('团队标题与查询采用已验证的当前团队，而不是默认自有团队', async () => {
  const state = setup();
  render(h(TeamPageContainer, { view: 'team', services: state.services, onViewChange: jest.fn() }));
  expect(await screen.findByText('团队任务甲')).toBeTruthy();
  expect(state.api.listTeamTasks).toHaveBeenCalledWith(
    state.snapshot.currentTeamId,
    expect.any(AbortSignal)
  );
  expect(screen.getByRole('heading', { name: '已加入团队' })).toBeTruthy();
  expect(state.api.listRecentTasks).not.toHaveBeenCalled();
});

test('最近任务单独读取，不按默认团队过滤', async () => {
  const state = setup();
  render(
    h(TeamPageContainer, { view: 'recent', services: state.services, onViewChange: jest.fn() })
  );
  expect(await screen.findByText('非入队最近任务')).toBeTruthy();
  expect(state.api.listRecentTasks).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(state.api.listTeamTasks).not.toHaveBeenCalled();
});

test('刷新与重挂载重新 GET，不复用私有全局列表', async () => {
  const state = setup();
  const props = { view: 'team' as const, services: state.services, onViewChange: jest.fn() };
  const mounted = render(h(TeamPageContainer, props));
  await screen.findByText('团队任务甲');
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
  await waitFor(() => expect(state.api.listTeamTasks).toHaveBeenCalledTimes(2));
  await screen.findByText('团队任务甲');
  mounted.unmount();
  render(h(TeamPageContainer, props));
  await screen.findByText('团队任务甲');
  expect(state.api.listTeamTasks).toHaveBeenCalledTimes(3);
});

test('切换看板取消旧请求，即使旧客户端忽略取消，迟到数据也不得覆盖', async () => {
  const state = setup();
  const old = pending<TeamTaskList>();
  state.api.listTeamTasks.mockReturnValue(old.promise);
  const props = { view: 'team' as const, services: state.services, onViewChange: jest.fn() };
  const { rerender } = render(h(TeamPageContainer, props));
  const signal = state.api.listTeamTasks.mock.calls[0][1] as AbortSignal;
  rerender(h(TeamPageContainer, { ...props, view: 'recent' }));
  expect(signal.aborted).toBe(true);
  await screen.findByText('非入队最近任务');
  await act(async () => old.resolve(data('过期旧任务')));
  expect(screen.queryByText('过期旧任务')).toBeNull();
});

test('换账号即时隐藏旧列表并隔离迟到响应；身份失效不得再读', async () => {
  const state = setup();
  const old = pending<TeamTaskList>();
  state.api.listTeamTasks
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(data('新用户任务', '10000000-0000-4000-8000-000000000004'));
  render(h(TeamPageContainer, { view: 'team', services: state.services, onViewChange: jest.fn() }));
  const signal = state.api.listTeamTasks.mock.calls[0][1] as AbortSignal;
  state.update({
    ...state.snapshot,
    currentTeamId: '10000000-0000-4000-8000-000000000004',
    context: {
      ...state.snapshot.context!,
      user: { uid: '30000000-0000-4000-8000-000000000002', username: '新用户', avatar_url: null },
      default_team_id: '10000000-0000-4000-8000-000000000004',
      memberships: [
        {
          team_id: '10000000-0000-4000-8000-000000000004',
          owner_uid: '30000000-0000-4000-8000-000000000002',
          name: '新用户团队',
          role: 'owner',
        },
      ],
    },
  });
  expect(signal.aborted).toBe(true);
  expect(await screen.findByText('新用户任务')).toBeTruthy();
  await act(async () => old.resolve(data('旧用户任务')));
  expect(screen.queryByText('旧用户任务')).toBeNull();
  state.update({ status: 'invalid', context: null, currentTeamId: null, error: null });
  expect(screen.queryByText('新用户任务')).toBeNull();
  expect(state.api.listTeamTasks).toHaveBeenCalledTimes(2);
});

test('卸载取消读取且不接收迟到成功', async () => {
  const state = setup();
  const old = pending<TeamTaskList>();
  state.api.listTeamTasks.mockReturnValue(old.promise);
  const { unmount } = render(
    h(TeamPageContainer, { view: 'team', services: state.services, onViewChange: jest.fn() })
  );
  const signal = state.api.listTeamTasks.mock.calls[0][1] as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(data()));
});

test('读取失败保留错误并可重试，不变成成功空列表', async () => {
  const state = setup();
  state.api.listTeamTasks.mockRejectedValueOnce(new Error('服务读取失败'));
  render(h(TeamPageContainer, { view: 'team', services: state.services, onViewChange: jest.fn() }));
  expect((await screen.findByRole('alert')).textContent).toContain('服务读取失败');
  expect(screen.queryByText('暂无任务')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('团队任务甲')).toBeTruthy();
  expect(state.api.listTeamTasks).toHaveBeenCalledTimes(2);
});

test('未验证、无成员资格的当前团队与未装配服务均拒绝读取', async () => {
  const state = setup();
  state.update({ ...state.snapshot, status: 'loading' });
  const props = { view: 'team' as const, services: state.services, onViewChange: jest.fn() };
  const { rerender } = render(h(TeamPageContainer, props));
  expect(state.api.listTeamTasks).not.toHaveBeenCalled();
  state.update({
    ...state.snapshot,
    status: 'authenticated',
    currentTeamId: 'unknown',
    context: {
      ...state.snapshot.context!,
      default_team_id: '10000000-0000-4000-8000-000000000002',
    },
  });
  expect(screen.getByRole('alert').textContent).toContain('当前页面的团队');
  expect(state.api.listTeamTasks).not.toHaveBeenCalled();
  state.update({
    ...state.snapshot,
    currentTeamId: team,
    context: { ...state.snapshot.context!, default_team_id: team },
  });
  await screen.findByText('团队任务甲');
  rerender(
    h(TeamPageContainer, { ...props, services: { ...state.services, teamPage: undefined } })
  );
  expect(screen.getByRole('alert').textContent).toContain('读取服务');
  expect(screen.queryByText('团队任务甲')).toBeNull();
});

test('已显示的旧账号列表在换号首帧即消失，不等新请求结束', async () => {
  const state = setup();
  const next = pending<TeamTaskList>();
  state.api.listTeamTasks
    .mockResolvedValueOnce(data('旧账号已显示任务'))
    .mockReturnValueOnce(next.promise);
  render(h(TeamPageContainer, { view: 'team', services: state.services, onViewChange: jest.fn() }));
  await screen.findByText('旧账号已显示任务');
  state.update({
    ...state.snapshot,
    currentTeamId: '10000000-0000-4000-8000-000000000004',
    context: {
      ...state.snapshot.context!,
      user: { uid: '30000000-0000-4000-8000-000000000002', username: '新用户', avatar_url: null },
      default_team_id: '10000000-0000-4000-8000-000000000004',
      memberships: [
        {
          team_id: '10000000-0000-4000-8000-000000000004',
          owner_uid: '30000000-0000-4000-8000-000000000002',
          name: '新用户团队',
          role: 'owner',
        },
      ],
    },
  });
  expect(screen.queryByText('旧账号已显示任务')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('加载');
  await act(async () => next.resolve(data('新账号任务', '10000000-0000-4000-8000-000000000004')));
  expect(await screen.findByText('新账号任务')).toBeTruthy();
});

test('非 Error 失败仍展示错误而不是成功空列表', async () => {
  const state = setup();
  state.api.listRecentTasks.mockRejectedValueOnce(null);
  render(
    h(TeamPageContainer, { view: 'recent', services: state.services, onViewChange: jest.fn() })
  );
  expect((await screen.findByRole('alert')).textContent).toContain('任务读取失败');
  expect(screen.queryByLabelText('任务数量')).toBeNull();
});

test('取消后迟到失败不能覆盖新看板的成功状态', async () => {
  const state = setup();
  let reject!: (error: Error) => void;
  state.api.listTeamTasks.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    })
  );
  const props = { view: 'team' as const, services: state.services, onViewChange: jest.fn() };
  const { rerender } = render(h(TeamPageContainer, props));
  rerender(h(TeamPageContainer, { ...props, view: 'recent' }));
  await screen.findByText('非入队最近任务');
  await act(async () => reject(new Error('旧请求失败')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('非入队最近任务')).toBeTruthy();
});

test('当前团队改变即时隐藏旧集合但不重挂载创建入口，取消迟到列表', async () => {
  const state = setup();
  const next = pending<TeamTaskList>();
  state.api.listTeamTasks
    .mockResolvedValueOnce(data('之前的任务'))
    .mockReturnValueOnce(next.promise);
  let mounts = 0;
  function CreateSlot() {
    React.useEffect(() => {
      mounts++;
    }, []);
    return h('button', null, '创建新任务');
  }
  render(
    h(TeamPageContainer, {
      view: 'team',
      services: state.services,
      onViewChange: jest.fn(),
      createTaskSlot: h(CreateSlot),
    })
  );
  await screen.findByText('之前的任务');
  state.update({ ...state.snapshot, currentTeamId: team });
  expect(screen.queryByText('之前的任务')).toBeNull();
  expect(screen.getByRole('heading', { name: '林医生的团队' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '创建新任务' })).toBeTruthy();
  expect(mounts).toBe(1);
  await act(async () => next.resolve(data('新的任务')));
  expect(await screen.findByText('新的任务')).toBeTruthy();
});

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';
import { createBusinessServices } from '../../business/createBusinessServices';
import BusinessAuthGate from '../../business/BusinessAuthGate';
import TeamPageRoute from './TeamPageRoute';
let mockServices: BusinessServices | undefined;
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => ({ servicesManager: { services: { businessServices: mockServices } } }),
  }),
  { virtual: true }
);
const h = React.createElement;
const team = '10000000-0000-4000-8000-000000000001',
  task = '20000000-0000-4000-8000-000000000001',
  uid = '30000000-0000-4000-8000-000000000001';
const context = {
  user: { uid, username: '团队页用户', avatar_url: null },
  default_team_id: team,
  expires_at: '2099-01-01T00:00:00Z',
  memberships: [{ team_id: team, owner_uid: uid, role: 'owner', name: '团队页用户的团队' }],
};
const card = {
  task_id: task,
  team_id: team,
  title: '后端演示任务',
  assignee_uid: '30000000-0000-4000-8000-000000000001',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
};
let transport: jest.Mock;
function Location() {
  const value = useLocation();
  return h('p', { 'data-testid': 'route' }, value.pathname);
}
function mount(path = '/team/tasks', protect = true) {
  return render(
    h(
      MemoryRouter,
      { basename: '/viewer-base', initialEntries: ['/viewer-base' + path] },
      h(Location),
      h(
        Routes,
        null,
        ...(['team', 'recent'] as const).map(view =>
          h(Route, {
            key: view,
            path: view === 'team' ? '/team/tasks' : '/team/recent',
            element: protect
              ? h(BusinessAuthGate, { enabled: true }, h(TeamPageRoute, { view }))
              : h(TeamPageRoute, { view }),
          })
        ),
        h(Route, { path: '/account/login', element: h('p', null, '登录目标') })
      )
    )
  );
}
beforeEach(async () => {
  transport = jest.fn(async (path: string) => {
    let data: unknown = path.endsWith('/auth/sessions')
      ? { ...context, token: 'synthetic-token' }
      : path.endsWith('/auth/sessions/current')
        ? context
        : path.endsWith('/tasks/recent')
          ? {
              items: [
                {
                  ...card,
                  team_id: '10000000-0000-4000-8000-000000000002',
                  title: '非入队演示任务',
                  last_entered_at: '2026-11-01T00:00:00Z',
                },
              ],
              total: 1,
              mock: false,
            }
          : { items: [card], total: 1, mock: false };
    return { ok: true, status: 200, json: async () => ({ data }) } as Response;
  });
  mockServices = createBusinessServices({ enabled: true }, { fetch: transport, storage: null });
  await mockServices.session.login({ username: '团队页用户', password: 'synthetic' });
  transport.mockClear();
});
afterEach(cleanup);

test('真实服务工厂读取 HTTP mock，路由切换保留 basename 且不写任务', async () => {
  mount();
  expect(await screen.findByText('后端演示任务')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '最近任务', exact: true }));
  expect(await screen.findByText('非入队演示任务')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/team/recent');
  expect(transport.mock.calls.map(([path]) => path)).toContain('/api/v1/tasks/recent');
  expect(transport.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});

test('团队页个人入口传真实默认自有团队，通知不接协作 mock store', async () => {
  const forUser = jest.spyOn(mockServices!.collaborationMock!, 'forUser');
  mount();
  await screen.findByText('后端演示任务');
  fireEvent.click(screen.getByRole('button', { name: '我的', exact: true }));
  fireEvent.click(screen.getByRole('menuitem', { name: '查看我的团队' }));
  expect(
    screen.getByRole('menuitemradio', { name: /团队页用户的团队/ }).getAttribute('aria-checked')
  ).toBe('true');
  expect(screen.getByRole('menuitem', { name: '退出登录' }).getAttribute('aria-disabled')).toBe(
    'false'
  );
  expect(forUser).not.toHaveBeenCalled();
});

test('匿名直达团队路由被真实会话门禁拒绝，不发列表请求', async () => {
  mockServices = createBusinessServices({ enabled: true }, { fetch: transport, storage: null });
  mount('/team/recent');
  expect(await screen.findByText('登录目标')).toBeTruthy();
  expect(transport).not.toHaveBeenCalled();
});

test('服务缺失明确失败，不以硬编码集合代替', () => {
  mockServices = undefined;
  mount('/team/tasks', false);
  expect(screen.getByRole('alert').textContent).toContain('业务服务');
  expect(screen.queryByText('后端演示任务')).toBeNull();
});

test.each(['/team/tasks', '/team/recent'])(
  '两页仅个人入口使用我的、创建入口可用：%s',
  async path => {
    mount(path);
    expect(await screen.findByRole('button', { name: '我的', exact: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '成员', exact: true })).toBeNull();
    expect((screen.getByRole('button', { name: '创建新任务' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  }
);

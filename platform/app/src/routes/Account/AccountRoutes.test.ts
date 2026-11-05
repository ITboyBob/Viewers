import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Login from './Login';
import Register from './Register';
import InviteRoute from './InviteRoute';
import BusinessAuthGate from '../../business/BusinessAuthGate';
import { createBusinessServices } from '../../business/createBusinessServices';
import PrivateRoute from '../PrivateRoute';

let mockServices,
  mockOidc = { enabled: false, user: null };
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => ({ servicesManager: { services: { businessServices: mockServices } } }),
  }),
  { virtual: true }
);
jest.mock('@ohif/ui-next', () => ({ useUserAuthentication: () => [mockOidc] }), { virtual: true });
const h = React.createElement;
const context = {
  user: { uid: 'u', username: 'user', avatar_url: null },
  expires_at: '2026-11-02T00:00:00Z',
  default_team_id: 't',
  memberships: [{ team_id: 't', name: '团队', owner_uid: 'u', role: 'owner' }],
};
const ok = () =>
  ({
    ok: true,
    status: 201,
    json: async () => ({ data: { ...context, token: 'token' } }),
  }) as Response;
const fill = () => {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'user' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
};
function Location() {
  return h('div', { 'data-testid': 'route' }, useLocation().pathname + useLocation().search);
}
function mount(path: string, basename = '/') {
  return render(
    h(
      MemoryRouter,
      { basename, initialEntries: [basename === '/' ? path : basename + path] },
      h(Location),
      h(
        Routes,
        null,
        h(Route, { path: '/account/login', element: h(Login) }),
        h(Route, { path: '/account/register', element: h(Register) }),
        h(Route, {
          path: '/account/invite',
          element: h(BusinessAuthGate, { enabled: true }, h(InviteRoute)),
        }),
        h(Route, { path: '/team/tasks', element: h('p', null, '团队目标') }),
        h(Route, {
          path: '/local-shared',
          element: h(BusinessAuthGate, { enabled: true }, h('p', null, '共享目标')),
        })
      )
    )
  );
}
beforeEach(() => {
  sessionStorage.clear();
  mockServices = createBusinessServices(
    { enabled: true },
    {
      fetch: jest
        .fn()
        .mockImplementation(async path =>
          String(path).includes('/members?')
            ? { ok: true, status: 200, json: async () => ({ data: [] }) }
            : ok()
        ),
      storage: sessionStorage,
    }
  );
});
afterEach(() => {
  cleanup();
  mockOidc = { enabled: false, user: null };
});

test.each([
  ['/account/login', '登录'],
  ['/account/register', '下一步'],
])('非空校验、密码类型及%s提交状态', async (path, label) => {
  mount(path);
  const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.dataset.state).toBe('disabled');
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'user' } });
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
  expect(button.disabled).toBe(false);
  expect(button.dataset.state).toBe('ready');
  expect(screen.getByLabelText('密码').getAttribute('type')).toBe('password');
});

test('原注册入口可达，注册成功到受保护真实邀请页，不伪造发送成功', async () => {
  mount('/account/login');
  fireEvent.click(screen.getByRole('link', { name: '注册' }));
  await screen.findByRole('heading', { name: '注册' });
  fill();
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(await screen.findByRole('heading', { name: '是否还有其他人加入你？' })).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/account/invite');
  expect(screen.getByRole('button', { name: '邀请' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '跳过' })).toBeTruthy();
  expect(screen.queryByText(/已加入/)).toBeNull();
});

test('成功登录固定去团队任务，basename内相对导航，不接受任意returnUrl', async () => {
  mount('/account/login?returnUrl=https://outside.test', '/viewer-base');
  fill();
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('团队目标')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/team/tasks');
});

test('提交中拒绝双击，失败留页，统一错误不泄露账号是否存在', async () => {
  let done: (response: Response) => void;
  const transport = jest.fn(
    () =>
      new Promise<Response>(resolve => {
        done = resolve;
      })
  );
  mockServices = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  mount('/account/login');
  fill();
  const button = screen.getByRole('button', { name: '登录' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(transport).toHaveBeenCalledTimes(1);
  done!({
    ok: false,
    status: 401,
    json: async () => ({ error: { code: 'UNAUTHORIZED', message: '认证失败' } }),
  } as Response);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/account/login');
  expect(screen.queryByText(/账号不存在|账号未创建/)).toBeNull();
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(false)
  );
});

test('网络错误允许用户重试，缺失容器不伪造登录', async () => {
  const transport = jest
    .fn()
    .mockRejectedValueOnce(new TypeError('network'))
    .mockResolvedValueOnce(ok());
  mockServices = createBusinessServices(
    { enabled: true },
    { fetch: transport, storage: sessionStorage }
  );
  mount('/account/login');
  fill();
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('团队目标')).toBeTruthy();
  cleanup();
  mockServices = undefined;
  mount('/account/login');
  expect(screen.getByRole('alert')).toBeTruthy();
  fill();
  expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(true);
});

test('原OIDC PrivateRoute职责保持独立，业务开关不能绕过OIDC', () => {
  const reject = jest.fn(() => h('p', null, 'OIDC需要登录'));
  mockOidc = { enabled: true, user: null };
  render(h(PrivateRoute, { handleUnauthenticated: reject }, h('p', null, '原模式')));
  expect(screen.getByText('OIDC需要登录')).toBeTruthy();
  expect(reject).toHaveBeenCalled();
  cleanup();
  mockOidc = { enabled: false, user: null };
  render(h(PrivateRoute, { handleUnauthenticated: reject }, h('p', null, '原模式')));
  expect(screen.getByText('原模式')).toBeTruthy();
});

const sharedTask = '12345678-1234-1234-1234-123456789abc';
const sharedQuery = `?shared_task_id=${sharedTask}`;
const sharedTarget = `/local-shared?task_id=${sharedTask}`;

test('未登录共享入口只保留合法任务意图，登录后在basename内回到共享页', async () => {
  mount(sharedTarget, '/viewer-base');
  await screen.findByRole('heading', { name: '登录' });
  expect(screen.getByTestId('route').textContent).toBe(`/account/login${sharedQuery}`);
  fill();
  fireEvent.click(screen.getByRole('button', { name: '登录', exact: true }));
  expect(await screen.findByText('共享目标')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe(sharedTarget);
});

test('共享登录与注册互切保留任务，注册后直接进入共享，不走入队邀请', async () => {
  mount(`/account/login${sharedQuery}`, '/viewer-base');
  fireEvent.click(screen.getByRole('link', { name: '注册' }));
  await screen.findByRole('heading', { name: '注册' });
  expect(screen.getByTestId('route').textContent).toBe(`/account/register${sharedQuery}`);
  expect(screen.queryByText('创建账号，下一步邀请团队成员')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: '登录' }));
  await screen.findByRole('heading', { name: '登录' });
  expect(screen.getByTestId('route').textContent).toBe(`/account/login${sharedQuery}`);
  fireEvent.click(screen.getByRole('link', { name: '注册' }));
  fill();
  fireEvent.click(screen.getByRole('button', { name: '注册并进入共享' }));
  expect(await screen.findByText('共享目标')).toBeTruthy();
  expect(screen.queryByText('是否还有其他人加入你？')).toBeNull();
});

test('直接打开或刷新后的共享注册URL仍可恢复任务目标', async () => {
  mount(`/account/register${sharedQuery}`);
  fill();
  fireEvent.click(screen.getByRole('button', { name: '注册并进入共享' }));
  expect(await screen.findByText('共享目标')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe(sharedTarget);
});

test.each([
  '?shared_task_id=https://outside.test',
  `?shared_task_id=${sharedTask}&shared_task_id=${sharedTask}`,
  `?shared_task_id=${sharedTask}&returnUrl=https://outside.test`,
  `${sharedQuery}#token=forbidden`,
])('非法分享意图不形成回跳且不传给注册入口：%s', async query => {
  mount(`/account/login${query}`);
  expect(screen.getByRole('link', { name: '注册' }).getAttribute('href')).toBe('/account/register');
  fill();
  fireEvent.click(screen.getByRole('button', { name: '登录', exact: true }));
  expect(await screen.findByText('团队目标')).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/team/tasks');
});

test.each([
  '/local-shared?task_id=invalid',
  `/local-shared?task_id=${sharedTask}&token=forbidden`,
  `/local-shared?task_id=${sharedTask}#outside`,
])('非法共享入口不会把原始参数转发给登录页：%s', async path => {
  mount(path);
  await screen.findByRole('heading', { name: '登录' });
  expect(screen.getByTestId('route').textContent).toBe('/account/login');
});

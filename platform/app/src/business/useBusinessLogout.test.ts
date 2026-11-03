import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';
import useBusinessLogout from './useBusinessLogout';
const h = React.createElement;
function Harness({ services }: { services: BusinessServices }) {
  const logout = useBusinessLogout(services),
    location = useLocation(),
    navigate = useNavigate();
  return h(
    'div',
    null,
    h('button', { disabled: !logout, onClick: logout }, '退出'),
    h('button', { onClick: () => navigate('/team/tasks') }, '新登录'),
    h('p', { 'data-testid': 'path' }, location.pathname),
    location.state?.logoutWarning && h('p', { role: 'alert' }, location.state.logoutWarning)
  );
}
afterEach(cleanup);
test('缺少注销能力的预览不提供假注销行为', () => {
  render(h(MemoryRouter, null, h(Harness, { services: { session: {} } as BusinessServices })));
  expect((screen.getByText('退出') as HTMLButtonElement).disabled).toBe(true);
});
test.each([false, true])('本地立即返回登录，失败晚响应不覆盖新登录=%s', async loggedInAgain => {
  let reject!: (reason: Error) => void;
  let status = 'authenticated';
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const services = {
    session: {
      logout: jest.fn(() => {
        status = 'invalid';
        return pending;
      }),
      getSnapshot: () => ({ status }),
    },
  } as unknown as BusinessServices;
  render(h(MemoryRouter, { initialEntries: ['/team/tasks'] }, h(Harness, { services })));
  fireEvent.click(screen.getByText('退出'));
  expect(screen.getByTestId('path').textContent).toBe('/account/login');
  if (loggedInAgain) {
    status = 'authenticated';
    fireEvent.click(screen.getByText('新登录'));
  }
  await act(async () => reject(new Error('断网')));
  await waitFor(() =>
    expect(screen.getByTestId('path').textContent).toBe(
      loggedInAgain ? '/team/tasks' : '/account/login'
    )
  );
  if (loggedInAgain) expect(screen.queryByRole('alert')).toBeNull();
  else expect(screen.getByRole('alert').textContent).toBe('本地已退出，服务端撤销未确认');
});

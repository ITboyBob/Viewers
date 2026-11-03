import React from 'react';
import { render, fireEvent, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import InviteRoute from './InviteRoute';
import BusinessAuthGate from '../../business/BusinessAuthGate';
import type { BusinessServices } from '@ohif/core';

let mockServices: BusinessServices;
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => ({ servicesManager: { services: { businessServices: mockServices } } }),
  }),
  { virtual: true }
);
const h = React.createElement;
const context = {
  user: { uid: 'u', username: 'owner', avatar_url: null },
  expires_at: '2099-01-01',
  default_team_id: 'default',
  memberships: [{ team_id: 'current', name: '当前团队', owner_uid: 'u', role: 'owner' as const }],
};
let send: jest.Mock, members: jest.Mock, validate: jest.Mock;
function tree() {
  return h(
    MemoryRouter,
    { initialEntries: ['/account/invite'] },
    h(
      Routes,
      null,
      h(Route, { path: '/account/invite', element: h(InviteRoute) }),
      h(Route, {
        path: '/team/tasks',
        element: h(BusinessAuthGate, { enabled: true }, h('p', null, '团队目标')),
      }),
      h(Route, { path: '/account/login', element: h('p', null, '重新登录') })
    )
  );
}
function mount() {
  return render(tree());
}
const enter = (name: string) =>
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: name } });
const complete = () => fireEvent.click(screen.getByRole('button', { name: '完成', exact: true }));
beforeEach(() => {
  send = jest.fn().mockResolvedValue({ invitation_id: 'i', decision: 'pending' });
  members = jest.fn().mockResolvedValue([{ uid: 'member', username: 'known' }]);
  const snapshot = {
    status: 'authenticated' as const,
    context,
    currentTeamId: 'current',
    error: null,
  };
  validate = jest.fn().mockResolvedValue(snapshot);
  mockServices = {
    api: { request: jest.fn() },
    session: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      validateCurrent: validate,
      register: jest.fn(),
      login: jest.fn(),
      invalidate: jest.fn(),
    },
    teamInvitations: {
      send,
      listMembers: members,
      listNotifications: jest.fn(),
      decide: jest.fn(),
    },
  };
});
afterEach(cleanup);

test('真实邀请表单替换占位，空值不能发送或离页', async () => {
  mount();
  expect(screen.queryByText('邀请页面待接入')).toBeNull();
  expect(screen.getByRole('heading', { name: '是否还有其他人加入你？' })).toBeTruthy();
  complete();
  expect(send).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(validate).not.toHaveBeenCalled();
});

test.each(['owner', 'known'])('自己或已知成员 %s 不发送', async username => {
  mount();
  await waitFor(() => expect(members).toHaveBeenCalledWith('current', expect.any(AbortSignal)));
  enter(username);
  complete();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});

test('成员清单失败必须显错且阻止发送，不伪装已排除成员', async () => {
  members.mockRejectedValue(new Error('名单无法加载'));
  mount();
  await screen.findByRole('alert');
  enter('Bob');
  complete();
  expect(send).not.toHaveBeenCalled();
  expect(screen.queryByText('团队目标')).toBeNull();
});

test('列表未加载完成前不能发出，加载后可以', async () => {
  let done: (value: []) => void;
  members.mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  mount();
  enter('Bob');
  complete();
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    done!([]);
  });
  complete();
  await screen.findByText('团队目标');
  expect(send).toHaveBeenCalledTimes(1);
});

test('仅使用会话当前团队，发送成功才经守卫进入导入，pending 拒绝双击和跳过', async () => {
  let done: (value: object) => void;
  send.mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  mount();
  await waitFor(() => expect(members).toHaveBeenCalled());
  enter(' Bob ');
  const submit = screen.getByRole('button', { name: '完成' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  fireEvent.click(screen.getByRole('button', { name: '跳过' }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('current', 'Bob', expect.any(AbortSignal));
  expect(validate).not.toHaveBeenCalled();
  done!({ invitation_id: 'i' });
  await screen.findByText('团队目标');
  expect(validate).toHaveBeenCalledTimes(1);
});

test('真实发送失败留页并可重试，无成功或已入队假文案', async () => {
  send.mockRejectedValueOnce(new Error('发送失败'));
  mount();
  await waitFor(() => expect(members).toHaveBeenCalled());
  enter('Bob');
  complete();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(validate).not.toHaveBeenCalled();
  expect(screen.queryByText(/已加入/)).toBeNull();
  complete();
  await screen.findByText('团队目标');
  expect(send).toHaveBeenCalledTimes(2);
});

test('跳过零发送，仍在导入入口重验会话', async () => {
  validate.mockResolvedValue({ status: 'invalid' });
  mount();
  fireEvent.click(screen.getByRole('button', { name: '跳过' }));
  await screen.findByText('重新登录');
  expect(send).not.toHaveBeenCalled();
  expect(validate).toHaveBeenCalledTimes(1);
});

test('缺失真实服务时 fail-closed，不替换为 mock', async () => {
  mockServices.teamInvitations = undefined;
  mount();
  enter('Bob');
  complete();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});

test('发送期间会话当前团队变化，取消旧请求、重新核对成员且不永久 pending', async () => {
  let done: (value: object) => void;
  send.mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  const view = mount();
  await screen.findByText(/邀请入队：/);
  enter('Bob');
  complete();
  const oldSignal = send.mock.calls[0][2] as AbortSignal;
  const next = {
    status: 'authenticated' as const,
    error: null,
    currentTeamId: 'other',
    context: {
      ...context,
      memberships: [{ team_id: 'other', name: '新团队', owner_uid: 'u', role: 'owner' as const }],
    },
  };
  mockServices.session.getSnapshot = () => next;
  view.rerender(tree());
  await waitFor(() => expect(members).toHaveBeenCalledWith('other', expect.any(AbortSignal)));
  expect(oldSignal.aborted).toBe(true);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '完成', exact: true })).toBeTruthy()
  );
  await act(async () => {
    done!({ invitation_id: 'old' });
  });
  expect(validate).not.toHaveBeenCalled();
});

test('离开邀请页后旧发送响应不再导航或更新视图', async () => {
  let done: (value: object) => void;
  send.mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  const view = mount();
  await screen.findByText(/邀请入队：/);
  enter('Bob');
  complete();
  view.unmount();
  expect((send.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
  await act(async () => {
    done!({ invitation_id: 'i' });
  });
  expect(validate).not.toHaveBeenCalled();
});

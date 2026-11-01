import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import NotificationDialog from './NotificationDialog';
import { CollaborationMockStore } from '../mock/CollaborationMockStore';
import type { InvitationView, TeamInvitationApi } from '@ohif/core';

const h = React.createElement;
const user = { uid: 'u', username: 'recipient', avatar_url: null };
const real: InvitationView = {
  invitation_id: 'real-i',
  team_id: 't',
  team_name: '真实目标团队',
  inviter: { uid: 'owner', username: '真实发起者', avatar_url: null },
  invitee_uid: 'u',
  created_at: '2001-01-01T00:00:00Z',
  expires_at: '2001-01-01T00:05:00Z',
  decision: 'pending',
  decided_at: null,
};
let api: TeamInvitationApi;
let store: CollaborationMockStore;
const open = () => fireEvent.click(screen.getByRole('button', { name: '通知', exact: true }));
const close = () => fireEvent.click(screen.getByRole('button', { name: '关闭通知弹窗' }));
const teamItem = () => screen.getByRole('article', { name: '入队邀请 真实目标团队' });
function mount() {
  return render(h(NotificationDialog, { api, store, user }));
}
beforeEach(() => {
  sessionStorage.clear();
  store = new CollaborationMockStore(user, sessionStorage);
  api = {
    send: jest.fn(),
    listMembers: jest.fn(),
    listNotifications: jest.fn().mockResolvedValue([real]),
    decide: jest.fn().mockImplementation(async (_, decision) => {
      const updated = { ...real, decision, decided_at: '2001-01-01T00:01:00Z' };
      (api.listNotifications as jest.Mock).mockResolvedValue([updated]);
      return updated;
    }),
  };
});
afterEach(cleanup);

test('关闭不预取，通知每次打开均刷新真实列表，不复用首次结果', async () => {
  mount();
  expect(api.listNotifications).not.toHaveBeenCalled();
  open();
  await screen.findByText('真实发起者');
  close();
  (api.listNotifications as jest.Mock).mockResolvedValue([{ ...real, team_name: '第二次团队' }]);
  open();
  await screen.findByText(/第二次团队/);
  expect(api.listNotifications).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('article', { name: '入队邀请 真实目标团队' })).toBeNull();
});

test.each(['accepted', 'rejected'] as const)(
  '真实 %s 必须显示团队名并调用真实接口，成功更新且再拉取',
  async decision => {
    mount();
    open();
    await screen.findByText('真实发起者');
    expect(within(teamItem()).getByText(/邀请你加入团队.*真实目标团队/)).toBeTruthy();
    fireEvent.click(
      within(teamItem()).getByRole('button', {
        name: decision === 'accepted' ? '接受' : '拒绝',
        exact: true,
      })
    );
    await within(teamItem()).findByText(decision === 'accepted' ? '已接受' : '已拒绝');
    expect(api.decide).toHaveBeenCalledWith('real-i', decision, expect.any(AbortSignal));
    await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(2));
    expect(store.list()).toEqual([]);
  }
);

test('处理失败保留条目，只在错误区提示；过期 pending 不加 badge、不隐藏或删除', async () => {
  (api.decide as jest.Mock).mockRejectedValue(new Error('邀请超过有效期'));
  mount();
  open();
  await screen.findByText('真实发起者');
  fireEvent.click(within(teamItem()).getByRole('button', { name: '接受', exact: true }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/有效期/);
  expect(teamItem()).toBeTruthy();
  expect(within(teamItem()).queryByText(/过期|到期/)).toBeNull();
  expect(within(teamItem()).getByRole('button', { name: '接受', exact: true })).toBeTruthy();
  expect(api.listNotifications).toHaveBeenCalledTimes(1);
});

test.each(['accepted', 'rejected'] as const)(
  'collaboration_mock %s 只处理模拟记录，不调用真实写接口或跳转、不解锁',
  async decision => {
    const first = store.invite('陈晨');
    const forbidden = jest.fn(() => {
      throw new Error('禁止请求');
    });
    const old = globalThis.fetch;
    globalThis.fetch = forbidden;
    const nav = jest.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw new Error('禁止跳转');
    });
    try {
      mount();
      open();
      await screen.findByText('真实发起者');
      const mockItem = screen.getByRole('article', { name: '协作模拟 陈晨' });
      expect(within(mockItem).getByText(/合成用户/)).toBeTruthy();
      fireEvent.click(
        within(mockItem).getByRole('button', {
          name: decision === 'accepted' ? '模拟接受' : '模拟拒绝',
        })
      );
      await within(mockItem).findByText(decision === 'accepted' ? '已接受' : '已拒绝');
      expect(store.list()[0].expires_at).toBe(first.expires_at);
      expect(store.isInvited('陈晨')).toBe(true);
      expect(api.decide).not.toHaveBeenCalled();
      expect(api.send).not.toHaveBeenCalled();
      expect(api.listMembers).not.toHaveBeenCalled();
      expect(api.listNotifications).toHaveBeenCalledTimes(1);
      expect(forbidden).not.toHaveBeenCalled();
      expect(nav).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = old;
      nav.mockRestore();
    }
  }
);

test('真实读取失败不降级或伪造成合成入队通知，mock 条目仍标明来源', async () => {
  store.invite('陈晨');
  (api.listNotifications as jest.Mock).mockRejectedValue(new Error('真实通知不可用'));
  mount();
  open();
  expect((await screen.findByRole('alert')).textContent).toMatch(/真实通知不可用/);
  expect(screen.queryByRole('article', { name: /入队邀请/ })).toBeNull();
  expect(screen.getByRole('article', { name: '协作模拟 陈晨' })).toBeTruthy();
  expect(screen.queryByText('暂无通知')).toBeNull();
});

test('同条 pending 操作防双击；决策成功但刷新失败也保留已成功状态', async () => {
  let done: (value: InvitationView) => void;
  (api.decide as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  mount();
  open();
  await screen.findByText('真实发起者');
  const accept = within(teamItem()).getByRole('button', { name: '接受', exact: true });
  fireEvent.click(accept);
  fireEvent.click(accept);
  expect(api.decide).toHaveBeenCalledTimes(1);
  (api.listNotifications as jest.Mock).mockRejectedValue(new Error('刷新失败'));
  await act(async () => {
    done!({ ...real, decision: 'accepted' });
  });
  await within(teamItem()).findByText('已接受');
  expect((await screen.findByRole('alert')).textContent).toMatch(/刷新失败/);
});

test('关闭取消旧视图请求；重开后晚到旧响应不能覆盖新通知', async () => {
  let oldDone: (value: InvitationView[]) => void;
  (api.listNotifications as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        oldDone = resolve;
      })
  );
  mount();
  open();
  const signal = (api.listNotifications as jest.Mock).mock.calls[0][0] as AbortSignal;
  close();
  expect(signal.aborted).toBe(true);
  (api.listNotifications as jest.Mock).mockResolvedValue([{ ...real, team_name: '新团队' }]);
  open();
  await screen.findByRole('article', { name: '入队邀请 新团队' });
  await act(async () => {
    oldDone!([real]);
  });
  expect(screen.getByRole('article', { name: '入队邀请 新团队' })).toBeTruthy();
  expect(screen.queryByRole('article', { name: '入队邀请 真实目标团队' })).toBeNull();
});

test('mock 存储故障不阻断真实通知；已过期 mock 处理失败不删条目', async () => {
  let now = 1000000;
  store = new CollaborationMockStore(user, sessionStorage, () => now);
  store.invite('陈晨');
  now += 300000;
  mount();
  open();
  await screen.findByText('真实发起者');
  const item = screen.getByRole('article', { name: '协作模拟 陈晨' });
  fireEvent.click(within(item).getByRole('button', { name: '模拟接受' }));
  expect(screen.getByRole('alert').textContent).toMatch(/有效期/);
  expect(item).toBeTruthy();
  expect(store.list()[0].decision).toBe('pending');
});

test('真实适配器缺失时明确报错，不把模拟列表冒充真实通知', async () => {
  render(h(NotificationDialog, { api: undefined, store, user }));
  open();
  expect((await screen.findByRole('alert')).textContent).toMatch(/真实通知服务不可用/);
  expect(screen.queryByRole('article', { name: /入队邀请/ })).toBeNull();
});

test('mock 存储损坏独立报错，不阻断真实接受与真实列表刷新', async () => {
  store = new CollaborationMockStore(user, { getItem: () => '{', setItem: jest.fn() });
  mount();
  open();
  await screen.findByText('真实发起者');
  expect(screen.getByRole('alert').textContent).toMatch(/数据损坏/);
  fireEvent.click(within(teamItem()).getByRole('button', { name: '接受', exact: true }));
  await within(teamItem()).findByText('已接受');
  expect(api.decide).toHaveBeenCalledTimes(1);
});

test('关闭取消未完成的真实决定，晚到响应不刷新或污染重开的新视图', async () => {
  let done: (value: InvitationView) => void;
  (api.decide as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        done = resolve;
      })
  );
  mount();
  open();
  await screen.findByText('真实发起者');
  fireEvent.click(within(teamItem()).getByRole('button', { name: '接受', exact: true }));
  const signal = (api.decide as jest.Mock).mock.calls[0][2] as AbortSignal;
  close();
  expect(signal.aborted).toBe(true);
  open();
  await screen.findByText('真实发起者');
  await act(async () => {
    done!({ ...real, decision: 'accepted' });
  });
  expect(within(teamItem()).queryByText('已接受')).toBeNull();
  expect(within(teamItem()).getByRole('button', { name: '接受', exact: true })).toBeTruthy();
  expect(api.listNotifications).toHaveBeenCalledTimes(2);
});

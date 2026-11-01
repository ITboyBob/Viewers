import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import CollaborationInviteDialog from './CollaborationInviteDialog';
import { CollaborationMockStore } from '../mock/CollaborationMockStore';

const h = React.createElement;
const user = { uid: 'u', username: 'owner', avatar_url: null };
const open = () => fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
const close = () => fireEvent.click(screen.getByRole('button', { name: '关闭邀请弹窗' }));
const rowInvite = () => screen.getByRole('button', { name: '邀请陈晨' });
beforeEach(() => {
  sessionStorage.clear();
  jest.useFakeTimers({ now: 1000000 });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test('空值禁用，合成成员可选，用户名只可邀请非本人的已注册合成用户，不生成邀请码', () => {
  const store = new CollaborationMockStore(user, sessionStorage);
  render(h(CollaborationInviteDialog, { store }));
  open();
  expect(screen.getByRole('dialog', { name: '邀请他人协作' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '按用户名邀请' }) as HTMLButtonElement).disabled).toBe(
    true
  );
  expect(screen.getByText(/仅使用合成用户/)).toBeTruthy();
  expect(screen.queryByText('生成邀请码')).toBeNull();
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: '未知用户' } });
  fireEvent.click(screen.getByRole('button', { name: '按用户名邀请' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(store.list()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: '周宁' } });
  fireEvent.click(screen.getByRole('button', { name: '按用户名邀请' }));
  expect(store.list()[0].recipient_username).toBe('周宁');
  expect(screen.getByRole('button', { name: '按用户名邀请' }).textContent).toBe('已邀请');
});

test('299999ms 重开仍禁用，恰好300000ms恢复，不重新计时', () => {
  const store = new CollaborationMockStore(user, sessionStorage);
  render(h(CollaborationInviteDialog, { store }));
  open();
  fireEvent.click(rowInvite());
  const expiry = store.list()[0].expires_at;
  expect(rowInvite().textContent).toBe('已邀请');
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
  close();
  act(() => {
    jest.advanceTimersByTime(299999);
  });
  open();
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
  expect(store.list()[0].expires_at).toBe(expiry);
  act(() => {
    jest.advanceTimersByTime(1);
  });
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(false);
  expect(rowInvite().textContent).toBe('邀请他');
});

test.each(['accepted', 'rejected'] as const)('%s 后刷新实例和重开仍不提前解锁', decision => {
  const store = new CollaborationMockStore(user, sessionStorage);
  const record = store.invite('陈晨');
  store.decide(record.mock_id, decision);
  const view = render(h(CollaborationInviteDialog, { store }));
  open();
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  act(() => {
    jest.advanceTimersByTime(100000);
  });
  render(h(CollaborationInviteDialog, { store: new CollaborationMockStore(user, sessionStorage) }));
  open();
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    jest.advanceTimersByTime(200000);
  });
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(false);
});

test('损坏数据与写入失败在现有错误区显示并阻止发送，不把失败当成功', () => {
  const disk = { getItem: () => '{', setItem: jest.fn() };
  const view = render(
    h(CollaborationInviteDialog, { store: new CollaborationMockStore(user, disk) })
  );
  open();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
  expect(disk.setItem).not.toHaveBeenCalled();
  view.unmount();
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  };
  render(h(CollaborationInviteDialog, { store: new CollaborationMockStore(user, broken) }));
  open();
  fireEvent.click(rowInvite());
  expect(screen.getByRole('alert').textContent).toMatch(/刷新/);
  expect((rowInvite() as HTMLButtonElement).disabled).toBe(true);
});

test('缺失 mock 存储不能转发到真实服务，所有按钮操作零网络／零导航', () => {
  const old = globalThis.fetch;
  const forbidden = jest.fn(() => {
    throw new Error('禁止请求');
  });
  globalThis.fetch = forbidden;
  const nav = jest.spyOn(window.history, 'pushState').mockImplementation(() => {
    throw new Error('禁止跳转');
  });
  try {
    render(
      h(CollaborationInviteDialog, { store: new CollaborationMockStore(user, sessionStorage) })
    );
    open();
    fireEvent.click(rowInvite());
    close();
    open();
    expect(forbidden).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = old;
    nav.mockRestore();
  }
});

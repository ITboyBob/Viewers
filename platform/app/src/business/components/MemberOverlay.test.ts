import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import MemberOverlay from './MemberOverlay';

const h = React.createElement;
const user = { uid: 'u', username: '当前用户', avatar_url: null };
afterEach(cleanup);

test('一级个人 overlay 显示通用头像、用户名与两项纯展示菜单，不请求团队或注销', async () => {
  const network = jest.fn(() => {
    throw new Error('禁止网络');
  });
  const navigation = jest.fn(() => {
    throw new Error('禁止跳转');
  });
  const old = globalThis.fetch;
  globalThis.fetch = network;
  try {
    render(h('div', { onClick: navigation }, h(MemberOverlay, { user })));
    fireEvent.click(screen.getByRole('button', { name: '成员' }));
    expect(await screen.findByRole('dialog', { name: '个人信息' })).toBeTruthy();
    expect(screen.getByText('当前用户')).toBeTruthy();
    expect(screen.getByLabelText('默认头像')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '查看你的团队' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(network).not.toHaveBeenCalled();
    expect(navigation).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = old;
  }
});

test('有头像时使用会话头像，Escape 关闭并把焦点返回入口', async () => {
  render(h(MemberOverlay, { user: { ...user, avatar_url: '/avatar.png' } }));
  const trigger = screen.getByRole('button', { name: '成员' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('img', { name: '当前用户的头像' }).getAttribute('src')).toBe(
    '/avatar.png'
  );
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('点击外部关闭，再打开不创建二级菜单', async () => {
  render(h(MemberOverlay, { user }));
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  await screen.findByRole('dialog');
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(2);
});

test('面板投放文件不冒泡到原生导入区，也不改变两个展示项', () => {
  const drop = jest.fn(),
    pointer = jest.fn();
  render(h('div', { onDrop: drop, onPointerDown: pointer }, h(MemberOverlay, { user })));
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.pointerDown(dialog);
  expect(fireEvent.drop(dialog)).toBe(false);
  expect(drop).not.toHaveBeenCalled();
  expect(pointer).not.toHaveBeenCalled();
  expect(
    screen.getAllByRole('menuitem').every(item => item.getAttribute('aria-disabled') === 'true')
  ).toBe(true);
});

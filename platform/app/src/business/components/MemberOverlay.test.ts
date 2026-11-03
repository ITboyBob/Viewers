import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import MemberOverlay from './MemberOverlay';

const h = React.createElement;
const user = { uid: 'u', username: '当前用户', avatar_url: null };
const openMember = async () => {
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  return screen.findByRole('dialog', { name: '个人信息' });
};
const teamTrigger = () => screen.getByRole('menuitem', { name: '查看你的团队' });
const teamMenu = () => screen.getByRole('menu', { name: '团队列表（占位）' });
afterEach(cleanup);

test('点击团队入口在一级面板旁打开占位菜单，不请求接口或执行导航', async () => {
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
    await openMember();
    expect(screen.getByText('当前用户')).toBeTruthy();
    expect(screen.getByLabelText('默认头像')).toBeTruthy();
    expect(teamTrigger().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(teamTrigger());
    expect(teamTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: '个人信息' })).toBeTruthy();
    expect(teamMenu().getAttribute('data-side')).toBe('right');
    expect(within(teamMenu()).getByText('示例团队，仅供界面预览')).toBeTruthy();
    for (const name of ['团队 A', '团队 B']) {
      const item = within(teamMenu()).getByRole('menuitem', { name });
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect((item as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(item);
    }
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(network).not.toHaveBeenCalled();
    expect(navigation).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = old;
  }
});

test('重复点击团队入口可以收起二级菜单，一级面板仍保持打开', async () => {
  render(h(MemberOverlay, { user }));
  await openMember();
  fireEvent.click(teamTrigger());
  expect(teamMenu()).toBeTruthy();
  fireEvent.click(teamTrigger());
  await waitFor(() => expect(screen.queryByRole('menu', { name: '团队列表（占位）' })).toBeNull());
  expect(screen.getByRole('dialog', { name: '个人信息' })).toBeTruthy();
});

test('有头像时使用会话头像，Escape 关闭并把焦点返回成员入口', async () => {
  render(h(MemberOverlay, { user: { ...user, avatar_url: '/avatar.png' } }));
  const trigger = screen.getByRole('button', { name: '成员' });
  trigger.focus();
  await openMember();
  expect(screen.getByRole('img', { name: '当前用户的头像' }).getAttribute('src')).toBe(
    '/avatar.png'
  );
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test('键盘向右展开、向左收起；Escape 先关闭子菜单再关闭一级面板并归还焦点', async () => {
  render(h(MemberOverlay, { user }));
  await openMember();
  teamTrigger().focus();
  fireEvent.keyDown(teamTrigger(), { key: 'ArrowRight' });
  expect(teamMenu()).toBeTruthy();
  fireEvent.keyDown(teamMenu(), { key: 'ArrowLeft' });
  await waitFor(() => expect(screen.queryByRole('menu', { name: '团队列表（占位）' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(teamTrigger()));
  fireEvent.click(teamTrigger());
  fireEvent.keyDown(teamMenu(), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu', { name: '团队列表（占位）' })).toBeNull());
  expect(screen.getByRole('dialog', { name: '个人信息' })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(teamTrigger()));
  fireEvent.keyDown(teamTrigger(), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '成员' }))
  );
});

test('点击外部关闭两级面板，重新打开不保留子菜单展开状态', async () => {
  render(h(MemberOverlay, { user }));
  await openMember();
  fireEvent.click(teamTrigger());
  expect(teamMenu()).toBeTruthy();
  fireEvent.pointerDown(teamMenu());
  fireEvent.click(teamMenu());
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('menu', { name: '团队列表（占位）' })).toBeNull();
  await openMember();
  expect(teamTrigger().getAttribute('aria-expanded')).toBe('false');
  expect(screen.getAllByRole('menuitem')).toHaveLength(2);
});

test('两级面板的点击、按键和文件投放不冒泡到影像或导入区域', async () => {
  const drop = jest.fn(),
    pointer = jest.fn(),
    click = jest.fn(),
    keyboard = jest.fn();
  render(
    h(
      'div',
      { onDrop: drop, onPointerDown: pointer, onClick: click, onKeyDown: keyboard },
      h(MemberOverlay, { user })
    )
  );
  const parent = await openMember();
  fireEvent.pointerDown(parent);
  expect(fireEvent.drop(parent)).toBe(false);
  fireEvent.click(teamTrigger());
  fireEvent.pointerDown(teamMenu());
  fireEvent.click(teamMenu());
  fireEvent.keyDown(teamMenu(), { key: 'ArrowDown' });
  expect(fireEvent.drop(teamMenu())).toBe(false);
  expect(drop).not.toHaveBeenCalled();
  expect(pointer).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  expect(keyboard).not.toHaveBeenCalled();
  expect(screen.getByRole('menuitem', { name: '退出登录' }).getAttribute('aria-disabled')).toBe(
    'true'
  );
});

test('窄屏采用下方展开，响应尺寸变化并在卸载时清理监听', async () => {
  const original = window.matchMedia;
  let change: () => void = () => {};
  const removeEventListener = jest.fn();
  const media = {
    matches: true,
    addEventListener: jest.fn((_type, handler) => {
      change = handler;
    }),
    removeEventListener,
  };
  window.matchMedia = jest.fn(() => media) as unknown as typeof window.matchMedia;
  try {
    const { unmount } = render(h(MemberOverlay, { user }));
    await openMember();
    fireEvent.click(teamTrigger());
    expect(teamMenu().getAttribute('data-side')).toBe('bottom');
    act(() => {
      media.matches = false;
      change();
    });
    // jsdom 无真实布局；最终摆放方向由浏览器 E2E 在调整视口后验证。
    expect(teamTrigger().getAttribute('aria-expanded')).toBe('true');
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', change);
  } finally {
    window.matchMedia = original;
  }
});

test.each([false, true])('个人与团队面板隔离完整字符按键序列，子菜单展开=%s', async expanded => {
  const globalKey = jest.fn();
  const types = ['keydown', 'keypress', 'keyup'] as const;
  types.forEach(type => document.addEventListener(type, globalKey));
  try {
    render(h(MemberOverlay, { user }));
    const parent = await openMember();
    if (expanded) fireEvent.click(teamTrigger());
    const target = expanded ? teamMenu() : parent;
    fireEvent.keyDown(target, { key: 'i', code: 'KeyI', keyCode: 73 });
    fireEvent.keyPress(target, { key: 'i', code: 'KeyI', charCode: 105 });
    fireEvent.keyUp(target, { key: 'i', code: 'KeyI', keyCode: 73 });
    expect(globalKey).not.toHaveBeenCalled();
  } finally {
    types.forEach(type => document.removeEventListener(type, globalKey));
  }
});

test('外部指针关闭不抢回焦点，外部输入框保持可输入', async () => {
  render(h('div', null, h(MemberOverlay, { user }), h('input', { 'aria-label': '外部输入' })));
  await openMember();
  fireEvent.click(teamTrigger());
  fireEvent.pointerDown(teamMenu());
  const input = screen.getByRole('textbox', { name: '外部输入' });
  fireEvent.pointerDown(input);
  input.focus();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // FocusScope 的卸载还焦点在计时器中完成，必须覆盖该清理周期之后的状态。
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(input);
});

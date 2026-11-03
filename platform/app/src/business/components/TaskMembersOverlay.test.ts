import React from 'react';
import Mousetrap from 'mousetrap';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TaskMemberList, TeamPageApi } from '@ohif/core';
import TaskMembersOverlay from './TaskMembersOverlay';

const h = React.createElement;
const taskId = '10000000-0000-4000-8000-000000000001';
const otherTaskId = '10000000-0000-4000-8000-000000000002';
const ownerUid = '20000000-0000-4000-8000-000000000001';
const list = (target = taskId, username = '示例任务 Owner'): TaskMemberList => ({
  task_id: target,
  owner_uid: ownerUid,
  mock: true,
  members: [
    { uid: '20000000-0000-4000-8000-000000000002', username: '非团队协作者' },
    { uid: ownerUid, username },
  ],
});
const makeApi = (): jest.Mocked<TeamPageApi> => ({
  listTeamTasks: jest.fn(),
  listRecentTasks: jest.fn(),
  listTaskMembers: jest.fn().mockResolvedValue(list()),
});
const deferred = () => {
  let resolve!: (value: TaskMemberList) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<TaskMemberList>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const trigger = () => screen.getByRole('button', { name: '任务成员' });
const open = () => fireEvent.click(trigger());
const panel = () => screen.getByRole('dialog', { name: '任务成员' });
const settle = async (action: () => void) =>
  act(async () => {
    action();
    await Promise.resolve();
  });
afterEach(cleanup);

test('只在打开时按目标 taskId 读取，展示用户名与显式唯一 Owner 并明确示例数据', async () => {
  const api = makeApi();
  render(h(TaskMembersOverlay, { taskId, api, identityKey: '当前用户' }));
  expect(api.listTaskMembers).not.toHaveBeenCalled();
  open();
  expect(api.listTaskMembers).toHaveBeenCalledWith(taskId, expect.any(AbortSignal));
  await screen.findByText('示例任务 Owner');
  expect(within(panel()).getByText('示例数据')).toBeTruthy();
  const members = within(panel()).getAllByRole('listitem');
  expect(members.map(member => member.textContent)).toEqual([
    '非团队协作者',
    '示例任务 OwnerOwner',
  ]);
  expect(within(panel()).getAllByText('Owner', { exact: true })).toHaveLength(1);
  expect(within(panel()).queryByRole('img')).toBeNull();
  expect(within(panel()).queryByRole('button')).toBeNull();
  expect(panel().textContent).not.toMatch(/在线|离线|权限|邀请来源|转让|移除|管理/);
  expect(panel().textContent).not.toContain(ownerUid);
  expect(panel().textContent).not.toContain(taskId);
  expect(api.listTeamTasks).not.toHaveBeenCalled();
  expect(api.listRecentTasks).not.toHaveBeenCalled();
});

test.each(['网络失败', '401', '404', '422', '500'])(
  '读取失败 %s 保留错误与重试，不伪装成功空名单',
  async message => {
    const api = makeApi();
    api.listTaskMembers.mockRejectedValueOnce(new Error(message));
    render(h(TaskMembersOverlay, { taskId, api, identityKey: '当前用户' }));
    open();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '成员读取失败，请重试。'
    );
    expect(within(panel()).queryByRole('list')).toBeNull();
    expect(panel().textContent).not.toMatch(/暂无|没有成员/);
    fireEvent.click(within(panel()).getByRole('button', { name: '重试' }));
    await screen.findByText('示例任务 Owner');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.listTaskMembers).toHaveBeenCalledTimes(2);
  }
);

test.each(['identityKey', 'taskId'])('%s 改变立即清除已展示名单并读取新上下文', async field => {
  const api = makeApi();
  const next = deferred();
  const props = { taskId, api, identityKey: '用户一' };
  const { rerender } = render(h(TaskMembersOverlay, props));
  open();
  await screen.findByText('示例任务 Owner');
  const oldSignal = api.listTaskMembers.mock.calls[0][1];
  api.listTaskMembers.mockReturnValueOnce(next.promise);
  const nextProps = { ...props, [field]: field === 'taskId' ? otherTaskId : '用户二' };
  rerender(h(TaskMembersOverlay, nextProps));
  expect(oldSignal?.aborted).toBe(true);
  expect(screen.queryByText('示例任务 Owner')).toBeNull();
  expect(within(panel()).getByRole('status').textContent).toBe('正在读取成员…');
  expect(api.listTaskMembers).toHaveBeenLastCalledWith(nextProps.taskId, expect.any(AbortSignal));
  await settle(() => next.resolve(list(nextProps.taskId, '新上下文 Owner')));
  expect(await screen.findByText('新上下文 Owner')).toBeTruthy();
});

test.each(['identityKey', 'taskId'])('%s 改变取消请求并隔离旧上下文迟到成功响应', async field => {
  const api = makeApi();
  const old = deferred(),
    next = deferred();
  api.listTaskMembers.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const props = { taskId, api, identityKey: '用户一' };
  const { rerender } = render(h(TaskMembersOverlay, props));
  open();
  const signal = api.listTaskMembers.mock.calls[0][1];
  const nextProps = { ...props, [field]: field === 'taskId' ? otherTaskId : '用户二' };
  rerender(h(TaskMembersOverlay, nextProps));
  expect(signal?.aborted).toBe(true);
  await settle(() => next.resolve(list(nextProps.taskId, '新的 Owner')));
  await screen.findByText('新的 Owner');
  await settle(() => old.resolve(list(taskId, '迟到旧 Owner')));
  expect(screen.queryByText('迟到旧 Owner')).toBeNull();
  expect(screen.getByText('新的 Owner')).toBeTruthy();
});

test('身份变化后旧请求迟到失败不能覆盖新名单或展示错误', async () => {
  const api = makeApi(),
    old = deferred();
  api.listTaskMembers.mockReturnValueOnce(old.promise);
  const { rerender } = render(h(TaskMembersOverlay, { taskId, api, identityKey: '用户一' }));
  open();
  rerender(h(TaskMembersOverlay, { taskId, api, identityKey: '用户二' }));
  await screen.findByText('示例任务 Owner');
  await settle(() => old.reject(new Error('旧错误')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('示例任务 Owner')).toBeTruthy();
});

test('关闭取消请求；重开重新读取且旧响应不能污染本次名单', async () => {
  const api = makeApi(),
    old = deferred(),
    next = deferred();
  api.listTaskMembers.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(h(TaskMembersOverlay, { taskId, api, identityKey: '用户' }));
  open();
  const signal = api.listTaskMembers.mock.calls[0][1];
  fireEvent.keyDown(panel(), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(signal?.aborted).toBe(true);
  open();
  expect(api.listTaskMembers).toHaveBeenCalledTimes(2);
  await settle(() => old.resolve(list(taskId, '上次打开的 Owner')));
  expect(screen.queryByText('上次打开的 Owner')).toBeNull();
  expect(within(panel()).getByRole('status')).toBeTruthy();
  await settle(() => next.resolve(list(taskId, '本次 Owner')));
  expect(await screen.findByText('本次 Owner')).toBeTruthy();
});

test('成功名单关闭后不缓存；隐藏时目标或身份改变不请求，重开使用最新上下文', async () => {
  const api = makeApi();
  const { rerender } = render(h(TaskMembersOverlay, { taskId, api, identityKey: '用户一' }));
  open();
  await screen.findByText('示例任务 Owner');
  fireEvent.keyDown(panel(), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  rerender(h(TaskMembersOverlay, { taskId: otherTaskId, api, identityKey: '用户二' }));
  expect(api.listTaskMembers).toHaveBeenCalledTimes(1);
  api.listTaskMembers.mockReturnValueOnce(deferred().promise);
  open();
  expect(screen.queryByText('示例任务 Owner')).toBeNull();
  expect(api.listTaskMembers).toHaveBeenLastCalledWith(otherTaskId, expect.any(AbortSignal));
});

test.each(['resolve', 'reject'])('卸载取消请求并忽略迟到 %s', async completion => {
  const api = makeApi(),
    pending = deferred();
  api.listTaskMembers.mockReturnValueOnce(pending.promise);
  const { unmount } = render(h(TaskMembersOverlay, { taskId, api, identityKey: '用户' }));
  open();
  const signal = api.listTaskMembers.mock.calls[0][1];
  unmount();
  expect(signal?.aborted).toBe(true);
  await settle(() =>
    completion === 'resolve' ? pending.resolve(list()) : pending.reject(new Error('迟到失败'))
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('Escape 关闭后焦点返回入口；重复点击入口可收起', async () => {
  const api = makeApi();
  render(h(TaskMembersOverlay, { taskId, api, identityKey: '用户' }));
  trigger().focus();
  open();
  await screen.findByText('示例任务 Owner');
  fireEvent.keyDown(panel(), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger()));
  open();
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('外部指针关闭后不抢走外部输入焦点', async () => {
  const api = makeApi();
  render(
    h(
      'div',
      null,
      h(TaskMembersOverlay, { taskId, api, identityKey: '用户' }),
      h('input', { 'aria-label': '外部输入' })
    )
  );
  open();
  await screen.findByText('示例任务 Owner');
  fireEvent.pointerDown(panel());
  const input = screen.getByRole('textbox');
  fireEvent.pointerDown(input);
  input.focus();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe(input);
});

test('任务浮层隔离完整快捷键序列、点击、指针及文件投放', async () => {
  const api = makeApi();
  const keyboard = jest.fn(),
    click = jest.fn(),
    pointer = jest.fn(),
    drop = jest.fn();
  const types = ['keydown', 'keypress', 'keyup'] as const;
  types.forEach(type => document.addEventListener(type, keyboard));
  try {
    render(
      h(
        'div',
        { onClick: click, onPointerDown: pointer, onDrop: drop },
        h(TaskMembersOverlay, { taskId, api, identityKey: '用户' })
      )
    );
    open();
    await screen.findByText('示例任务 Owner');
    fireEvent.click(panel());
    fireEvent.pointerDown(panel());
    fireEvent.keyDown(panel(), { key: 'i', code: 'KeyI', keyCode: 73 });
    fireEvent.keyPress(panel(), { key: 'i', code: 'KeyI', charCode: 105 });
    fireEvent.keyUp(panel(), { key: 'i', code: 'KeyI', keyCode: 73 });
    expect(fireEvent.dragOver(panel())).toBe(false);
    expect(fireEvent.drop(panel())).toBe(false);
    expect(keyboard).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
  } finally {
    types.forEach(type => document.removeEventListener(type, keyboard));
  }
});

test.each(['成功', '失败'])(
  '聚焦重试后第二次请求等待及%s期间焦点留在浮层，真实快捷键不泄漏',
  async result => {
    const api = makeApi(),
      pending = deferred();
    api.listTaskMembers
      .mockRejectedValueOnce(new Error('首次失败'))
      .mockReturnValueOnce(pending.promise);
    const shortcut = jest.fn(),
      documentKeyboard = jest.fn();
    const types = ['keydown', 'keypress', 'keyup'] as const;
    const pressFromActiveElement = () => {
      // 必须向真实焦点发送完整按键序列，不能固定向面板派发而掩盖 BODY 焦点泄漏。
      const target = document.activeElement as HTMLElement;
      fireEvent.keyDown(target, { key: 'i', code: 'KeyI', keyCode: 73, which: 73 });
      fireEvent.keyPress(target, {
        key: 'i',
        code: 'KeyI',
        keyCode: 105,
        charCode: 105,
        which: 105,
      });
      fireEvent.keyUp(target, { key: 'i', code: 'KeyI', keyCode: 73, which: 73 });
    };
    Mousetrap.bind('i', shortcut);
    types.forEach(type => document.addEventListener(type, documentKeyboard));
    try {
      render(
        h(
          'div',
          null,
          h(TaskMembersOverlay, { taskId, api, identityKey: '用户' }),
          h('button', { type: 'button' }, '底层按钮')
        )
      );
      // 先证实测试使用的真实文档级 Mousetrap 绑定有效。
      pressFromActiveElement();
      expect(shortcut).toHaveBeenCalledTimes(1);
      shortcut.mockClear();
      documentKeyboard.mockClear();

      open();
      await screen.findByRole('alert');
      const retry = within(panel()).getByRole('button', { name: '重试' });
      act(() => retry.focus());
      expect(document.activeElement).toBe(retry);
      fireEvent.click(retry);
      expect(api.listTaskMembers).toHaveBeenCalledTimes(2);
      expect(within(panel()).getByRole('status').textContent).toBe('正在读取成员…');
      expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

      pressFromActiveElement();
      expect(shortcut).not.toHaveBeenCalled();
      expect(documentKeyboard).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(panel());

      await settle(() =>
        result === '成功' ? pending.resolve(list()) : pending.reject(new Error('第二次失败'))
      );
      if (result === '成功') await screen.findByText('示例任务 Owner');
      else await screen.findByRole('alert');
      pressFromActiveElement();
      expect(shortcut).not.toHaveBeenCalled();
      expect(documentKeyboard).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(panel());

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
      act(() => screen.getByRole('button', { name: '底层按钮' }).focus());
      // 关闭后底层快捷键仍正常，修复不能依赖全局禁用或强模态。
      pressFromActiveElement();
      expect(shortcut).toHaveBeenCalledTimes(1);
    } finally {
      Mousetrap.unbind('i');
      types.forEach(type => document.removeEventListener(type, documentKeyboard));
    }
  }
);

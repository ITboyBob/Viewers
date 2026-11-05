import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import CollaborationInviteDialog from './CollaborationInviteDialog';
const h = React.createElement;
const open = () => fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
const close = () => fireEvent.click(screen.getByRole('button', { name: '关闭邀请弹窗' }));
const submit = () => screen.getByRole('button', { name: '按用户名邀请' }) as HTMLButtonElement;
let api: any;
beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-11-06T00:00:00Z') });
  api = {
    listSent: jest.fn().mockResolvedValue({ data: [], server_time: new Date().toISOString() }),
    send: jest.fn(async (_task, name, permission) => ({
      invitation_id: 'i',
      task_id: 'task',
      invitee: { uid: 'v', username: name },
      permission,
      decision: 'pending',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    })),
  };
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
test('无合成成员，默认可编辑，真实发送所选权限，处理中防重', async () => {
  render(h(CollaborationInviteDialog, { api, taskId: 'task' }));
  open();
  await flush();
  expect(screen.queryByText(/合成|陈晨|李敏|周宁/)).toBeNull();
  expect((screen.getByLabelText('权限') as HTMLSelectElement).value).toBe('edit');
  expect(submit().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: ' Bob ' } });
  fireEvent.change(screen.getByLabelText('权限'), { target: { value: 'view' } });
  fireEvent.click(submit());
  fireEvent.click(submit());
  await flush();
  expect(api.send).toHaveBeenCalledTimes(1);
  expect(api.send.mock.calls[0].slice(0, 3)).toEqual(['task', 'Bob', 'view']);
  expect(submit().textContent).toBe('已邀请');
  expect(submit().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('权限'), { target: { value: 'edit' } });
  expect(submit().disabled).toBe(true);
});
test.each(['accepted', 'rejected'])(
  '%s 记录在原五分钟内重开、刷新仍恢复本人已邀请',
  async decision => {
    const expires_at = new Date(Date.now() + 300000).toISOString();
    api.listSent.mockImplementation(async () => ({
      data: [
        {
          invitation_id: 'i',
          task_id: 'task',
          invitee: { uid: 'v', username: 'Bob' },
          decision,
          created_at: new Date().toISOString(),
          expires_at,
        },
      ],
      server_time: new Date().toISOString(),
    }));
    const view = render(h(CollaborationInviteDialog, { api, taskId: 'task' }));
    open();
    await flush();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Bob' } });
    expect(submit().disabled).toBe(true);
    close();
    act(() => jest.advanceTimersByTime(299999));
    open();
    await flush();
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'Bob' } });
    expect(submit().disabled).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(submit().disabled).toBe(false);
    view.unmount();
  }
);
test('读取或发送失败显示明确错误，不冒充已邀请', async () => {
  api.send.mockRejectedValue(new Error('无法邀请该用户'));
  render(h(CollaborationInviteDialog, { api, taskId: 'task' }));
  open();
  await flush();
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'missing' } });
  fireEvent.click(submit());
  await flush();
  expect(screen.getByRole('alert').textContent).toContain('无法邀请该用户');
  expect(submit().textContent).toBe('邀请');
  close();
  api.listSent.mockRejectedValue(new Error('记录读取失败'));
  open();
  await flush();
  expect(screen.getByRole('alert').textContent).toContain('记录读取失败');
  expect(submit().disabled).toBe(true);
});
test('没有真实服务或工作台标识时不可发送', async () => {
  render(h(CollaborationInviteDialog, {}));
  open();
  await flush();
  expect(submit().disabled).toBe(true);
  expect(screen.getByRole('alert')).toBeTruthy();
});

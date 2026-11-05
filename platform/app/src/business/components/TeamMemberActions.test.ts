import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamMemberActions from './TeamMemberActions';
afterEach(cleanup);
const api = () =>
  ({
    listMembers: jest.fn(),
    listSent: jest.fn().mockResolvedValue({ data: [], server_time: new Date().toISOString() }),
    send: jest.fn(),
  }) as any;
test('完整101人只读头像和用户名，不展示角色、移除或行邀请', async () => {
  const service = api();
  service.listMembers.mockResolvedValue(
    Array.from({ length: 101 }, (_, i) => ({
      uid: String(i),
      username: '成员' + i,
      avatar_url: i === 0 ? '/avatar.png' : null,
      role: 'annotator',
      joined_at: '2026-11-04',
    }))
  );
  render(React.createElement(TeamMemberActions, { teamId: 't', api: service }));
  fireEvent.click(screen.getByRole('button', { name: '查看团队成员', exact: true }));
  await screen.findByRole('list', { name: '完整团队成员' });
  expect(screen.getAllByRole('listitem')).toHaveLength(101);
  expect(screen.queryByText('annotator')).toBeNull();
  expect(screen.queryByRole('button', { name: '移除' })).toBeNull();
  expect(service.listSent).not.toHaveBeenCalled();
});
test('成员页失败显示未完成且可重试，与邀请读取分开', async () => {
  const service = api();
  service.listMembers.mockRejectedValueOnce(new Error('第二页失败')).mockResolvedValue([]);
  render(React.createElement(TeamMemberActions, { teamId: 't', api: service }));
  fireEvent.click(screen.getByRole('button', { name: '查看团队成员', exact: true }));
  await screen.findByText(/名单读取未完成/);
  expect(screen.queryByRole('list')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
  await screen.findByRole('list');
  fireEvent.click(screen.getByRole('button', { name: '关闭成员弹窗' }));
  fireEvent.click(screen.getByRole('button', { name: '新增团队成员' }));
  await screen.findByLabelText('输入他的用户名');
  expect(screen.queryByRole('list')).toBeNull();
  await waitFor(() => expect(service.listSent).toHaveBeenCalledTimes(1));
});
test('切账号/团队重建时关闭弹窗、取消旧名单且晚到数据不写新界面', async () => {
  const service = api();
  let done!: (value: any[]) => void;
  service.listMembers.mockImplementation(() => new Promise(resolve => (done = resolve)));
  const view = render(
    React.createElement(TeamMemberActions, { key: 'a:t', teamId: 't', api: service })
  );
  fireEvent.click(screen.getByRole('button', { name: '查看团队成员', exact: true }));
  const signal = service.listMembers.mock.calls[0][1];
  view.rerender(
    React.createElement(TeamMemberActions, { key: 'b:new', teamId: 'new', api: service })
  );
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  const { act } = await import('@testing-library/react');
  await act(async () => done([{ uid: 'old', username: '旧账号秘密' }]));
  expect(screen.queryByText('旧账号秘密')).toBeNull();
});

test('成员接口404关闭弹窗并停止使用已撤销团队，可重试会话恢复', async () => {
  const service = api(),
    recover = jest.fn();
  service.listMembers.mockRejectedValue({ status: 404 });
  render(
    React.createElement(TeamMemberActions, { teamId: 't', api: service, onContextLost: recover })
  );
  fireEvent.click(screen.getByRole('button', { name: '查看团队成员', exact: true }));
  await screen.findByText('当前团队资格已失效。');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(recover).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '重试恢复团队' }));
  expect(recover).toHaveBeenCalledTimes(2);
});
test('真实名单服务未装配时明确报错，不回退假名单', async () => {
  render(React.createElement(TeamMemberActions, { teamId: 't' }));
  fireEvent.click(screen.getByRole('button', { name: '查看团队成员', exact: true }));
  await screen.findByText(/真实成员服务不可用/);
  expect(screen.queryByRole('list')).toBeNull();
});

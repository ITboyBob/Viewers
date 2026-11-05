import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamInviteForm from './TeamInviteForm';
afterEach(cleanup);
function setup(
  listSent = jest.fn().mockResolvedValue({ data: [], server_time: new Date().toISOString() })
) {
  const api = {
    listSent,
    send: jest.fn().mockResolvedValue({
      invitation_id: 'i',
      team_id: 't',
      invitee_uid: 'b',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 300000).toISOString(),
    }),
  } as any;
  render(React.createElement(TeamInviteForm, { api, teamId: 't' }));
  return api;
}
test('输入自己或已成员不做前置预检，点击均发送真实POST', async () => {
  const api = setup();
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: ' myself ' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await waitFor(() =>
    expect(api.send).toHaveBeenCalledWith('t', 'myself', expect.any(AbortSignal))
  );
  await screen.findByRole('button', { name: '已邀请', exact: true });
  expect(api.listSent).toHaveBeenCalledTimes(1);
});
test('期限恢复失败仍允许发送并提供独立重试', async () => {
  const api = setup(jest.fn().mockRejectedValue(new Error('离线')));
  await screen.findByText(/期限恢复失败/);
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await waitFor(() => expect(api.send).toHaveBeenCalled());
});
test('关重开后的真实本人记录驱动禁用，换用户名不会误锁', async () => {
  setup(
    jest.fn().mockResolvedValue({
      server_time: new Date().toISOString(),
      data: [
        {
          invitation_id: 'i',
          team_id: 't',
          invitee: { uid: 'b', username: 'Bob' },
          expires_at: new Date(Date.now() + 300000).toISOString(),
        },
      ],
    })
  );
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'Bob' } });
  expect(
    ((await screen.findByRole('button', { name: '已邀请' })) as HTMLButtonElement).disabled
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'Other' } });
  expect(
    (screen.getByRole('button', { name: '邀请', exact: true }) as HTMLButtonElement).disabled
  ).toBe(false);
});

test('发送结果未知只恢复权威期限，不宣称新的成功；失败可继续提交其他用户名', async () => {
  const { BusinessApiError } = await import('../BusinessApiClient');
  const api = setup();
  api.send.mockRejectedValueOnce(new BusinessApiError(0, 'TIMEOUT', '超时'));
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await screen.findByText(/发送结果未知/);
  await waitFor(() => expect(api.listSent).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: '已邀请' })).toBeNull();
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'c' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await screen.findByRole('button', { name: '已邀请' });
});
test.each([
  ['ALREADY_MEMBER', '该用户已在团队中。'],
  ['INVALID_INVITEE', '无法邀请该用户。'],
  ['INVITATION_COOLDOWN', '本人邀请仍在有效期限内，请恢复邀请记录。'],
])('后端%s业务失败不创建成功记录', async (reason, message) => {
  const { BusinessApiError } = await import('../BusinessApiClient');
  const api = setup();
  api.send.mockRejectedValueOnce(new BusinessApiError(409, 'CONFLICT', '冲突', reason));
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await screen.findByText(message);
  expect(screen.queryByRole('button', { name: '已邀请' })).toBeNull();
});
test('重复提交只发送一次，关闭后晚到成功不能触发导航', async () => {
  const api = setup();
  let done!: (value: any) => void;
  api.send.mockImplementation(() => new Promise(resolve => (done = resolve)));
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
  const submit = screen.getByRole('button', { name: '邀请', exact: true });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(api.send).toHaveBeenCalledTimes(1);
  const signal = api.send.mock.calls[0][2];
  cleanup();
  expect(signal.aborted).toBe(true);
  await import('@testing-library/react').then(({ act }) =>
    act(async () => done({ invitation_id: 'i', team_id: 't' }))
  );
});
test('恢复失败可独立重试；破损发送响应不能假成功', async () => {
  const list = jest
    .fn()
    .mockRejectedValueOnce(new Error('离线'))
    .mockResolvedValue({ data: [], server_time: new Date().toISOString() });
  const api = setup(list);
  await screen.findByText(/期限恢复失败/);
  fireEvent.click(screen.getByRole('button', { name: '重试恢复' }));
  await waitFor(() => expect(screen.queryByText(/期限恢复失败/)).toBeNull());
  api.send.mockResolvedValueOnce({ invitation_id: 'bad' });
  fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
  fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
  await screen.findByText(/邀请响应不完整/);
  expect(screen.queryByRole('button', { name: '已邀请' })).toBeNull();
});

test('期限读取失败且客户端时钟快十分钟，成功响应仍按原expires_at进入冷却', async () => {
  const server = Date.now(),
    spy = jest.spyOn(Date, 'now').mockReturnValue(server + 600000);
  try {
    const api = setup(jest.fn().mockRejectedValue(new Error('503')));
    api.send.mockResolvedValueOnce({
      invitation_id: 'i',
      team_id: 't',
      invitee_uid: 'b',
      created_at: new Date(server).toISOString(),
      expires_at: new Date(server + 300000).toISOString(),
    });
    await screen.findByText(/期限恢复失败/);
    fireEvent.change(screen.getByLabelText('输入他的用户名'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: '邀请', exact: true }));
    expect(
      ((await screen.findByRole('button', { name: '已邀请' })) as HTMLButtonElement).disabled
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
test('团队404清理旧期限和输入并请求会话恢复，不继续展示无效团队表单', async () => {
  const { BusinessApiError } = await import('../BusinessApiClient');
  const lost = jest.fn();
  const api: any = {
    listSent: jest.fn().mockRejectedValue(new BusinessApiError(404, 'NOT_FOUND', '资源不存在')),
    send: jest.fn(),
  };
  render(React.createElement(TeamInviteForm, { api, teamId: 't', onContextLost: lost }));
  await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
  expect(screen.queryByLabelText('输入他的用户名')).toBeNull();
});

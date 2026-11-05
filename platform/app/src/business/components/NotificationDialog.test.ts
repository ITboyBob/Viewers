import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import NotificationDialog from './NotificationDialog';
const h = React.createElement,
  user = { uid: 'u', username: '接收者', avatar_url: null };
const team = {
  invitation_id: 'team-i',
  team_id: 't',
  team_name: '团队甲',
  inviter: { uid: 'o', username: '团队邀请者', avatar_url: null },
  invitee_uid: 'u',
  decision: 'pending',
  read_at: null,
};
const work = {
  invitation_id: 'work-i',
  task_id: 'task',
  task_title: '工作台甲',
  inviter: { uid: 'v', username: '协作邀请者', avatar_url: null },
  invitee: { uid: 'u', username: '接收者' },
  invitee_uid: 'u',
  permission: 'view',
  decision: 'pending',
  read_at: null,
};
let api: any, collaborationApi: any, onOpenWorkspace: jest.Mock;
const open = () => fireEvent.click(screen.getByRole('button', { name: '通知', exact: true }));
const close = () => fireEvent.click(screen.getByRole('button', { name: '关闭通知弹窗' }));
const workItem = () => screen.getByRole('article', { name: '工作台协作邀请 工作台甲' });
beforeEach(() => {
  api = {
    listNotifications: jest.fn().mockResolvedValue([team]),
    unreadCount: jest.fn().mockResolvedValue(1),
    markRead: jest.fn().mockResolvedValue(0),
    decide: jest.fn(async (_id, decision) => {
      const next = { ...team, decision };
      api.listNotifications.mockResolvedValue([next]);
      return next;
    }),
  };
  collaborationApi = {
    listNotifications: jest.fn().mockResolvedValue([work]),
    unreadCount: jest.fn().mockResolvedValue(1),
    markRead: jest.fn().mockResolvedValue(0),
    accept: jest.fn(async () => {
      const invitation = { ...work, decision: 'accepted' };
      collaborationApi.listNotifications.mockResolvedValue([invitation]);
      return { invitation, task_id: 'task', mode_path: 'segmentation/dicomlocal' };
    }),
    reject: jest.fn(async () => {
      const invitation = { ...work, decision: 'rejected' };
      collaborationApi.listNotifications.mockResolvedValue([invitation]);
      return invitation;
    }),
  };
  onOpenWorkspace = jest.fn().mockResolvedValue(undefined);
});
afterEach(cleanup);
function mount(props = {}) {
  return render(h(NotificationDialog, { api, collaborationApi, user, onOpenWorkspace, ...props }));
}
test('同一入口读取两类真实通知，不展示协作权限，并分别标读', async () => {
  mount();
  expect(api.listNotifications).not.toHaveBeenCalled();
  open();
  await screen.findByText('协作邀请者');
  expect(screen.getByText(/邀请你协作此工作台.*工作台甲/)).toBeTruthy();
  expect(screen.getByText(/邀请你加入团队.*团队甲/)).toBeTruthy();
  expect(screen.queryByText(/仅查看|可编辑|合成|模拟/)).toBeNull();
  await waitFor(() =>
    expect(collaborationApi.markRead).toHaveBeenCalledWith(['work-i'], expect.any(AbortSignal))
  );
  expect(api.markRead).toHaveBeenCalledWith(['team-i'], expect.any(AbortSignal));
  close();
  open();
  await waitFor(() => expect(collaborationApi.listNotifications).toHaveBeenCalledTimes(2));
});
test('接受协作后先显示已接受；加载失败可直接重试进入，不重复接受', async () => {
  onOpenWorkspace.mockRejectedValueOnce(new Error('原图加载失败'));
  mount();
  open();
  await screen.findByText('协作邀请者');
  fireEvent.click(within(workItem()).getByRole('button', { name: '接受' }));
  await screen.findByText('已接受');
  await screen.findByText(/邀请已接受.*工作台加载失败/);
  expect(api.decide).not.toHaveBeenCalled();
  expect(collaborationApi.accept).toHaveBeenCalledTimes(1);
  fireEvent.click(within(workItem()).getByRole('button', { name: '重试进入工作台' }));
  await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledTimes(2));
  expect(collaborationApi.accept).toHaveBeenCalledTimes(1);
});
test.each(['接受', '拒绝'])('团队%s仍走原入队接口，不触发协作导航', async label => {
  const accepted = jest.fn();
  mount({ onAccepted: accepted });
  open();
  await screen.findByText('团队邀请者');
  fireEvent.click(
    within(screen.getByRole('article', { name: '入队邀请 团队甲' })).getByRole('button', {
      name: label,
    })
  );
  await waitFor(() =>
    expect(api.decide).toHaveBeenCalledWith(
      'team-i',
      label === '接受' ? 'accepted' : 'rejected',
      expect.any(AbortSignal)
    )
  );
  expect(collaborationApi.accept).not.toHaveBeenCalled();
  expect(onOpenWorkspace).not.toHaveBeenCalled();
});
test('协作拒绝不导航，后端失败保留 pending 且防重复点击', async () => {
  let resolve: any;
  collaborationApi.reject.mockImplementation(() => new Promise(r => (resolve = r)));
  mount();
  open();
  await screen.findByText('协作邀请者');
  const button = within(workItem()).getByRole('button', { name: '拒绝' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(collaborationApi.reject).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ...work, decision: 'rejected' }));
  expect(onOpenWorkspace).not.toHaveBeenCalled();
});
test('一类通知失败不遮蔽另一类，不伪装暂无通知，不错误标读', async () => {
  collaborationApi.listNotifications.mockRejectedValue(new Error('协作读取失败'));
  mount();
  open();
  await screen.findByText('团队邀请者');
  await screen.findByText(/协作读取失败/);
  expect(screen.queryByText('暂无通知')).toBeNull();
  expect(collaborationApi.markRead).not.toHaveBeenCalled();
});
test('关闭取消读取和处理；晚响应不得污染重开后的通知', async () => {
  let resolve: any;
  collaborationApi.listNotifications.mockImplementationOnce(() => new Promise(r => (resolve = r)));
  mount();
  open();
  await screen.findByText('团队邀请者');
  const signal = collaborationApi.listNotifications.mock.calls[0][0];
  close();
  expect(signal.aborted).toBe(true);
  open();
  await screen.findByText('协作邀请者');
  await act(async () => resolve([{ ...work, task_title: '旧工作台' }]));
  expect(screen.queryByText(/旧工作台/)).toBeNull();
});
test('标读失败保留错误，不将待处理决定用作已读依据', async () => {
  collaborationApi.markRead.mockRejectedValue(new Error('标读失败'));
  mount();
  open();
  await screen.findByText(/标读失败/);
  expect(within(workItem()).getByRole('button', { name: '接受' })).toBeTruthy();
});

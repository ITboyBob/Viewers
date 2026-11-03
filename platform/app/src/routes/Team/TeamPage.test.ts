import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import TeamPage from './TeamPage';
import type { TeamTaskList } from '@ohif/core';
const h = React.createElement;
const team = {
  team_id: '10000000-0000-4000-8000-000000000001',
  owner_uid: '30000000-0000-4000-8000-000000000001',
  role: 'owner' as const,
  name: '林医生的团队',
};
const data: TeamTaskList = {
  items: [
    {
      task_id: '20000000-0000-4000-8000-000000000001',
      team_id: '10000000-0000-4000-8000-000000000001',
      title: '肝脏轮廓标注',
      subtitle: '腹部 CT.dcm · 示例文件',
      preview_key: 'abdominal-ct',
    },
    {
      task_id: '20000000-0000-4000-8000-000000000002',
      team_id: '10000000-0000-4000-8000-000000000001',
      title: '病灶复核标注',
      subtitle: '示例任务',
      preview_key: 'none',
    },
  ],
  total: 2,
  mock: true,
};
const props = {
  view: 'team' as const,
  team,
  username: '林医生',
  state: { status: 'ready' as const, data },
  onViewChange: jest.fn(),
};
afterEach(cleanup);

test('显示品牌、团队身份、两个看板、卡片与同一响应计数，始终明确示例数据', () => {
  render(h(TeamPage, props));
  expect(screen.getByText('OHIF')).toBeTruthy();
  expect(screen.queryByText('团队空间')).toBeNull();
  expect(screen.getByRole('heading', { name: team.name })).toBeTruthy();
  expect(screen.getByRole('button', { name: '团队任务' }).getAttribute('aria-current')).toBe(
    'page'
  );
  expect(screen.getByRole('button', { name: '最近任务' })).toBeTruthy();
  expect(screen.getByText('肝脏轮廓标注')).toBeTruthy();
  expect(screen.getByText('腹部 CT.dcm · 示例文件')).toBeTruthy();
  expect(screen.getByLabelText('任务数量').textContent).toBe('2');
  expect(screen.getByRole('note').textContent).toContain('示例数据');
  expect(screen.getByRole('img', { name: '示例影像预览' })).toBeTruthy();
  expect(screen.getByText('暂无示例预览')).toBeTruthy();
});

test('切换只发意图，卡片不是链接或按钮，回收站不可操作', () => {
  const onViewChange = jest.fn();
  render(h(TeamPage, { ...props, onViewChange }));
  fireEvent.click(screen.getByRole('button', { name: '团队任务' }));
  expect(onViewChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '最近任务' }));
  expect(onViewChange).toHaveBeenCalledWith('recent');
  for (const card of screen.getAllByRole('article')) {
    expect(card.hasAttribute('tabindex')).toBe(false);
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).queryByRole('link')).toBeNull();
    fireEvent.click(card);
  }
  expect(onViewChange).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole('button', { name: '回收站（暂未开放）' }) as HTMLButtonElement).disabled
  ).toBe(true);
  expect(screen.queryByText('退出登录')).toBeNull();
});

test('成员插槽处于团队空间左侧，通知留在侧栏，不复制成员组件', () => {
  render(
    h(TeamPage, {
      ...props,
      memberSlot: h('button', null, '成员插槽'),
      notificationSlot: h('button', null, '通知插槽'),
    })
  );
  const nav = screen.getByLabelText('团队空间导航');
  expect(within(nav).getByText('成员插槽')).toBeTruthy();
  expect(within(nav).queryByText('通知插槽')).toBeNull();
  expect(screen.getByLabelText('团队侧栏').contains(screen.getByText('通知插槽'))).toBe(true);
  expect(within(nav).queryByText('团队空间')).toBeNull();
});

test('recent 使用对应标题和集合，不附加团队页标题；刷新仅发读取意图', () => {
  const onRefresh = jest.fn();
  render(h(TeamPage, { ...props, view: 'recent', onRefresh }));
  expect(screen.getByRole('heading', { name: '最近任务' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: team.name })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新列表' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('loading 与 error 不伪造零条成功，错误可重试', () => {
  const onRefresh = jest.fn();
  const { rerender } = render(h(TeamPage, { ...props, state: { status: 'loading' }, onRefresh }));
  expect(screen.getByRole('status').textContent).toContain('加载');
  expect(screen.queryByLabelText('任务数量')).toBeNull();
  rerender(h(TeamPage, { ...props, state: { status: 'error', message: '读取失败' }, onRefresh }));
  expect(screen.getByRole('alert').textContent).toContain('读取失败');
  expect(screen.queryByText('暂无任务')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('合法空集合才显示零条成功', () => {
  render(
    h(TeamPage, { ...props, state: { status: 'ready', data: { items: [], total: 0, mock: true } } })
  );
  expect(screen.getByLabelText('任务数量').textContent).toBe('0');
  expect(screen.getByRole('status').textContent).toContain('暂无任务');
});

test.each(['team', 'recent'] as const)('标题栏在刷新后呈现创建入口，列表错误时仍保留：%s', view => {
  const createTaskSlot = h('button', null, '创建新任务');
  const { rerender } = render(
    h(TeamPage, { ...props, view, onRefresh: jest.fn(), createTaskSlot })
  );
  const refresh = screen.getByRole('button', { name: '刷新列表' });
  const create = screen.getByRole('button', { name: '创建新任务' });
  expect(refresh.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender(
    h(TeamPage, { ...props, view, createTaskSlot, state: { status: 'error', message: '读取失败' } })
  );
  expect(screen.getByRole('button', { name: '创建新任务' })).toBeTruthy();
});

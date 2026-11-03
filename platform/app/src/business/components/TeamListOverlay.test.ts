import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BusinessTeamMembership } from '@ohif/core';
import TeamListOverlay from './TeamListOverlay';

const h = React.createElement;
const ownedTeam: BusinessTeamMembership = {
  team_id: 'team-real',
  name: '与用户名不同的真实团队',
  owner_uid: 'user-real',
  role: 'owner',
};
const props = () => ({
  contentRef: React.createRef<HTMLDivElement>(),
  suppressCloseFocusRef: { current: false },
});
const open = () => fireEvent.click(screen.getByRole('menuitem', { name: '查看你的团队' }));
afterEach(cleanup);

test('真实团队是唯一勾选首行，示例只展示且所有团队均不可切换', () => {
  render(h(TeamListOverlay, { ...props(), ownedTeam }));
  open();
  const menu = screen.getByRole('menu', { name: '团队列表' });
  const rows = within(menu).getAllByRole('menuitemradio');
  expect(rows[0].textContent).toContain(ownedTeam.name);
  expect(rows.filter(row => row.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  expect(within(rows[0]).getByLabelText('当前团队')).toBeTruthy();
  expect(rows.length).toBeGreaterThan(1);
  rows.forEach(row => {
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });
  expect(within(menu).getByText('示例团队，仅展示，不可切换')).toBeTruthy();
});

test('没有 ownedTeam 时保留旧占位团队内容与可访问标签', () => {
  render(h(TeamListOverlay, props()));
  open();
  const menu = screen.getByRole('menu', { name: '团队列表（占位）' });
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
  expect(within(menu).getByText('示例团队，仅供界面预览')).toBeTruthy();
  expect(within(menu).queryByRole('menuitemradio')).toBeNull();
});

test('展开后接收新的会话团队展示，不沿用旧名称或改写团队标识', () => {
  const refs = props();
  const { rerender } = render(h(TeamListOverlay, { ...refs, ownedTeam }));
  open();
  rerender(h(TeamListOverlay, { ...refs, ownedTeam: { ...ownedTeam, name: '更新后的团队' } }));
  const menu = screen.getByRole('menu', { name: '团队列表' });
  expect(within(menu).queryByText(ownedTeam.name)).toBeNull();
  expect(within(menu).getAllByRole('menuitemradio')[0].textContent).toContain('更新后的团队');
  expect(ownedTeam.team_id).toBe('team-real');
});

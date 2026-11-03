import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessTopBar from './BusinessTopBar';
import { createBusinessServices } from '../createBusinessServices';
import type { BusinessServices } from '@ohif/core';
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });

const h = React.createElement;
const snapshot = {
  status: 'authenticated' as const,
  currentTeamId: 't',
  error: null,
  context: {
    user: { uid: 'u', username: '用户', avatar_url: null },
    expires_at: '2099-01-01',
    default_team_id: 't',
    memberships: [],
  },
};
function services(): BusinessServices {
  return {
    api: { request: jest.fn() },
    session: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      validateCurrent: jest.fn(),
      register: jest.fn(),
      login: jest.fn(),
      invalidate: jest.fn(),
    },
  };
}
afterEach(cleanup);

test.each(['import', 'viewer'] as const)('%s 顶部入口严格按页面区分，不含品牌和新增返回', page => {
  render(h(BusinessTopBar, { page, services: services() }));
  expect(
    screen
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label') || button.textContent)
  ).toEqual(page === 'import' ? ['成员', '通知'] : ['成员', '通知', '邀请']);
  expect(screen.queryByText(/OHIF|Open Health/)).toBeNull();
  expect(screen.queryByRole('button', { name: /返回/ })).toBeNull();
});

test('失效会话不再渲染个人信息或业务入口', () => {
  const container = services();
  const invalid = { status: 'invalid' as const, context: null, currentTeamId: null, error: null };
  container.session.getSnapshot = () => invalid;
  render(h(BusinessTopBar, { page: 'viewer', services: container }));
  expect(screen.queryByRole('button', { name: '成员' })).toBeNull();
});

test('服务工厂仅在开关启用时提供 typed UI，不另建会话，未启用时不接入', () => {
  const active = createBusinessServices({ enabled: true }, { storage: null });
  expect(active.ui?.renderHeader({ page: 'viewer' })).toBeTruthy();
  expect(active.session.getSnapshot().status).toBe('unknown');
  expect(createBusinessServices({ enabled: false }, { storage: null }).ui).toBeUndefined();
});

test('顶部点击和文件投放隔离外层返回／Dropzone', () => {
  const click = jest.fn(),
    drop = jest.fn();
  render(
    h(
      'div',
      { onClick: click, onDrop: drop },
      h(BusinessTopBar, { page: 'import', services: services() })
    )
  );
  const toolbar = screen.getByRole('toolbar');
  fireEvent.click(toolbar);
  expect(fireEvent.drop(toolbar)).toBe(false);
  expect(click).not.toHaveBeenCalled();
  expect(drop).not.toHaveBeenCalled();
});

test('mock 工厂缓存同 uid 的故障／防重状态并隔离不同发起者', () => {
  sessionStorage.clear();
  const container = createBusinessServices(
    { enabled: true },
    { storage: sessionStorage, clock: () => 1000000 }
  );
  const user = { uid: 'a', username: 'owner', avatar_url: null };
  const first = container.collaborationMock!.forUser(user);
  first.invite('陈晨');
  expect(container.collaborationMock!.forUser({ ...user })).toBe(first);
  expect(container.collaborationMock!.forUser({ ...user, uid: 'b' }).list()).toEqual([]);
});

test('浏览器禁用 sessionStorage 时真实服务仍存在，mock fail-closed', () => {
  const access = jest.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new Error('storage denied');
  });
  try {
    const container = createBusinessServices({ enabled: true });
    expect(container.teamInvitations).toBeTruthy();
    expect(
      container
        .collaborationMock!.forUser({ uid: 'u', username: 'user', avatar_url: null })
        .getError()
    ).toBeTruthy();
  } finally {
    access.mockRestore();
  }
});

const sharedTask = '12345678-1234-1234-1234-123456789abc';
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function sharingServices(): BusinessServices {
  const container = services();
  container.localCollaboration = {
    publisher: { subscribe: () => () => {} },
    identities: {
      getSource: () => ({
        task_id: sharedTask,
        getSnapshot: () => ({ publication_phase: 'ready' }),
      }),
    },
    participation: { getSnapshot: () => ({ phase: 'active' }) },
  } as unknown as BusinessServices['localCollaboration'];
  return container;
}
function sharingTopbar() {
  return render(
    h(
      MemoryRouter,
      { basename: '/viewer-base', initialEntries: ['/viewer-base/segmentation/dicomlocal'] },
      h(BusinessTopBar, { page: 'viewer', services: sharingServices() })
    )
  );
}
afterEach(() => {
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test('共享入口点击复制同源完整URL及basename，不生成新开页链接', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  sharingTopbar();
  expect(screen.queryByRole('link', { name: '共享链接' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '共享链接' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      `http://localhost/viewer-base/local-shared?task_id=${sharedTask}`
    )
  );
  expect(await screen.findByText('已复制')).toBeTruthy();
});

test.each(['rejected', 'unavailable'])(
  '剪贴板%s时不伪报成功，提供完整地址手动复制并可重试',
  async mode => {
    const writeText = jest.fn().mockRejectedValue(new Error('不能显示原始错误'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: mode === 'unavailable' ? undefined : { writeText },
    });
    sharingTopbar();
    fireEvent.click(screen.getByRole('button', { name: '共享链接' }));
    expect((await screen.findByRole('alert')).textContent).toContain('复制失败');
    expect(screen.queryByText('已复制')).toBeNull();
    expect((screen.getByLabelText('共享地址（手动复制）') as HTMLInputElement).value).toBe(
      `http://localhost/viewer-base/local-shared?task_id=${sharedTask}`
    );
    expect(screen.queryByText('不能显示原始错误')).toBeNull();
    const retry = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: retry },
    });
    fireEvent.click(screen.getByRole('button', { name: '共享链接' }));
    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  }
);

import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import type { BusinessSession, BusinessSessionSnapshot } from '@ohif/core';
import BusinessAuthGate, { requiresBusinessAuth } from './BusinessAuthGate';

let mockServices;
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => ({ servicesManager: { services: { businessServices: mockServices } } }),
  }),
  { virtual: true }
);
const h = React.createElement;
const snapshot = (status: BusinessSessionSnapshot['status']): BusinessSessionSnapshot => ({
  status,
  context: null,
  currentTeamId: null,
  error: null,
});
function fixture() {
  let value = snapshot('unknown');
  const listeners = new Set<() => void>();
  const session: BusinessSession = {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validateCurrent: jest.fn().mockResolvedValue(snapshot('authenticated')),
    register: jest.fn(),
    login: jest.fn(),
    invalidate: jest.fn(),
  };
  return {
    session,
    publish: (status: BusinessSessionSnapshot['status']) => {
      value = snapshot(status);
      listeners.forEach(fn => fn());
    },
  };
}
function Navigation() {
  const navigate = useNavigate(),
    location = useLocation();
  return h(
    'div',
    null,
    h('span', { 'data-testid': 'location' }, location.pathname),
    h('button', { onClick: () => navigate('/away') }, '离开'),
    h('button', { onClick: () => navigate('/local-mask') }, '进入'),
    h('button', { onClick: () => navigate(-1) }, '后退')
  );
}
function mount(session?: BusinessSession, preserve = false, enabled = true) {
  return render(
    h(
      MemoryRouter,
      { initialEntries: ['/local-mask'] },
      h(Navigation),
      h(
        Routes,
        null,
        h(Route, {
          path: '/local-mask',
          element: h(
            BusinessAuthGate,
            { enabled, session, preservePageOnInvalidation: preserve },
            h('p', null, '受保护内容')
          ),
        }),
        h(Route, { path: '/away', element: h('p', null, '原生入口') }),
        h(Route, { path: '/account/login', element: h('p', null, '登录目标') })
      )
    )
  );
}
afterEach(() => {
  cleanup();
  mockServices = undefined;
});

test('进入时必须等待真实current结果，不能先渲染再补鉴权', async () => {
  const f = fixture();
  let done: (value: BusinessSessionSnapshot) => void;
  (f.session.validateCurrent as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      done = resolve;
    })
  );
  mount(f.session);
  expect(screen.queryByText('受保护内容')).toBeNull();
  await act(async () => {
    done!(snapshot('authenticated'));
  });
  expect(screen.getByText('受保护内容')).toBeTruthy();
});

test('无效身份固定去account/login；网络失败留在门禁并允许重试', async () => {
  const f = fixture();
  (f.session.validateCurrent as jest.Mock).mockResolvedValueOnce(snapshot('invalid'));
  mount(f.session);
  expect(await screen.findByText('登录目标')).toBeTruthy();
  cleanup();
  (f.session.validateCurrent as jest.Mock)
    .mockResolvedValueOnce(snapshot('error'))
    .mockResolvedValueOnce(snapshot('authenticated'));
  mount(f.session);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('受保护内容')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('受保护内容')).toBeTruthy();
});

test('每次路由重入与后退都重新检查，不复用之前的放行', async () => {
  const f = fixture();
  mount(f.session);
  await screen.findByText('受保护内容');
  fireEvent.click(screen.getByText('离开'));
  await screen.findByText('原生入口');
  fireEvent.click(screen.getByText('进入'));
  await screen.findByText('受保护内容');
  fireEvent.click(screen.getByText('离开'));
  await screen.findByText('原生入口');
  fireEvent.click(screen.getByText('后退'));
  await screen.findByText('受保护内容');
  expect(f.session.validateCurrent).toHaveBeenCalledTimes(3);
});

test('离开后的迟到结果不能渲染原受保护页面', async () => {
  const f = fixture();
  let done: (value: BusinessSessionSnapshot) => void;
  (f.session.validateCurrent as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      done = resolve;
    })
  );
  mount(f.session);
  fireEvent.click(screen.getByText('离开'));
  await screen.findByText('原生入口');
  await act(async () => {
    done!(snapshot('authenticated'));
  });
  expect(screen.queryByText('受保护内容')).toBeNull();
});

test('标注页进入后身份失效只提示，不专项强跳；重新进入仍须验证', async () => {
  const f = fixture();
  mount(f.session, true);
  await screen.findByText('受保护内容');
  act(() => f.publish('invalid'));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText('受保护内容')).toBeTruthy();
  expect(screen.getByTestId('location').textContent).toBe('/local-mask');
  (f.session.validateCurrent as jest.Mock).mockResolvedValue(snapshot('invalid'));
  fireEvent.click(screen.getByText('离开'));
  await screen.findByText('原生入口');
  fireEvent.click(screen.getByText('进入'));
  expect(await screen.findByText('登录目标')).toBeTruthy();
});

test('关闭开关不触碰业务身份；开关开启但容器缺失必须拒绝', () => {
  const f = fixture();
  mount(f.session, false, false);
  expect(screen.getByText('受保护内容')).toBeTruthy();
  expect(f.session.validateCurrent).not.toHaveBeenCalled();
  cleanup();
  mount();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.queryByText('受保护内容')).toBeNull();
});

test('mask范围与原生Local、远端模式及microscopy标记边界精确', () => {
  for (const path of [
    '/local-mask',
    '/local-mask/',
    '/account/invite',
    '/team/tasks',
    '/team/recent',
    '/segmentation/dicomlocal',
  ]) {
    expect(requiresBusinessAuth(path, undefined)).toBe(true);
  }
  expect(requiresBusinessAuth('/segmentation', 'dicomlocal')).toBe(true);
  for (const path of [
    '/local',
    '/localbasic',
    '/viewer/dicomlocal',
    '/segmentation/remote',
    '/microscopy/dicomlocal',
    '/login',
    '/logout',
  ]) {
    expect(requiresBusinessAuth(path, 'remote')).toBe(false);
  }
  expect(requiresBusinessAuth('/segmentation', 'remote')).toBe(false);
  expect(requiresBusinessAuth('/microscopy/dicomlocal', undefined, { phaseOneMask: true })).toBe(
    true
  );
  expect(requiresBusinessAuth('/microscopy', undefined, undefined, { phaseOneMask: true })).toBe(
    true
  );
});

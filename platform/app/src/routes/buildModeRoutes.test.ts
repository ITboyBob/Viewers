import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import buildModeRoutes from './buildModeRoutes';
let mockEnabled = true,
  mockSource: string | undefined = 'dicomlocal';
jest.mock(
  '@state',
  () => ({
    useAppConfig: () => [
      { phaseOneBusiness: { enabled: mockEnabled }, defaultDataSourceName: 'dicomlocal' },
    ],
  }),
  { virtual: true }
);
jest.mock('@ohif/core', () => ({ useSystem: () => ({ servicesManager: { services: {} } }) }), {
  virtual: true,
});
jest.mock(
  '@routes/Mode',
  () => ({
    __esModule: true,
    default: ({ phaseOneMask }: { phaseOneMask: boolean }) => {
      const React = jest.requireActual('react');
      return React.createElement('span', { 'data-testid': 'mode-marker' }, String(phaseOneMask));
    },
  }),
  { virtual: true }
);
let mockBusiness: any;
const h = React.createElement;
beforeEach(() => {
  mockBusiness = undefined;
  mockEnabled = true;
  mockSource = 'dicomlocal';
});
afterEach(cleanup);
function routes() {
  return buildModeRoutes({
    modes: [{ routeName: 'segmentation' }, { routeName: 'microscopy' }],
    dataSources: [
      { sourceName: 'dicomlocal' },
      { sourceName: 'pacs' },
      { sourceName: 'dicomlocal' },
    ],
    extensionManager: {
      getActiveDataSourceDefinition: () => (mockSource ? { sourceName: mockSource } : null),
    },
    servicesManager: {
      services: { businessServices: mockBusiness ?? { projectRuntime: { phaseOneMask: false } } },
    },
    commandsManager: {},
    hotkeysManager: {},
  } as unknown as Parameters<typeof buildModeRoutes>[0]);
}
function open(path: string, url: string, state?: unknown) {
  const entry = routes().find(route => route.path === path);
  const location = new URL(url, 'http://test');
  return render(
    h(
      MemoryRouter,
      { initialEntries: [{ pathname: location.pathname, search: location.search, state }] },
      h(entry.children)
    )
  );
}
test('去重数据源且保留每个mode显式和活动数据源入口', () => {
  const entries = routes();
  expect(entries).toHaveLength(6);
  expect(entries.map(route => route.path)).toContain('segmentation');
});
test.each([
  ['segmentation/dicomlocal', '/segmentation/dicomlocal', true],
  ['segmentation/pacs', '/segmentation/pacs', false],
  ['microscopy/dicomlocal', '/microscopy/dicomlocal', false],
])('入口%s只给业务模式传标记', (path, url, expected) => {
  open(path, url);
  expect(screen.getByTestId('mode-marker').textContent).toBe(String(expected));
});
test('带业务state的SM进入microscopy，原生SM不凭本地数据源自动变业务', () => {
  open('microscopy/dicomlocal', '/microscopy/dicomlocal', { phaseOneMask: true });
  expect(screen.getByTestId('mode-marker').textContent).toBe('true');
});
test('活动数据源优先于默认源，缺失时回退；关闭开关不传业务标记', () => {
  mockSource = 'pacs';
  const one = open('segmentation', '/segmentation');
  expect(screen.getByTestId('mode-marker').textContent).toBe('false');
  one.unmount();
  mockSource = undefined;
  const two = open('segmentation', '/segmentation');
  expect(screen.getByTestId('mode-marker').textContent).toBe('true');
  two.unmount();
  mockEnabled = false;
  open('segmentation/dicomlocal', '/segmentation/dicomlocal');
  expect(screen.getByTestId('mode-marker').textContent).toBe('false');
});
test('刷新或旧URL缺少内存project时提示重新导入，同时保留原生Mode入口', () => {
  open('segmentation/dicomlocal', '/segmentation/dicomlocal');
  expect(screen.getByRole('status').textContent).toContain('请重新导入');
  expect(screen.getByTestId('mode-marker')).toBeTruthy();
});

test('已显示的存储工作台失效后不进入假加载、不重新读取且保留禁用的原页面', () => {
  const task = '10000000-0000-4000-8000-000000000001';
  let current: any = { task_id: task, source_stored: true };
  let emit = () => {};
  const request = jest.fn();
  mockBusiness = {
    projectRuntime: { phaseOneMask: true, getCurrent: () => current },
    localProjects: {
      subscribe: (fn: () => void) => {
        emit = fn;
        return () => {};
      },
    },
    taskStorage: { open: request },
  };
  const view = open('segmentation/dicomlocal', `/segmentation/dicomlocal?task_id=${task}`);
  const marker = screen.getByTestId('mode-marker');
  current = null;
  act(() => emit());
  expect(screen.queryByText('正在从后端加载任务…')).toBeNull();
  expect(screen.getByTestId('mode-marker')).toBe(marker);
  expect(marker.closest('[inert]')).not.toBeNull();
  expect(request).not.toHaveBeenCalled();
  const shortcut = jest.fn();
  document.addEventListener('keydown', shortcut);
  fireEvent.keyDown(document, { key: 'i' });
  expect(shortcut).not.toHaveBeenCalled();
  view.unmount();
  fireEvent.keyDown(document, { key: 'i' });
  expect(shortcut).toHaveBeenCalledTimes(1);
  document.removeEventListener('keydown', shortcut);
});

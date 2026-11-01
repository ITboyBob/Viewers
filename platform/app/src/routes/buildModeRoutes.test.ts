import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
const h = React.createElement;
beforeEach(() => {
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
      services: { businessServices: { projectRuntime: { phaseOneMask: false } } },
    },
    commandsManager: {},
    hotkeysManager: {},
  } as unknown as Parameters<typeof buildModeRoutes>[0]);
}
function open(path: string, url: string, state?: unknown) {
  const entry = routes().find(route => route.path === path);
  return render(h(MemoryRouter, { initialEntries: [{ pathname: url, state }] }, h(entry.children)));
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

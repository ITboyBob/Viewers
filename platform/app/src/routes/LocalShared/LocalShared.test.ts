import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LocalShared, { sharedTaskFromSearch } from './LocalShared';
import { requiresBusinessAuth } from '../../business/BusinessAuthGate';
let mockMountedGenerations: number[] = [];
beforeEach(() => {
  mockMountedGenerations = [];
});
jest.mock(
  '@routes/Mode',
  () => {
    const React = jest.requireActual('react');
    return {
      __esModule: true,
      default: function MockMode(props: { sharedView: { load_generation: number } }) {
        const generation = React.useRef(props.sharedView.load_generation);
        React.useEffect(() => {
          mockMountedGenerations.push(generation.current);
        }, []);
        return React.createElement('div', { 'data-testid': 'shared-native' });
      },
    };
  },
  { virtual: true }
);
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });
const task = '00000000-0000-4000-8000-000000000001';
afterEach(cleanup);
test('同路由显式重入的新load_generation必须重新创建native生命周期', async () => {
  let state = {
    task_id: task,
    mode_path: 'segmentation/dicomlocal',
    phase: 'active',
    view_ready: false,
    load_generation: 1,
  };
  let changed = () => undefined;
  const service = {
    open: jest.fn(async () => undefined),
    dispose: jest.fn(),
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      changed = callback;
      return () => undefined;
    },
  };
  const props = {
    modes: [{ routeName: 'segmentation' }],
    servicesManager: {
      services: { businessServices: { localCollaboration: { sharedView: service } } },
    },
  } as never;
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}`] },
      React.createElement(LocalShared, props)
    )
  );
  await act(async () => {});
  act(() => {
    state = { ...state, load_generation: 2 };
    changed();
  });
  expect(mockMountedGenerations).toEqual([1, 2]);
});
test('active等待原生画面，ready与detached保留viewer，自身invalid仅保留已完成画面', async () => {
  let state = {
    task_id: task,
    mode_path: 'segmentation/dicomlocal',
    phase: 'active',
    view_ready: false,
    title: '原任务',
  };
  let changed: () => void = () => undefined;
  const service = {
    open: jest.fn(async () => undefined),
    dispose: jest.fn(),
    getSnapshot: () => state,
    subscribe: (callback: () => void) => {
      changed = callback;
      return () => undefined;
    },
  };
  const props = {
    modes: [{ routeName: 'segmentation' }],
    servicesManager: {
      services: { businessServices: { localCollaboration: { sharedView: service } } },
    },
  } as never;
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}`] },
      React.createElement(LocalShared, props)
    )
  );
  await act(async () => {});
  expect(screen.getByTestId('shared-native')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('正在加载');
  act(() => {
    state = { ...state, view_ready: true };
    changed();
  });
  expect(screen.getByRole('status').textContent).toContain('已进入共享：原任务');
  act(() => {
    state = { ...state, phase: 'detached' };
    changed();
  });
  expect(screen.getByRole('status').textContent).toContain('源窗口已离开');
  expect(screen.getByTestId('shared-native')).toBeTruthy();
  act(() => {
    state = { ...state, phase: 'invalid' };
    changed();
  });
  expect(screen.getByRole('alert').textContent).toContain('身份已失效');
  expect(screen.getByTestId('shared-native')).toBeTruthy();
  act(() => {
    state = { ...state, phase: 'disposed', view_ready: false };
    changed();
  });
  expect(screen.queryByTestId('shared-native')).toBeNull();
  expect(screen.getByRole('button', { name: '重试共享加载' })).toBeTruthy();
});
test('缺少可用原模式或hash参数时关闭入口，不将URL参数传给原生viewer', async () => {
  const service = {
    open: jest.fn(async () => undefined),
    dispose: jest.fn(),
    getSnapshot: () => ({
      task_id: task,
      mode_path: 'microscopy',
      phase: 'active',
      view_ready: false,
    }),
    subscribe: () => () => undefined,
  };
  const props = {
    modes: [],
    servicesManager: {
      services: { businessServices: { localCollaboration: { sharedView: service } } },
    },
  } as never;
  const first = render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}#token=x`] },
      React.createElement(LocalShared, props)
    )
  );
  expect(service.open).not.toHaveBeenCalled();
  first.unmount();
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}`] },
      React.createElement(LocalShared, props)
    )
  );
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('模式不可用');
  expect(service.dispose).toHaveBeenCalled();
  expect(screen.queryByTestId('shared-native')).toBeNull();
});
test('共享入口必须受业务守卫，参数只接受单个合法task_id', () => {
  expect(requiresBusinessAuth('/local-shared')).toBe(true);
  expect(sharedTaskFromSearch(`?task_id=${task}`)).toBe(task);
  for (const search of [
    '',
    '?task_id=bad',
    `?task_id=${task}&token=x`,
    `?task_id=${task}&task_id=${task}`,
    `?task_id=${task}&returnUrl=https://example.com`,
  ]) {
    expect(sharedTaskFromSearch(search)).toBeNull();
  }
});
test('非法参数和缺少容器拒绝加载；失败允许显式重试，离开清理本次加载', async () => {
  const service = {
    open: jest.fn(async () => {
      throw new Error('源不可用');
    }),
    dispose: jest.fn(),
    getSnapshot: () => null,
    subscribe: () => () => undefined,
  };
  const props = {
    modes: [],
    servicesManager: {
      services: { businessServices: { localCollaboration: { sharedView: service } } },
    },
  } as never;
  const invalid = render(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/local-shared?task_id=bad'] },
      React.createElement(LocalShared, props)
    )
  );
  expect(screen.getByRole('alert').textContent).toContain('任务');
  expect(service.open).not.toHaveBeenCalled();
  invalid.unmount();
  const view = render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}`] },
      React.createElement(LocalShared, props)
    )
  );
  await act(async () => {});
  expect(service.open).toHaveBeenCalledWith(task);
  expect(screen.getByRole('alert').textContent).toContain('源不可用');
  fireEvent.click(screen.getByRole('button', { name: '重试共享加载' }));
  await act(async () => {});
  expect(service.open).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(service.dispose).toHaveBeenCalled();
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/local-shared?task_id=${task}`] },
      React.createElement(LocalShared, { ...props, servicesManager: { services: {} } } as never)
    )
  );
  expect(screen.getByRole('alert').textContent).toContain('服务');
});

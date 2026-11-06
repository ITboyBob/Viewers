import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ModeRoute from './Mode';
import { ProjectRuntimeService } from '../../business/ProjectRuntimeService';
import { PubSubService } from '../../../../core/src/services/_shared/pubSubServiceInterface';
import { defaultRouteInit } from './defaultRouteInit';
jest.mock(
  '@ohif/core',
  () => ({ utils: jest.requireActual('../../../../core/src/utils/splitComma') }),
  { virtual: true }
);
jest.mock('@state', () => ({ useAppConfig: () => [{}] }), { virtual: true });
jest.mock(
  '@ohif/ui-next',
  () => ({
    ImageViewerProvider: ({ children }) => children,
    DragAndDropProvider: ({ children }) => children,
  }),
  { virtual: true }
);
jest.mock('@components/ViewportGrid', () => () => null, { virtual: true });
jest.mock('../../pluginImports', () => ({ __esModule: true, default: async () => [] }), {
  virtual: true,
});
jest.mock('../../hooks', () => ({ useSearchParams: () => new URLSearchParams() }));
jest.mock('./defaultRouteInit', () => ({ defaultRouteInit: jest.fn() }));
let props,
  runtime: ProjectRuntimeService,
  events: string[],
  measurement,
  segmentation,
  touch: jest.Mock;
let errors: jest.SpyInstance, warnings: jest.SpyInstance;
const h = React.createElement;
const broadcast = () => measurement._broadcastEvent('measurement', {});
const flush = async () => {
  for (let n = 0; n < 20; n++) {
    await Promise.resolve();
  }
};
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});
  measurement = new PubSubService({ UPDATE: 'measurement' });
  segmentation = new PubSubService({ UPDATE: 'segmentation' });
  [measurement, segmentation].forEach(service => {
    const subscribe = service.subscribe.bind(service);
    service.subscribe = (event, listener) => {
      events.push('subscribe');
      const sub = subscribe(event, listener);
      return {
        unsubscribe: () => {
          events.push('unsubscribe');
          sub.unsubscribe();
        },
      };
    };
  });
  const project = {
    batch_id: 'b',
    task_id: 'real',
    importer_uid: 'importer',
    viewer_uid: 'importer',
    phase: 'registered',
    mode_path: 'segmentation/dicomlocal',
    successes: [],
    study_uids: ['1'],
  };
  touch = jest.fn().mockImplementation((_p, signal) => {
    events.push('touch');
    signal.addEventListener('abort', () => events.push('abort'));
    return new Promise(() => {});
  });
  runtime = new ProjectRuntimeService(
    {
      isCurrent: () => true,
      getCurrent: () => project,
      dispose: () => events.push('files-release'),
      subscribe: () => () => {},
      updateTimestamp: jest.fn(),
    } as never,
    { touch } as never
  );
  runtime.bind(project as never, {
    activate: jest.fn(),
    isActive: () => true,
    release: () => events.push('scope-release'),
  });
  const route = {
    layoutTemplate: async () => ({ id: 'layout', props: {} }),
    init: jest.fn(async () => {
      events.push('route-init');
      broadcast();
      return [() => events.push('route-unsubscribe')];
    }),
  };
  const dataSource = { initialize: async () => {}, getStudyInstanceUIDs: () => ['1'] };
  props = {
    phaseOneMask: true,
    dataSourceName: 'dicomlocal',
    mode: {
      extensions: {},
      sopClassHandlers: [],
      routes: [route],
      onModeEnter: jest.fn(),
      onSetupRouteComplete: jest.fn(),
      onModeExit: () => {
        events.push('mode-destroy');
        broadcast();
      },
    },
    servicesManager: {
      services: {
        measurementService: measurement,
        segmentationService: segmentation,
        businessServices: { projectRuntime: runtime },
        displaySetService: { init: jest.fn() },
        panelService: {
          reset: jest.fn(),
          addPanels: jest.fn(),
          PanelPosition: { Left: 'left', Right: 'right' },
        },
        hangingProtocolService: {
          getProtocolById: () => null,
          getStageIndex: () => 0,
          setActiveProtocolIds: jest.fn(),
        },
        customizationService: { getCustomization: jest.fn() },
      },
    },
    extensionManager: {
      getRegisteredExtensionIds: () => [],
      setActiveDataSource: jest.fn(),
      getActiveDataSourceOrNull: () => dataSource,
      onModeEnter: jest.fn(),
      onModeExit: () => {
        events.push('extension-destroy');
        broadcast();
      },
      getModulesByType: () => [],
      constructor: { MODULE_TYPES: { CONTEXT: 'context' } },
      getModuleEntry: () => ({ component: () => h('div', null, '工作台') }),
    },
    commandsManager: {},
    hotkeysManager: { setDefaultHotKeys: jest.fn(), destroy: () => events.push('hotkeys') },
  };
  (defaultRouteInit as jest.Mock).mockImplementation(async () => {
    events.push('default-init');
    broadcast();
    return [() => events.push('native-unsubscribe')];
  });
});
afterEach(() => {
  cleanup();
  runtime.getModeLifecycle()?.dispose();
  errors.mockRestore();
  warnings.mockRestore();
});
const mount = () => render(h(MemoryRouter, null, h(ModeRoute, props)));
test('初始化静默；就绪后事件触发请求，退出按序清理', async () => {
  const view = mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  expect(touch).not.toHaveBeenCalled();
  expect(measurement.listeners.measurement).toHaveLength(1);
  expect(segmentation.listeners.segmentation).toHaveLength(1);
  for (const event of ['route-init', 'default-init', 'subscribe']) {
    expect(events).toContain(event);
  }
  expect(events.indexOf('route-init')).toBeLessThan(events.indexOf('subscribe'));
  expect(events.indexOf('default-init')).toBeLessThan(events.indexOf('subscribe'));
  act(broadcast);
  expect(touch).toHaveBeenCalledTimes(1);
  const signal: AbortSignal = touch.mock.calls[0][1];
  expect(signal.aborted).toBe(false);
  events.length = 0;
  view.unmount();
  await flush();
  expect(events).toEqual([
    'unsubscribe',
    'unsubscribe',
    'abort',
    'mode-destroy',
    'hotkeys',
    'route-unsubscribe',
    'native-unsubscribe',
    'extension-destroy',
    'scope-release',
    'files-release',
  ]);
  broadcast();
  segmentation._broadcastEvent('segmentation', {});
  expect(touch).toHaveBeenCalledTimes(1);
  expect(measurement.listeners.measurement).toHaveLength(0);
  expect(segmentation.listeners.segmentation).toHaveLength(0);
  expect(signal.aborted).toBe(true);
  expect(runtime.getCurrent()).toBeNull();
});
test('route.init晚resolve即刻退订，不能复活桥接或进入defaultRouteInit', async () => {
  let finish;
  const stop = jest.fn();
  props.mode.routes[0].init = jest.fn(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const view = mount();
  await waitFor(() => expect(props.mode.routes[0].init).toHaveBeenCalled());
  view.unmount();
  await act(async () => {
    finish([stop]);
  });
  broadcast();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(defaultRouteInit).not.toHaveBeenCalled();
  expect(touch).not.toHaveBeenCalled();
});
test('defaultRouteInit晚resolve清掉新返回对象，先前route.init回调也不丢', async () => {
  let finish;
  const stop = jest.fn();
  (defaultRouteInit as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const view = mount();
  await waitFor(() => expect(defaultRouteInit).toHaveBeenCalled());
  view.unmount();
  await act(async () => {
    finish([stop]);
  });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(events).toContain('route-unsubscribe');
  expect(events.at(-2)).toBe('scope-release');
});
test('mode退出抛错仍退订、释放并向调用方传播原异常', async () => {
  const exitError = new Error('合成退出故障');
  props.mode.onModeExit = () => {
    events.push('mode-error');
    broadcast();
    throw exitError;
  };
  const view = mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  expect(touch).not.toHaveBeenCalled();
  act(broadcast);
  expect(touch).toHaveBeenCalledTimes(1);
  const signal: AbortSignal = touch.mock.calls[0][1];
  expect(signal.aborted).toBe(false);
  events.length = 0;
  let thrown: unknown;
  try {
    view.unmount();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(exitError);
  await flush();
  expect(events).toEqual([
    'unsubscribe',
    'unsubscribe',
    'abort',
    'mode-error',
    'hotkeys',
    'route-unsubscribe',
    'native-unsubscribe',
    'extension-destroy',
    'scope-release',
    'files-release',
  ]);
  broadcast();
  segmentation._broadcastEvent('segmentation', {});
  expect(touch).toHaveBeenCalledTimes(1);
  expect(measurement.listeners.measurement).toHaveLength(0);
  expect(segmentation.listeners.segmentation).toHaveLength(0);
  expect(signal.aborted).toBe(true);
  expect(runtime.getCurrent()).toBeNull();
});
test('setup异常主动失活、原生退出和释放，不留下业务监听', async () => {
  props.mode.onModeEnter = () => {
    throw new Error('合成初始化故障');
  };
  mount();
  await waitFor(() => expect(events).toContain('scope-release'));
  broadcast();
  expect(touch).not.toHaveBeenCalled();
  expect(measurement.listeners.measurement ?? []).toHaveLength(0);
});
test('StrictMode重复mount和cleanup不会让旧generation复活或遗留订阅', async () => {
  const view = render(h(React.StrictMode, null, h(MemoryRouter, null, h(ModeRoute, props))));
  await act(flush);
  view.unmount();
  broadcast();
  expect(runtime.getCurrent()).toBeNull();
  expect(measurement.listeners.measurement ?? []).toHaveLength(0);
  expect(events.filter(event => event === 'scope-release')).toHaveLength(1);
});
test.each([
  { name: '缺少导入者身份', identity: { importer_uid: undefined } },
  { name: '读取者与导入者不同', identity: { viewer_uid: 'other-user' } },
])('$name时不启动时间桥接或发送请求', async ({ identity }) => {
  Object.assign(runtime.getCurrent(), identity);
  mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  act(() => {
    broadcast();
    segmentation._broadcastEvent('segmentation', {});
  });
  expect(events).not.toContain('subscribe');
  expect(measurement.listeners.measurement ?? []).toHaveLength(0);
  expect(segmentation.listeners.segmentation ?? []).toHaveLength(0);
  expect(touch).not.toHaveBeenCalled();
});

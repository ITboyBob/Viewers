import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LocalProject, LocalProjects } from '@ohif/core';
import ModeRoute from './Mode';
import loadModules from '../../pluginImports';
import { defaultRouteInit } from './defaultRouteInit';
import { ProjectRuntimeService } from '../../business/ProjectRuntimeService';
import store from '../../../../core/src/services/DicomMetadataStore/DicomMetadataStore';
jest.mock(
  '@ohif/core',
  () => ({ utils: jest.requireActual('../../../../core/src/utils/splitComma') }),
  { virtual: true }
);
jest.mock('@state', () => ({ useAppConfig: () => [{ phaseOneBusiness: { enabled: true } }] }), {
  virtual: true,
});
jest.mock(
  '@ohif/ui-next',
  () => ({
    ImageViewerProvider: ({ children }) => children,
    DragAndDropProvider: ({ children }) => children,
  }),
  { virtual: true }
);
jest.mock('@components/ViewportGrid', () => () => null, { virtual: true });
jest.mock('../../pluginImports', () => ({ __esModule: true, default: jest.fn() }), {
  virtual: true,
});
jest.mock('../../hooks', () => ({ useSearchParams: () => new URLSearchParams(mockQuery) }));
jest.mock('./defaultRouteInit', () => ({ defaultRouteInit: jest.fn() }));
const h = React.createElement;
let mockQuery = '';
let runtime: ProjectRuntimeService, events: string[], props;
beforeEach(() => {
  mockQuery = '';
  jest.clearAllMocks();
  events = [];
  (loadModules as jest.Mock).mockResolvedValue([]);
  (defaultRouteInit as jest.Mock).mockResolvedValue([() => events.push('native-unsubscribe')]);
  store.addInstance({ StudyInstanceUID: '9', SeriesInstanceUID: '9.1', SOPInstanceUID: '9.1.1' });
  const scope = store.prepareLocalImportScope('mode-test', [
    { StudyInstanceUID: '1', SeriesInstanceUID: '1.2', SOPInstanceUID: '1.2.3' },
  ]);
  scope.activate();
  const release = scope.release;
  scope.release = () => {
    events.push('scope-release');
    release();
  };
  const project = { task_id: 'real', phase: 'registered' } as LocalProject;
  runtime = new ProjectRuntimeService({
    isCurrent: () => true,
    getCurrent: () => project,
    dispose: () => events.push('files-release'),
  } as unknown as LocalProjects);
  const handle = runtime.bind(project, scope),
    deactivate = handle.deactivate;
  handle.deactivate = () => {
    events.push('deactivate');
    deactivate();
  };
  const dataSource = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getStudyInstanceUIDs: () => ['1'],
  };
  const extensionManager = {
    registeredExtensionIds: [],
    getRegisteredExtensionIds: () => [],
    registerExtension: jest.fn(),
    setActiveDataSource: jest.fn(),
    getActiveDataSourceOrNull: () => dataSource,
    onModeEnter: jest.fn(),
    onModeExit: () => events.push('extension-exit'),
    getModulesByType: () => [],
    constructor: { MODULE_TYPES: { CONTEXT: 'context' } },
    getModuleEntry: () => ({ component: () => h('div', null, '影像工作台') }),
  };
  const servicesManager = {
    services: {
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
  };
  const mode = {
    extensions: {},
    sopClassHandlers: [],
    hangingProtocol: 'test',
    onModeEnter: jest.fn(),
    onModeExit: () => events.push('mode-exit'),
    onSetupRouteComplete: jest.fn(),
    routes: [{ layoutTemplate: async () => ({ id: 'layout', props: {} }) }],
  };
  props = {
    phaseOneMask: true,
    mode,
    dataSourceName: 'dicomlocal',
    servicesManager,
    extensionManager,
    commandsManager: {},
    hotkeysManager: { setDefaultHotKeys: jest.fn(), destroy: () => events.push('hotkeys') },
  };
});
afterEach(() => {
  cleanup();
  runtime.getModeLifecycle()?.dispose();
});
function mount() {
  return render(h(MemoryRouter, null, h(ModeRoute, props)));
}
test('真实Mode卸载显式最前失活，原生退出与退订后finally释放真实scope', async () => {
  const view = mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  events.length = 0;
  view.unmount();
  expect(events).toEqual([
    'deactivate',
    'mode-exit',
    'hotkeys',
    'native-unsubscribe',
    'extension-exit',
    'scope-release',
    'files-release',
  ]);
  expect(store.getStudy('1')).toBeUndefined();
  expect(runtime.getCurrent()).toBeNull();
});
test('扩展尚未加载完成就离开，也必须释放交接scope', async () => {
  let finish;
  (loadModules as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const view = mount();
  view.unmount();
  expect(store.getStudy('1')).toBeUndefined();
  expect(runtime.getCurrent()).toBeNull();
  await act(async () => {
    finish([]);
  });
});
test('route.init晚完成立即退订，不再运行defaultRouteInit或旧完成回调', async () => {
  let finish;
  const unsubscribe = jest.fn();
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
    finish([unsubscribe]);
  });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(defaultRouteInit).not.toHaveBeenCalled();
  expect(props.mode.onSetupRouteComplete).not.toHaveBeenCalled();
  expect(store.getStudy('1')).toBeUndefined();
});
test('原生退出抛错仍完成清理并释放scope', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  props.mode.onModeExit = () => {
    events.push('mode-exit');
    throw new Error('synthetic');
  };
  try {
    const view = mount();
    await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
    expect(() => view.unmount()).toThrow('synthetic');
    expect(events).toContain('native-unsubscribe');
    expect(events).toContain('extension-exit');
    expect(store.getStudy('1')).toBeUndefined();
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test('defaultRouteInit晚返回时先前route.init退订不丢，晚callbacks立即退订', async () => {
  const routeStop = jest.fn(),
    lateStop = jest.fn();
  let finish;
  props.mode.routes[0].init = jest.fn().mockResolvedValue([routeStop]);
  (defaultRouteInit as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const view = mount();
  await waitFor(() => expect(defaultRouteInit).toHaveBeenCalled());
  view.unmount();
  expect(routeStop).toHaveBeenCalledTimes(1);
  expect(store.getStudy('1')).toBeUndefined();
  await act(async () => {
    finish([lateStop]);
  });
  expect(lateStop).toHaveBeenCalledTimes(1);
  expect(routeStop).toHaveBeenCalledTimes(1);
  expect(props.mode.onSetupRouteComplete).not.toHaveBeenCalled();
});
test('原生模式不认领其他业务scope，保留原生退出顺序', async () => {
  runtime.getModeLifecycle().dispose();
  events.length = 0;
  props.phaseOneMask = false;
  const view = mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  events.length = 0;
  view.unmount();
  expect(events).toEqual(['mode-exit', 'hotkeys', 'native-unsubscribe', 'extension-exit']);
});

test('原生上下文provider、扩展注册与URL Token处理保留，不变成业务凭证来源', async () => {
  runtime.getModeLifecycle().dispose();
  props.phaseOneMask = false;
  props.dataSourceName = 'pacs';
  props.mode.routeName = 'viewer';
  mockQuery = 'token=synthetic-native-token&hangingprotocolid=runtime';
  props.servicesManager.services.userAuthenticationService = {
    setServiceImplementation: jest.fn(),
  };
  props.extensionManager.getRegisteredExtensionIds = () => ['already'];
  (loadModules as jest.Mock).mockResolvedValue([{ id: 'already' }, { id: 'new-extension' }]);
  props.extensionManager.getModulesByType = () => [
    { module: [{ provider: ({ children }) => children }] },
  ];
  props.servicesManager.services.hangingProtocolService.getProtocolById = () => ({ id: 'runtime' });
  const view = mount();
  await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
  expect(props.extensionManager.registerExtension).toHaveBeenCalledTimes(1);
  expect(
    props.servicesManager.services.userAuthenticationService.setServiceImplementation.mock.calls[0][0].getAuthorizationHeader()
  ).toEqual({ Authorization: 'Bearer synthetic-native-token' });
  view.unmount();
});
test('原生route.init返回void及退订抛错时，仍清其余callback和scope', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  props.mode.routes[0].init = jest.fn().mockResolvedValue(undefined);
  props.mode.hangingProtocol = ['one', 'two'];
  const second = jest.fn();
  (defaultRouteInit as jest.Mock).mockResolvedValue([
    () => {
      throw new Error('synthetic');
    },
    second,
  ]);
  try {
    const view = mount();
    await waitFor(() => expect(props.mode.onSetupRouteComplete).toHaveBeenCalled());
    view.unmount();
    expect(second).toHaveBeenCalledTimes(1);
    expect(store.getStudy('1')).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

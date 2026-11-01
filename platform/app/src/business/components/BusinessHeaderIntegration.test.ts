import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Local from '../../routes/Local/Local';
import ViewerHeader from '../../../../../extensions/default/src/ViewerLayout/ViewerHeader';

let mockEnabled = true;
const mockHeader = jest.fn(({ page }) => React.createElement('button', null, `业务-${page}`));
const mockSystem = {
  servicesManager: {
    services: {
      businessServices: {
        ui: { renderHeader: mockHeader },
        localProjects: { dispose: jest.fn() },
        tasks: { cancel: jest.fn() },
        projectRuntime: { phaseOneMask: false },
      },
      customizationService: { getCustomization: () => ({}) },
    },
  },
  extensionManager: {
    getDataSources: () => null,
    getActiveDataSourceDefinition: () => ({ sourceName: 'dicomlocal' }),
  },
  commandsManager: { run: jest.fn() },
};
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => mockSystem,
    MODULE_TYPES: { DATA_SOURCE: 'data' },
    DicomMetadataStore: {},
  }),
  { virtual: true }
);
jest.mock(
  '@state',
  () => ({ useAppConfig: () => [{ phaseOneBusiness: { enabled: mockEnabled } }] }),
  { virtual: true }
);
jest.mock('../../App', () => ({
  extensionManager: {
    modules: { data: [{ module: [{ type: 'localApi', createDataSource: () => ({}) }] }] },
    registeredExtensionIds: [],
  },
}));
jest.mock('../../routes/Local/filesToStudies', () => jest.fn());
jest.mock('@ohif/app', () => ({ preserveQueryParameters: () => {} }), { virtual: true });
jest.mock('../../../../../extensions/default/src/Toolbar/Toolbar', () => ({ Toolbar: () => null }));
jest.mock('../../../../../extensions/default/src/ViewerLayout/HeaderPatientInfo', () => () => null);
jest.mock(
  '../../../../../extensions/default/src/ViewerLayout/HeaderPatientInfo/HeaderPatientInfo',
  () => ({ PatientInfoVisibility: { DISABLED: 'disabled' } })
);
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: value => value }) }));
jest.mock(
  '@ohif/ui-next',
  () => {
    const React = jest.requireActual<typeof import('react')>('react');
    return {
      Button: ({ children, ...props }: React.ComponentProps<'button'>) =>
        React.createElement('button', props, children),
      Icons: {
        OHIFLogoColorDarkBackground: () => React.createElement('span', null, '中央原生品牌'),
        Undo: () => null,
        Redo: () => null,
      },
      useModal: () => ({ show: jest.fn() }),
      Header: (props: {
        isReturnEnabled?: boolean;
        onClickReturnButton?: () => void;
        Branding?: React.ReactNode;
        LeftActions?: React.ReactNode;
      }) =>
        React.createElement(
          'header',
          { 'data-testid': 'viewer-header' },
          props.isReturnEnabled &&
            React.createElement('button', { onClick: props.onClickReturnButton }, '原生返回'),
          props.Branding === undefined ? 'OHIF原品牌' : props.Branding,
          props.LeftActions
        ),
    };
  },
  { virtual: true }
);
const h = React.createElement;
function mount(node: React.ReactElement, path = '/local-mask', state?: object) {
  return render(h(MemoryRouter, { initialEntries: [{ pathname: path, state }] }, node));
}
beforeEach(() => {
  mockEnabled = true;
  mockHeader.mockClear();
  mockSystem.servicesManager.services.businessServices.projectRuntime = { phaseOneMask: false };
});
afterEach(cleanup);

test.each([false, true])(
  '共享 Local phaseOneMask=%s 只对限定入口增加顶部，中央卡片保留',
  phaseOneMask => {
    mount(h(Local, { modePath: 'segmentation/dicomlocal', phaseOneMask }));
    expect(screen.queryByText('业务-import') !== null).toBe(phaseOneMask);
    expect(screen.getByText('中央原生品牌')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load files' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load folders' })).toBeTruthy();
  }
);

test('业务开关关闭时，即使传 mask 标记也不挂顶部', () => {
  mockEnabled = false;
  mount(h(Local, { modePath: 'segmentation/dicomlocal', phaseOneMask: true }));
  expect(mockHeader).not.toHaveBeenCalled();
});

test.each(['/segmentation/dicomlocal', '/segmentation', '/microscopy'])(
  '%s mask viewer 保留返回箭头且品牌被 slot 替换',
  path => {
    const state = path === '/microscopy' ? { phaseOneMask: true } : undefined;
    mount(
      h(ViewerHeader, {
        appConfig: {
          showStudyList: false,
          phaseOneBusiness: { enabled: true },
          showPatientInfo: 'disabled',
        },
      }),
      path,
      state
    );
    expect(screen.getByRole('button', { name: '原生返回' })).toBeTruthy();
    expect(screen.getByText('业务-viewer')).toBeTruthy();
    expect(screen.queryByText('OHIF原品牌')).toBeNull();
  }
);

test.each(['/viewer/dicomlocal', '/microscopy'])('原生 %s 不使用业务品牌 slot', path => {
  mount(
    h(ViewerHeader, {
      appConfig: {
        showStudyList: true,
        phaseOneBusiness: { enabled: true },
        showPatientInfo: 'disabled',
      },
    }),
    path
  );
  expect(screen.getByText('OHIF原品牌')).toBeTruthy();
  expect(mockHeader).not.toHaveBeenCalled();
});

test('viewer 关闭业务开关保留原 Header，标记不绕过开关', () => {
  mount(
    h(ViewerHeader, {
      appConfig: {
        showStudyList: false,
        phaseOneBusiness: { enabled: false },
        showPatientInfo: 'disabled',
      },
    }),
    '/segmentation/dicomlocal'
  );
  expect(screen.getByText('OHIF原品牌')).toBeTruthy();
  expect(mockHeader).not.toHaveBeenCalled();
});

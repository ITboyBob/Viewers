import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import DicomMicroscopyViewport from './DicomMicroscopyViewport';

const mockRemove = jest.fn();
const mockAdd = jest.fn(() => ({ addContextMenuCallback: jest.fn() }));
const mockImport = jest.fn();
const mockSourceReady = jest.fn();
const mockViewerReady = jest.fn();
const mockServices = {
  microscopyService: {
    importDicomMicroscopyViewer: mockImport,
    addViewer: mockAdd,
    removeViewer: mockRemove,
    clearAnnotations: jest.fn(),
  },
  customizationService: { getCustomization: () => () => null },
  businessServices: {
    localCollaboration: {
      participation: { identity: { role: 'source' } },
      identities: { getSource: () => ({ setViewReady: mockSourceReady }) },
      sharedView: {
        getSnapshot: () => ({ load_generation: 7, phase: 'disposed' }),
        markViewReady: mockViewerReady,
      },
    },
  },
};
jest.mock(
  '@ohif/core',
  () => ({
    useSystem: () => ({ servicesManager: { services: mockServices }, extensionManager: {} }),
  }),
  { virtual: true }
);
jest.mock(
  '@ohif/extension-default',
  () => ({ cleanDenaturalizedDataset: (value: unknown) => value }),
  { virtual: true }
);
jest.mock('./utils/dicomWebClient', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('./components/ViewportOverlay', () => ({ __esModule: true, default: () => null }));

function sdk() {
  let completed: () => void;
  let container: HTMLElement;
  const instance = {
    [Symbol.for('map')]: {
      on: jest.fn((_event, fn) => {
        completed = fn;
      }),
      un: jest.fn(),
    },
    render: jest.fn((options: { container: HTMLElement }) => {
      container = options.container;
    }),
  };
  const create = jest.fn(() => instance);
  return {
    module: { viewer: { VolumeImageViewer: create }, metadata: {} },
    create,
    instance,
    frame: () => {
      container!.dispatchEvent(
        new CustomEvent('dicommicroscopyviewer_frame_loading_ended', {
          detail: { payload: { pixelArray: new Uint8Array([1]) } },
        })
      );
      completed!();
    },
  };
}
function mount() {
  return render(
    React.createElement(DicomMicroscopyViewport, {
      activeViewportId: 'sm',
      setViewportActive: jest.fn(),
      viewportId: 'sm',
      displaySets: [
        { Modality: 'SM', others: [], instance: {}, StudyInstanceUID: '1', SeriesInstanceUID: '2' },
      ],
      dataSource: { getConfig: () => ({}) },
      resizeRef: { current: null },
    })
  );
}
beforeEach(() => {
  jest.clearAllMocks();
});
test('卸载后SDK迟到不得创建或登记原生viewer，新实例不受旧回调影响', async () => {
  const old = sdk(),
    current = sdk();
  let finish: (value: unknown) => void;
  mockImport.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const first = mount();
  first.unmount();
  mockImport.mockResolvedValueOnce(current.module);
  const second = mount();
  await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1));
  await act(async () => {
    finish!(old.module);
  });
  expect(old.create).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
  second.unmount();
  expect(mockRemove).toHaveBeenCalledTimes(1);
  expect(mockRemove).toHaveBeenCalledWith(current.instance);
});
test('当前安装的viewer按实例清理；source不使用残留viewer代次且等真实完成', async () => {
  const current = sdk();
  mockImport.mockResolvedValueOnce(current.module);
  const view = mount();
  await waitFor(() => expect(mockAdd).toHaveBeenCalledTimes(1));
  expect(mockSourceReady).not.toHaveBeenCalled();
  act(() => current.frame());
  expect(mockSourceReady).toHaveBeenCalledWith(true);
  expect(mockViewerReady).not.toHaveBeenCalled();
  view.unmount();
  expect(mockRemove).toHaveBeenCalledWith(current.instance);
});

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { randomUUID } from 'crypto';
import type { BusinessSession, BusinessSessionSnapshot, ImportSelection } from '@ohif/core';
import Local, { selectionFromDrop } from './Local';
import oldParser from './filesToStudies';
import { LocalProjectService } from '../../business/LocalProjectService';
import { TaskService } from '../../business/TaskService';
import { ProjectRuntimeService } from '../../business/ProjectRuntimeService';
import { BusinessApiError } from '../../business/BusinessApiClient';
import store from '../../../../core/src/services/DicomMetadataStore/DicomMetadataStore';
import { extensionManager } from '../../App';
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID, configurable: true });
let mockServices;
let mockConfig = { phaseOneBusiness: { enabled: true } };
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('@state', () => ({ useAppConfig: () => [mockConfig] }), { virtual: true });
jest.mock(
  '@ohif/core',
  () => ({
    DicomMetadataStore: jest.requireActual(
      '../../../../core/src/services/DicomMetadataStore/DicomMetadataStore'
    ).default,
    MODULE_TYPES: { DATA_SOURCE: 'data' },
    useSystem: () => ({ servicesManager: { services: mockServices } }),
  }),
  { virtual: true }
);
jest.mock('../../App', () => ({
  extensionManager: {
    modules: { data: [{ module: [{ type: 'localApi', createDataSource: () => ({}) }] }] },
    registeredExtensionIds: [],
  },
}));
jest.mock(
  '@ohif/ui-next',
  () => {
    const React = jest.requireActual('react');
    return {
      Button: ({
        children,
        variant: _variant,
        ...props
      }: React.PropsWithChildren<{ variant?: string }>) =>
        React.createElement('button', props, children),
      Icons: { OHIFLogoColorDarkBackground: () => null },
    };
  },
  { virtual: true }
);
jest.mock('./filesToStudies', () => jest.fn().mockResolvedValue(['9']));
const h = React.createElement;
const context = (uid = 'u') =>
  ({
    status: 'authenticated',
    context: {
      user: { uid, username: uid, avatar_url: null },
      expires_at: '2026-11-02T00:00:00Z',
      default_team_id: 'team',
      memberships: [{ team_id: 'team', name: '团队', owner_uid: uid, role: 'owner' }],
    },
    currentTeamId: 'team',
    error: null,
  }) as BusinessSessionSnapshot;
const file = (name = '合成.dcm', path = '') =>
  Object.assign(new File(['synthetic'], name), { webkitRelativePath: path });
let snapshot: BusinessSessionSnapshot,
  listeners: Array<() => void>,
  parse: jest.Mock,
  request: jest.Mock;
const dataset = (name = '') => ({
  StudyInstanceUID: '1',
  SeriesInstanceUID: '1.2',
  SOPInstanceUID: '1.2.3',
  Modality: name === 'sm.dcm' ? 'SM' : 'CT',
  url: 'dicomfile:0',
});
const task = (title = '合成.dcm') => ({
  task_id: '00000000-0000-4000-8000-000000000001',
  team_id: 'team',
  title,
  assignee_uid: 'u',
  metadata: {},
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
});
beforeEach(() => {
  jest.clearAllMocks();
  mockConfig = { phaseOneBusiness: { enabled: true } };
  listeners = [];
  snapshot = context();
  extensionManager.registeredExtensionIds.length = 0;
  store.addInstance({
    StudyInstanceUID: '9',
    SeriesInstanceUID: '9.1',
    SOPInstanceUID: '9.1.1',
    Modality: 'CT',
  });
  parse = jest.fn(async (input: ImportSelection) => {
    const entries = input.files.map((f, i) => ({ file_name: f.name, selection_index: i }));
    return {
      batch_id: randomUUID(),
      kind: input.kind,
      folder_name: input.folderName ?? input.files[0]?.webkitRelativePath?.split('/')[0],
      successes: entries
        .filter(item => !item.file_name.startsWith('坏'))
        .map(item => ({
          ...item,
          image_id: 'dicomfile:0',
          study_uid: '1',
          series_uid: '1.2',
          sop_uid: '1.2.3',
          dataset: dataset(item.file_name),
        })),
      failures: entries
        .filter(item => item.file_name.startsWith('坏'))
        .map(item => ({ ...item, reason: 'PARSE_FAILED' as const })),
      study_uids: ['1'],
    };
  });
  const session = {
    getSnapshot: () => snapshot,
    subscribe: fn => {
      listeners.push(fn);
      return () => {};
    },
  } as unknown as BusinessSession;
  const projects = new LocalProjectService(session, { parse, release: jest.fn() });
  request = jest.fn().mockImplementation(async (_path, options) => task(options.body.title));
  mockServices = {
    customizationService: { getCustomization: () => () => h('span', null, '加载中') },
    businessServices: {
      session,
      localProjects: projects,
      tasks: new TaskService({ request }, projects),
      projectRuntime: new ProjectRuntimeService(projects),
    },
  };
});
afterEach(() => {
  cleanup();
  mockServices.businessServices?.projectRuntime.getHandle()?.releaseScope();
});
function mount(phaseOneMask = true, modePath = 'segmentation/dicomlocal') {
  return render(h(Local, { modePath, phaseOneMask }));
}
async function select(files = [file()], folder = false) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(folder ? '导入文件夹' : '导入文件'), {
      target: { files },
    });
  });
}
test('共享引用先于解析保留，真实登记后异步发布且不阻塞原导航', async () => {
  const prepared = { attach: jest.fn(), cancel: jest.fn() };
  const publisher = {
    prepare: jest.fn(() => prepared),
    publish: jest.fn(() => new Promise(() => {})),
    cancel: jest.fn(),
  };
  mockServices.businessServices.localCollaboration = { publisher };
  parse.mockImplementationOnce(async input => {
    expect(publisher.prepare).toHaveBeenCalledWith(input);
    return {
      batch_id: 'b',
      kind: 'files',
      successes: [
        {
          selection_index: 0,
          file_name: input.files[0].name,
          image_id: 'dicomfile:0',
          study_uid: '1',
          series_uid: '1.2',
          sop_uid: '1.2.3',
          dataset: dataset(),
        },
      ],
      failures: [],
      study_uids: ['1'],
    };
  });
  mount();
  await select();
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
  expect(prepared.attach).toHaveBeenCalledWith(
    mockServices.businessServices.localProjects.getCurrent()
  );
  expect(publisher.publish).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'registered', task_id: task().task_id })
  );
});
test('pending不激活scope、不导航；只有校验后的真实ID才能先激活再导航', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  mount();
  await select();
  expect(request).toHaveBeenCalledTimes(1);
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(store.getStudyInstanceUIDs()).toContain('9');
  expect(store.getStudy('1')).toBeUndefined();
  expect(screen.getByRole('status').textContent).toContain('登记');
  await act(async () => {
    finish(task());
  });
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
  expect(store.getStudyInstanceUIDs()).toEqual(['1']);
  expect(mockNavigate).toHaveBeenCalledWith(
    '/segmentation/dicomlocal?StudyInstanceUIDs=1&datasources=dicomlocal',
    { state: { phaseOneMask: true } }
  );
  expect(mockServices.businessServices.projectRuntime.getCurrent().task_id).toBe(task().task_id);
});
test.each([
  new BusinessApiError(500, 'INTERNAL_ERROR', '登记失败'),
  new BusinessApiError(0, 'TIMEOUT', '请求超时'),
])('失败留页，手动重试保持key且不重新解析 %#', async error => {
  request.mockRejectedValueOnce(error);
  mount();
  await select();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(store.getStudy('1')).toBeUndefined();
  const retry = await screen.findByRole('button', { name: '重试登记' });
  await act(async () => {
    fireEvent.click(retry);
  });
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
  expect(parse).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1].idempotencyKey).toBe(request.mock.calls[1][1].idempotencyKey);
});
test('损坏成功响应不跳转，允许同次重试', async () => {
  request.mockResolvedValueOnce({ ...task(), task_id: '' });
  mount();
  await select();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: '重试登记' })).toBeTruthy();
});
test('双选与登记中再次选择只产生一个批次和一个inflight', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  mount();
  const input = screen.getByLabelText('导入文件');
  await act(async () => {
    fireEvent.change(input, { target: { files: [file()] } });
    fireEvent.change(input, { target: { files: [file('another')] } });
  });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  await select([file('another')]);
  expect(parse).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(task());
  });
});
test('部分失败自动按成功子集登记，提示失败文件且只上传title', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  mount();
  await select([file('坏.dcm'), file('首个.dcm')]);
  expect(screen.getByText('坏.dcm')).toBeTruthy();
  expect(request.mock.calls[0][1].body).toEqual({ title: '首个.dcm' });
  await act(async () => {
    finish(task('首个.dcm'));
  });
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});
test('全失败不发POST、不导航且恢复可选择状态', async () => {
  mount();
  await select([file('坏.dcm')]);
  expect(request).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(screen.getByText('坏.dcm')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Load files' }).hasAttribute('disabled')).toBe(false);
});
test('文件夹名来自根目录，保留SM目标选择且所有新路径共用登记门禁', async () => {
  extensionManager.registeredExtensionIds.push('@ohif/extension-dicom-microscopy');
  mount();
  await select([file('sm.dcm', '根目录/嵌套/sm.dcm')], true);
  expect(request.mock.calls[0][1].body).toEqual({ title: '根目录' });
  expect(mockNavigate).toHaveBeenCalledWith(
    '/microscopy?StudyInstanceUIDs=1&datasources=dicomlocal',
    { state: { phaseOneMask: true } }
  );
});
test('离开或换账号后晚响应不激活旧scope、不导航', async () => {
  let finish;
  request.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const view = mount();
  await select();
  snapshot = context('other');
  listeners.forEach(fn => fn());
  view.unmount();
  await act(async () => {
    finish(task());
  });
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(store.getStudy('1')).toBeUndefined();
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
});
test.each(['', 'viewer/dicomlocal'])(
  '原local入口%s只调用旧parser，不登记、不附业务标记',
  async modePath => {
    const view = mount(false, modePath);
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type=file]'), {
        target: { files: [file()] },
      });
    });
    await waitFor(() => expect(oldParser).toHaveBeenCalledTimes(1));
    expect(parse).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(mockNavigate.mock.calls[0]).toHaveLength(1);
  }
);
test('关闭业务开关保留原mask入口行为，开关开启但服务缺失不能旁路', async () => {
  mockConfig.phaseOneBusiness.enabled = false;
  const view = mount();
  await act(async () => {
    fireEvent.change(view.container.querySelector('input[type=file]'), {
      target: { files: [file()] },
    });
  });
  await waitFor(() => expect(oldParser).toHaveBeenCalledTimes(1));
  expect(request).not.toHaveBeenCalled();
  view.unmount();
  mockConfig.phaseOneBusiness.enabled = true;
  mockServices.businessServices = undefined;
  mount();
  expect(screen.getByRole('alert').textContent).toContain('尚未初始化');
});
test('drop目录只认真实入口信息，多目录或混合输入拒绝而不猜标题', () => {
  const event = entries => ({
    dataTransfer: {
      items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    },
  });
  expect(selectionFromDrop([file()], event([{ isDirectory: true, name: '根' }])).folderName).toBe(
    '根'
  );
  expect(() =>
    selectionFromDrop(
      [file()],
      event([
        { isDirectory: true, name: 'a' },
        { isDirectory: true, name: 'b' },
      ])
    )
  ).toThrow('单一文件夹');
  expect(selectionFromDrop([file()], event([{ isDirectory: false }])).kind).toBe('files');
});

test('原生SM分支仍选择microscopy，不登记任务也不加业务state', async () => {
  extensionManager.registeredExtensionIds.push('@ohif/extension-dicom-microscopy');
  store.addInstance({
    StudyInstanceUID: '8',
    SeriesInstanceUID: '8.1',
    SOPInstanceUID: '8.1.1',
    Modality: 'SM',
  });
  (oldParser as jest.Mock).mockResolvedValueOnce(['8']);
  const view = mount(false);
  await act(async () => {
    fireEvent.change(view.container.querySelector('input[type=file]'), {
      target: { files: [file('sm.dcm')] },
    });
  });
  expect(mockNavigate.mock.calls[0][0]).toContain('/microscopy?');
  expect(mockNavigate.mock.calls[0]).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
});
test('外层真实Dropzone拖入散文件也走相同登记门禁', async () => {
  mount();
  const f = file();
  await act(async () => {
    fireEvent.drop(screen.getByTestId('mask-import-drop'), {
      dataTransfer: {
        files: [f],
        items: [{ kind: 'file', type: f.type, getAsFile: () => f }],
        types: ['Files'],
      },
    });
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});
test('激活后运行时绑定失败会撤销scope，重试不重新解码或重复POST', async () => {
  jest.spyOn(mockServices.businessServices.projectRuntime, 'bind').mockImplementationOnce(() => {
    throw new Error('合成绑定故障');
  });
  mount();
  await select();
  expect(store.getStudy('1')).toBeUndefined();
  expect(mockNavigate).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '重试登记' }));
  });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});
test('导航自身抛错时释放已绑定scope，不保留假活跃运行时', async () => {
  mockNavigate.mockImplementationOnce(() => {
    throw new Error('合成导航故障');
  });
  mount();
  await select();
  expect(screen.getByRole('alert').textContent).toContain('导航故障');
  expect(mockServices.businessServices.projectRuntime.getCurrent()).toBeNull();
  expect(store.getStudy('1')).toBeUndefined();
});

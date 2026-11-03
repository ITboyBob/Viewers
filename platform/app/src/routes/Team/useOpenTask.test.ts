import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import useOpenTask from './useOpenTask';
import { DicomMetadataStore } from '@ohif/core';
import type { BusinessServices } from '@ohif/core';
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/team/recent' }),
}));
jest.mock('@ohif/core', () => ({ DicomMetadataStore: { prepareLocalImportScope: jest.fn() } }), {
  virtual: true,
});
const h = React.createElement;
let project: any, current: any, business: any, scope: any, handle: any;
function Harness() {
  const opener = useOpenTask(business as BusinessServices);
  return h(
    'div',
    null,
    h('button', { onClick: () => opener.open('a') }, '打开'),
    opener.error && h('p', { role: 'alert' }, opener.error)
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  project = {
    task_id: 'a',
    batch_id: 'batch',
    study_uids: ['study'],
    mode_path: 'segmentation/dicomlocal',
    successes: [{ dataset: {} }],
  };
  current = null;
  scope = { activate: jest.fn(), release: jest.fn() };
  handle = { releaseScope: jest.fn() };
  (DicomMetadataStore.prepareLocalImportScope as jest.Mock).mockReturnValue(scope);
  business = {
    localProjects: {
      getRetained: jest.fn(() => project),
      getCurrent: () => current,
      getSelection: jest.fn(() => ({ files: [], kind: 'files' })),
      activate: jest.fn(() => {
        current = project;
        return project;
      }),
      suspend: jest.fn(() => {
        current = null;
      }),
    },
    tasks: { visit: jest.fn().mockResolvedValue(undefined), register: jest.fn() },
    teamPage: { listTaskMembers: jest.fn().mockResolvedValue({}) },
    projectRuntime: { bind: jest.fn(() => handle) },
    localCollaboration: {
      publisher: {
        prepare: jest.fn(() => ({ attach: jest.fn() })),
        publish: jest.fn().mockResolvedValue(undefined),
      },
    },
  };
});
afterEach(cleanup);
test('重开只验证、访问和激活真实任务，继承来源并复用文件，不重新登记', async () => {
  render(h(Harness));
  fireEvent.click(screen.getByText('打开'));
  fireEvent.click(screen.getByText('打开'));
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
  expect(business.tasks.register).not.toHaveBeenCalled();
  expect(business.teamPage.listTaskMembers).toHaveBeenCalledTimes(1);
  expect(business.tasks.visit).toHaveBeenCalledWith('a', expect.any(AbortSignal));
  expect(scope.activate).toHaveBeenCalledTimes(1);
  expect(scope.release).not.toHaveBeenCalled();
  expect(mockNavigate.mock.calls[0][1]).toEqual({
    state: { phaseOneMask: true, taskReturnTo: '/team/recent' },
  });
});
test('没有本地影像不请求登记、不打开空工作台', async () => {
  business.localProjects.getRetained.mockReturnValue(null);
  render(h(Harness));
  fireEvent.click(screen.getByText('打开'));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('需重新导入')
  );
  expect(business.teamPage.listTaskMembers).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
});
test('鉴权拒绝不访问、不激活', async () => {
  business.teamPage.listTaskMembers.mockRejectedValue(new Error('没有权限'));
  render(h(Harness));
  fireEvent.click(screen.getByText('打开'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '没有权限');
  expect(business.tasks.visit).not.toHaveBeenCalled();
  expect(business.localProjects.activate).not.toHaveBeenCalled();
});
test('离开或身份变化后忽略鉴权晚结果，并取消传输', async () => {
  let finish!: () => void;
  business.teamPage.listTaskMembers.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = () => resolve({});
      })
  );
  const view = render(h(Harness));
  fireEvent.click(screen.getByText('打开'));
  const signal = business.teamPage.listTaskMembers.mock.calls[0][1];
  view.unmount();
  await act(async () => finish());
  expect(signal.aborted).toBe(true);
  expect(business.tasks.visit).not.toHaveBeenCalled();
});
test('访问失败留页可重试，不激活项目', async () => {
  business.tasks.visit.mockRejectedValueOnce(new Error('访问失败'));
  render(h(Harness));
  fireEvent.click(screen.getByText('打开'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '访问失败');
  expect(business.localProjects.activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('打开'));
  await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
});
test.each(['scope', 'binding', 'navigation'])(
  '激活后%s失败必须回收活动资格，不删除已保留任务',
  async failure => {
    if (failure === 'scope')
      (DicomMetadataStore.prepareLocalImportScope as jest.Mock).mockImplementationOnce(() => {
        throw new Error('scope失败');
      });
    if (failure === 'binding')
      business.projectRuntime.bind.mockImplementationOnce(() => {
        throw new Error('绑定失败');
      });
    if (failure === 'navigation')
      mockNavigate.mockImplementationOnce(() => {
        throw new Error('导航失败');
      });
    render(h(Harness));
    fireEvent.click(screen.getByText('打开'));
    await screen.findByRole('alert');
    if (failure === 'navigation') expect(handle.releaseScope).toHaveBeenCalled();
    else expect(business.localProjects.suspend).toHaveBeenCalled();
    expect(business.localProjects.getRetained('a')).toBe(project);
  }
);

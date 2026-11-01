import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BusinessSession, LocalProjects, LocalProject } from '@ohif/core';
import store from '../../../core/src/services/DicomMetadataStore/DicomMetadataStore';
import { ProjectRuntimeService } from './ProjectRuntimeService';
import ProjectRouteBoundary from './ProjectRouteBoundary';
import BusinessAuthGate from './BusinessAuthGate';
jest.mock('@ohif/core', () => ({ useSystem: () => ({ servicesManager: { services: {} } }) }), {
  virtual: true,
});
const h = React.createElement;
let runtime: ProjectRuntimeService;
afterEach(() => {
  cleanup();
  runtime?.getHandle()?.releaseScope();
});
function candidate() {
  store.addInstance({ StudyInstanceUID: '9', SeriesInstanceUID: '9.1', SOPInstanceUID: '9.1.1' });
  const scope = store.prepareLocalImportScope('pending-mode', [
    { StudyInstanceUID: '1', SeriesInstanceUID: '1.2', SOPInstanceUID: '1.2.3' },
  ]);
  scope.activate();
  const project = { task_id: 'real', phase: 'registered' } as LocalProject;
  runtime = new ProjectRuntimeService({
    isCurrent: () => true,
    getCurrent: () => project,
    dispose: jest.fn(),
  } as unknown as LocalProjects);
  runtime.bind(project, scope);
}
function view(validateCurrent) {
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      status: 'authenticated',
      context: null,
      currentTeamId: null,
      error: null,
    }),
    validateCurrent,
  } as unknown as BusinessSession;
  // getSnapshot必须返回同一对象，避免用SyncExternalStore无穷重渲染模拟问题。
  const snapshot = session.getSnapshot();
  session.getSnapshot = () => snapshot;
  return render(
    h(
      MemoryRouter,
      { initialEntries: ['/mode'] },
      h(
        Routes,
        null,
        h(Route, {
          path: '/mode',
          element: h(
            ProjectRouteBoundary,
            { lifecycle: runtime.getModeLifecycle() },
            h(BusinessAuthGate, { enabled: true, session }, h('div', null, 'mode已进入'))
          ),
        }),
        h(Route, { path: '/account/login', element: h('div', null, '登录页') })
      )
    )
  );
}
test('Local已交接但Mode仍在身份门禁pending时，离开路由也必须释放scope', async () => {
  candidate();
  const rendered = view(() => new Promise(() => {}));
  expect(screen.getByRole('status').textContent).toContain('验证身份');
  expect(store.getStudyInstanceUIDs()).toEqual(['1']);
  rendered.unmount();
  expect(store.getStudyInstanceUIDs()).toContain('9');
  expect(store.getStudy('1')).toBeUndefined();
  expect(runtime.getCurrent()).toBeNull();
});
test('进入Mode前401转登录，即使Mode从未挂载也不泄漏交接的scope', async () => {
  candidate();
  view(async () => ({ status: 'invalid', context: null, currentTeamId: null, error: null }));
  await waitFor(() => expect(screen.getByText('登录页')).toBeTruthy());
  expect(screen.queryByText('mode已进入')).toBeNull();
  expect(runtime.getCurrent()).toBeNull();
  expect(store.getStudy('1')).toBeUndefined();
});

test('非业务路由没有project时只是透明容器，不创建假运行时', () => {
  const view = render(h(ProjectRouteBoundary, null, h('div', null, '原生页面')));
  expect(screen.getByText('原生页面')).toBeTruthy();
  view.unmount();
});

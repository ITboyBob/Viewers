import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BusinessServices } from '@ohif/core';
import BusinessTopBar from './BusinessTopBar';

jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });
jest.mock('../useBusinessLogout', () => ({ __esModule: true, default: () => () => {} }));
let mockCommit = () => {};
jest.mock('./MemberOverlay', () => ({
  __esModule: true,
  default: function Member() {
    jest.requireActual('react').useLayoutEffect(() => mockCommit(), []);
    return null;
  },
}));
type InviteProps = React.ComponentProps<typeof import('./CollaborationInviteDialog').default>;
type NotificationProps = React.ComponentProps<typeof import('./NotificationDialog').default>;
const mockInvite = jest.fn((_props: InviteProps) => null);
const mockNotification = jest.fn((_props: NotificationProps) => null);
const mockOpen = jest.fn(async (_taskId: string, _signal?: AbortSignal) => true);
jest.mock('./CollaborationInviteDialog', () => ({
  __esModule: true,
  default: (props: InviteProps) => mockInvite(props),
}));
jest.mock('./NotificationDialog', () => ({
  __esModule: true,
  default: (props: NotificationProps) => mockNotification(props),
}));
jest.mock('../../routes/Team/useOpenTask', () => ({
  __esModule: true,
  default: () => ({ open: mockOpen }),
}));
const h = React.createElement;
afterEach(() => {
  cleanup();
  mockCommit = () => {};
  mockInvite.mockClear();
  mockNotification.mockClear();
  mockOpen.mockReset().mockResolvedValue(true);
});

function setup() {
  const taskId = '12345678-1234-1234-1234-123456789abc';
  let publication = 'writing';
  let snapshot: { status: string; context: { user: { uid: string } } | null } = {
    status: 'authenticated',
    context: { user: { uid: 'a' } },
  };
  const sessionListeners = new Set<() => void>(),
    publisherListeners = new Set<() => void>();
  function participant() {
    let phase = 'active';
    const listeners = new Set<() => void>();
    return {
      listeners,
      getSnapshot: () => ({ phase }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {
        phase = 'closed';
        listeners.forEach(listener => listener());
      },
    };
  }
  const first = participant();
  const shared = {
    publisher: {
      subscribe: (listener: () => void) => {
        publisherListeners.add(listener);
        return () => publisherListeners.delete(listener);
      },
    },
    identities: {
      getSource: () =>
        publication === 'cancelled'
          ? null
          : {
              task_id: taskId,
              getSnapshot: () => ({ publication_phase: publication }),
            },
    },
    participation: first,
  };
  const services = {
    session: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    },
    localCollaboration: shared,
    collaborationInvitations: { invite: jest.fn() },
    teamInvitations: { list: jest.fn() },
    projectRuntime: {
      getCurrent: () => ({ task_id: taskId, phase: 'registered' }),
    },
  } as unknown as BusinessServices;
  const emit = () => publisherListeners.forEach(listener => listener());
  const ready = () => {
    publication = 'ready';
    emit();
  };
  const mount = (page: 'import' | 'viewer' = 'viewer') =>
    render(h(MemoryRouter, null, h(BusinessTopBar, { page, services })));
  return {
    services,
    taskId,
    first,
    shared,
    ready,
    mount,
    sessionListeners,
    publisherListeners,
    replace: () => {
      const next = participant();
      shared.participation = next;
      emit();
      return next;
    },
    invalidate: () => {
      snapshot = { status: 'invalid', context: null };
      sessionListeners.forEach(listener => listener());
    },
  };
}

test('首次渲染与被动订阅之间已经ready，也必须显示共享链接', () => {
  const x = setup();
  mockCommit = x.ready;
  x.mount();
  expect(screen.getByRole('button', { name: '共享链接' })).toBeTruthy();
});
test('订阅后ready正常显示；参与关闭立即移除入口', () => {
  const x = setup();
  x.mount();
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
  act(x.ready);
  expect(screen.getByRole('button', { name: '共享链接' })).toBeTruthy();
  act(x.first.close);
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
});
test('替换参与服务后退订旧服务，卸载时释放所有共享订阅', () => {
  const x = setup();
  const view = x.mount();
  act(x.ready);
  let next!: ReturnType<typeof x.replace>;
  act(() => {
    next = x.replace();
  });
  expect(x.first.listeners.size).toBe(0);
  expect(next.listeners.size).toBe(1);
  act(x.first.close);
  expect(screen.getByRole('button', { name: '共享链接' })).toBeTruthy();
  act(next.close);
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
  view.unmount();
  expect(next.listeners.size).toBe(0);
  expect(x.publisherListeners.size).toBe(0);
  expect(x.sessionListeners.size).toBe(0);
});
test('身份失效不保留可复制入口', () => {
  const x = setup();
  x.mount();
  act(x.ready);
  act(x.invalidate);
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
});

test('共享链接就绪和参与关闭均保留当前工作台的真实邀请服务', () => {
  const x = setup();
  x.mount();
  const expectInvitation = () => {
    expect(mockInvite.mock.calls.at(-1)?.[0]).toEqual({
      api: x.services.collaborationInvitations,
      taskId: x.taskId,
    });
  };
  expectInvitation();
  act(x.ready);
  expect(screen.getByRole('button', { name: '共享链接' })).toBeTruthy();
  expectInvitation();
  const callsBeforeClose = mockInvite.mock.calls.length;
  act(x.first.close);
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
  expect(mockInvite.mock.calls.length).toBeGreaterThan(callsBeforeClose);
  expectInvitation();
  act(x.invalidate);
  expect(screen.queryByRole('toolbar')).toBeNull();
});

test.each([true, false])('通知使用真实协作服务并透传任务与取消信号：打开结果 %s', async opened => {
  const x = setup();
  mockOpen.mockResolvedValueOnce(opened);
  x.mount('import');
  const props = mockNotification.mock.calls.at(-1)![0];
  expect(props.collaborationApi).toBe(x.services.collaborationInvitations);
  expect(props.api).toBe(x.services.teamInvitations);
  const controller = new AbortController();
  const result = props.onOpenWorkspace!(x.taskId, controller.signal);
  if (opened) {
    await expect(result).resolves.toBeUndefined();
  } else {
    await expect(result).rejects.toThrow('原图或成果加载失败，请重试进入');
  }
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith(x.taskId, controller.signal);
  expect(mockInvite).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '共享链接' })).toBeNull();
});

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
jest.mock('./CollaborationInviteDialog', () => ({ __esModule: true, default: () => null }));
const h = React.createElement;
afterEach(() => {
  cleanup();
  mockCommit = () => {};
});

function setup() {
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
              task_id: '12345678-1234-1234-1234-123456789abc',
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
  } as unknown as BusinessServices;
  const emit = () => publisherListeners.forEach(listener => listener());
  const ready = () => {
    publication = 'ready';
    emit();
  };
  const mount = () =>
    render(h(MemoryRouter, null, h(BusinessTopBar, { page: 'viewer', services })));
  return {
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

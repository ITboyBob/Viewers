import { SourceSessionVerifier } from './SourceSessionVerifier';
import { BusinessApiClient } from '../BusinessApiClient';
import { BusinessSessionService } from '../BusinessSessionService';
import { ProjectUpdateBridge } from '../ProjectUpdateBridge';
import { LocalProjectService } from '../LocalProjectService';
import { ProjectRuntimeService } from '../ProjectRuntimeService';
import { LocalParticipationIdentity } from './LocalParticipationIdentity';
import type {
  BusinessSession,
  LocalParticipantIdentity,
  LocalProject,
  LocalProjects,
  TaskApi,
} from '@ohif/core';

const context = {
  user: { uid: 'alice', username: '甲', avatar_url: null },
  expires_at: '2099-01-01T00:00:00Z',
  default_team_id: 'team',
  memberships: [{ team_id: 'team', name: '团队', owner_uid: 'alice', role: 'owner' }],
};
function setup() {
  let current = true;
  const identity = {
    user: context.user,
    isCurrent: () => current,
    close: jest.fn(() => {
      current = false;
    }),
  } as unknown as LocalParticipantIdentity;
  const session = {
    getSnapshot: () => ({ status: 'authenticated', context }),
    validateCurrent: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as BusinessSession;
  const api = { request: jest.fn().mockResolvedValue(context) };
  return {
    identity,
    session,
    api,
    verifier: new SourceSessionVerifier({ api, session, identity }),
  };
}

async function setupRuntime() {
  const api = {
    request: jest.fn().mockResolvedValue({ ...context, token: 'synthetic-credential' }),
  };
  const session = new BusinessSessionService(api, null);
  await session.login({ username: '甲', password: 'synthetic-password' });
  let generation = 0;
  let credential = session.getToken();
  session.subscribe(() => {
    if (session.getToken() !== credential) {
      credential = session.getToken();
      generation++;
    }
  });
  const projects = new LocalProjectService(session, {
    identityGeneration: () => generation,
    parse: jest.fn().mockResolvedValue({
      batch_id: 'batch',
      kind: 'files',
      failures: [],
      study_uids: ['study'],
      successes: [
        {
          selection_index: 0,
          file_name: '合成.dcm',
          image_id: 'dicomfile:0',
          study_uid: 'study',
          series_uid: 'series',
          sop_uid: 'sop',
          dataset: {},
        },
      ],
    }),
  });
  const oldRandom = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => '00000000-0000-4000-8000-000000000001',
  });
  let project: LocalProject;
  try {
    project = await projects.create({
      kind: 'files',
      files: [new File(['synthetic'], '合成.dcm')],
    });
  } finally {
    if (oldRandom) {
      Object.defineProperty(crypto, 'randomUUID', oldRandom);
    } else {
      Reflect.deleteProperty(crypto, 'randomUUID');
    }
  }
  project.task_id = 'task';
  project.phase = 'registered';
  project.updated_at = '2026-11-02T00:00:00Z';
  const touch = jest.fn();
  const runtime = new ProjectRuntimeService(projects, { touch } as unknown as TaskApi);
  let id = 0;
  const identities = new LocalParticipationIdentity(
    session,
    projects,
    () => generation,
    () => `participant-${++id}`,
    identity => {
      if (
        identity.role === 'source' &&
        (session.getSnapshot().status === 'invalid' || project.phase === 'invalid')
      ) {
        runtime.getHandle()?.deactivate();
      }
    }
  );
  runtime.bind(project, { activate: jest.fn(), release: jest.fn(), isActive: () => true });
  const callbacks = new Set<(payload: unknown) => void>();
  const events = {
    EVENTS: { CHANGED: 'changed' },
    subscribe: (_event: string, callback: (payload: unknown) => void) => {
      callbacks.add(callback);
      return {
        unsubscribe: () => {
          callbacks.delete(callback);
        },
      };
    },
  };
  runtime.beginMode({ measurementService: events, segmentationService: events }, 'dicomlocal');
  const identity = identities.source(project).identity;
  return {
    api,
    session,
    project,
    projects,
    runtime,
    callbacks,
    touch,
    identity,
    identities,
    verifier: new SourceSessionVerifier({ api, session, identity }),
  };
}

describe('源会话无干扰复核', () => {
  it('直接 current HTTP，复核中保持原 authenticated 快照与资格', async () => {
    const { api, session, verifier } = setup();
    let resolve;
    api.request.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const before = session.getSnapshot();
    const pending = verifier.verify();
    expect(session.getSnapshot()).toEqual(before);
    expect(session.validateCurrent).not.toHaveBeenCalled();
    resolve(context);
    await expect(pending).resolves.toBe(true);
    expect(api.request).toHaveBeenCalledWith('/auth/sessions/current');
  });
  it('网络错误原样失败，不发布空身份或注销', async () => {
    const { api, session, identity, verifier } = setup();
    const failure = Object.assign(new Error('网络故障'), { status: 0 });
    api.request.mockRejectedValue(failure);
    await expect(verifier.verify()).rejects.toBe(failure);
    expect(identity.close).not.toHaveBeenCalled();
    expect(session.invalidate).not.toHaveBeenCalled();
    expect(session.getSnapshot().status).toBe('authenticated');
  });
  it('旧请求的 uid 不匹配或 401 不能关闭新代次', async () => {
    const { api, identity, session, verifier } = setup();
    let resolve;
    api.request.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const pending = verifier.verify();
    identity.isCurrent = () => false;
    resolve({ ...context, user: { ...context.user, uid: 'other' } });
    await expect(pending).resolves.toBe(false);
    expect(identity.close).not.toHaveBeenCalled();
    expect(session.invalidate).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...context, memberships: [] }, { ...context, expires_at: 'bad' }])(
    '坏 current 不放行且不伪装 401 %#',
    async value => {
      const { api, identity, session, verifier } = setup();
      api.request.mockResolvedValue(value);
      await expect(verifier.verify()).resolves.toBe(false);
      expect(identity.close).not.toHaveBeenCalled();
      expect(session.invalidate).not.toHaveBeenCalled();
    }
  );
  it('已验证响应 uid 改变关闭原实例，失效实例不再发请求', async () => {
    const { api, identity, session, verifier } = setup();
    api.request.mockResolvedValue({ ...context, user: { ...context.user, uid: 'other' } });
    await expect(verifier.verify()).resolves.toBe(false);
    expect(identity.close).toHaveBeenCalledWith('identity_invalid');
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    await expect(verifier.verify()).resolves.toBe(false);
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it('有效 current 的 uid 矛盾同步撤销原会话并停止真实桥接订阅、在途请求及 FIFO', async () => {
    const fixture = await setupRuntime();
    let resolveCurrent;
    let resolveTouch;
    fixture.api.request.mockImplementation(
      () =>
        new Promise(done => {
          resolveCurrent = done;
        })
    );
    fixture.touch.mockImplementation(
      () =>
        new Promise(done => {
          resolveTouch = done;
        })
    );
    const pending = fixture.verifier.verify();
    fixture.callbacks.forEach(callback => {
      callback({});
      callback({});
    });
    expect(fixture.touch).toHaveBeenCalledTimes(1);
    const signal = fixture.touch.mock.calls[0][1] as AbortSignal;
    resolveCurrent({ ...context, user: { ...context.user, uid: 'different-account' } });
    try {
      await expect(pending).resolves.toBe(false);
      expect({
        status: fixture.session.getSnapshot().status,
        phase: fixture.project.phase,
        callbacks: fixture.callbacks.size,
        aborted: signal.aborted,
      }).toEqual({
        status: 'invalid',
        phase: 'invalid',
        callbacks: 0,
        aborted: true,
      });
      resolveTouch({ task_id: 'task', updated_at: '2026-11-02T00:00:09Z' });
      for (let n = 0; n < 40; n++) {
        await Promise.resolve();
      }
      fixture.callbacks.forEach(callback => callback({}));
      expect(fixture.touch).toHaveBeenCalledTimes(1);
      expect(fixture.project.updated_at).toBe('2026-11-02T00:00:00Z');
    } finally {
      fixture.runtime.getModeLifecycle()?.dispose();
    }
  });

  it('旧请求的不同 uid 不能注销同 uid 新凭据及新参与代次', async () => {
    const fixture = await setupRuntime();
    let resolveCurrent;
    fixture.api.request.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolveCurrent = done;
        })
    );
    const pending = fixture.verifier.verify();
    fixture.api.request.mockResolvedValueOnce({ ...context, token: 'synthetic-new-credential' });
    await fixture.session.login({ username: '甲', password: 'synthetic-new-password' });
    const identity = fixture.identities.viewer('task');
    const revision = fixture.session.getRevision();
    resolveCurrent({ ...context, user: { ...context.user, uid: 'different-account' } });
    await expect(pending).resolves.toBe(false);
    expect(fixture.session.getSnapshot().status).toBe('authenticated');
    expect(fixture.session.getRevision()).toBe(revision);
    expect(identity.isCurrent()).toBe(true);
    fixture.runtime.getModeLifecycle()?.dispose();
    fixture.identities.close();
  });
  it('复用真实 API 的 401 失效机制，网络失败不调用旧入口', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { ...context, token: 'credential' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED' } }),
      });
    const api = new BusinessApiClient({
      fetch: fetcher,
      getToken: () => session.getToken(),
      getRevision: () => session.getRevision(),
      onUnauthorized: () => session.invalidate(),
    });
    const session = new BusinessSessionService(api, null);
    await session.login({ username: '甲', password: 'password' });
    const identity = {
      user: context.user,
      isCurrent: () => session.getSnapshot().status === 'authenticated',
      close: jest.fn(),
    } as unknown as LocalParticipantIdentity;
    const verifier = new SourceSessionVerifier({ api, session, identity });
    await expect(verifier.verify()).rejects.toMatchObject({ status: 401 });
    expect(session.getSnapshot().status).toBe('invalid');
  });

  it('复核未完成时合法测量与分割广播继续逐事件 FIFO，复核自身零 Task 写', async () => {
    const { api, session, verifier } = setup();
    let resolve;
    api.request.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const callbacks = new Set<(payload: unknown) => void>();
    const eventService = {
      EVENTS: { CHANGED: 'changed' },
      subscribe: (_event: string, callback: (payload: unknown) => void) => {
        callbacks.add(callback);
        return {
          unsubscribe: () => {
            callbacks.delete(callback);
          },
        };
      },
    };
    const project = {
      phase: 'registered',
      task_id: 'task',
      batch_id: 'batch',
      study_uids: ['study'],
      successes: [],
    } as unknown as LocalProject;
    const touch = jest
      .fn()
      .mockResolvedValue({ task_id: 'task', updated_at: '2026-11-02T00:00:00Z' });
    const projects = {
      isCurrent: () => session.getSnapshot().status === 'authenticated',
      updateTimestamp: jest.fn(),
    } as unknown as LocalProjects;
    const bridge = new ProjectUpdateBridge({
      project,
      projects,
      tasks: { touch } as unknown as TaskApi,
      measurementService: eventService,
      segmentationService: eventService,
      isActive: () => true,
      notify: jest.fn(),
    });
    const stop = bridge.start();
    const pending = verifier.verify();
    expect(touch).not.toHaveBeenCalled();
    callbacks.forEach(callback => {
      callback({});
      callback({});
    });
    for (let index = 0; index < 40; index++) {
      await Promise.resolve();
    }
    expect(touch).toHaveBeenCalledTimes(4);
    expect(new Set(touch.mock.calls.map(call => call[1])).size).toBe(4);
    expect(session.getSnapshot().status).toBe('authenticated');
    resolve(context);
    await expect(pending).resolves.toBe(true);
    expect(touch).toHaveBeenCalledTimes(4);
    stop();
    expect(callbacks.size).toBe(0);
  });

  it('无 API 自动失效的 401 替身也关闭旧源，旧 401 不触碰新代次', async () => {
    const first = setup();
    first.api.request.mockRejectedValue(Object.assign(new Error('失效'), { status: 401 }));
    await expect(first.verifier.verify()).rejects.toMatchObject({ status: 401 });
    expect(first.identity.close).toHaveBeenCalledWith('identity_invalid');
    const second = setup();
    let reject;
    second.api.request.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const pending = second.verifier.verify();
    second.identity.isCurrent = () => false;
    reject(Object.assign(new Error('旧失效'), { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(second.identity.close).not.toHaveBeenCalled();
  });
});

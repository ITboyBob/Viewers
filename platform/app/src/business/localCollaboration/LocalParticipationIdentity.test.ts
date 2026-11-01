import { createBusinessServices } from '../createBusinessServices';
import type { LocalProject, SessionContext, SharedFileManifest } from '@ohif/core';
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });
let nextId = 0;
beforeEach(() => {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    value: () => `participant-${++nextId}`,
  });
});

const context: SessionContext = {
  user: { uid: 'a', username: '甲', avatar_url: null },
  expires_at: '2099-01-01T00:00:00Z',
  default_team_id: 'team-a',
  memberships: [{ team_id: 'team-a', name: '甲的团队', owner_uid: 'a', role: 'owner' }],
};
const project = {
  task_id: 'task-a',
  batch_id: 'batch-a',
  importer_uid: 'a',
  phase: 'registered',
} as LocalProject;
async function setup() {
  const services = createBusinessServices(
    { enabled: true },
    {
      storage: null,
      fetch: jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { ...context, token: 'test-token' } }),
      })) as never,
    }
  );
  await services.session.login({ username: '甲', password: 'test-only' });
  jest.spyOn(services.localProjects!, 'isCurrent').mockImplementation(p => p === project);
  expect(services.localCollaboration).toBeDefined();
  return { services, identities: services.localCollaboration!.identities };
}
test('关闭业务时不装配；同一已登记项目的发布器和协议复用唯一源实例', async () => {
  expect(
    createBusinessServices({ enabled: false }, { storage: null }).localCollaboration
  ).toBeUndefined();
  const { identities } = await setup();
  const publisher = identities.source(project);
  const protocol = identities.source(project);
  expect(protocol).toBe(publisher);
  expect(identities.getSource()).toBe(publisher);
  expect(publisher.identity.user).toEqual({ uid: 'a', username: '甲' });
  expect(publisher.identity.nextSeq()).toBe(1);
  expect(protocol.identity.nextSeq()).toBe(2);
  expect(publisher.getSnapshot().publication_phase).toBe('waiting');
});
test('未登记或非当前项目拒绝成为源，实例结束后重入生成新序号域', async () => {
  const { identities } = await setup();
  expect(() => identities.source({ ...project, phase: 'ready' })).toThrow();
  const first = identities.source(project);
  first.close();
  expect(first.isCurrent()).toBe(false);
  expect(() => first.identity.nextSeq()).toThrow();
  const second = identities.source(project);
  expect(second.identity.participant_id).not.toBe(first.identity.participant_id);
  expect(second.identity.nextSeq()).toBe(1);
  first.close();
  expect(second.isCurrent()).toBe(true);
});
test('旧身份及旧回调不能发布就绪或关闭新查看实例', async () => {
  const { services, identities } = await setup();
  const source = identities.source(project);
  const listener = jest.fn();
  source.subscribe(listener);
  services.session.invalidate();
  expect(source.isCurrent()).toBe(false);
  expect(source.setPublication('ready', {} as never)).toBe(false);
  source.setViewReady(true);
  expect(source.getSnapshot().view_ready).toBe(false);
  expect(listener).toHaveBeenCalled();
  await services.session.login({ username: '甲', password: 'test-only' });
  const viewer = identities.viewer('task-a');
  source.close();
  expect(viewer.isCurrent()).toBe(true);
  expect(viewer.user).toEqual({ uid: 'a', username: '甲' });
  expect(viewer.nextSeq()).toBe(1);
  identities.close();
  expect(viewer.isCurrent()).toBe(false);
});
test('同凭证的正常复核保留实例，任务切换结束旧实例且不持久化参与者', async () => {
  const { services, identities } = await setup();
  const first = identities.source(project);
  await services.session.validateCurrent();
  expect(identities.source(project)).toBe(first);
  const viewer = identities.viewer('task-b');
  expect(first.isCurrent()).toBe(false);
  expect(viewer.task_id).toBe('task-b');
  expect(viewer.role).toBe('viewer');
  expect(identities.getSource()).toBeNull();
  expect(() => identities.viewer('')).toThrow();
});

test('只有当前源的清单可发布就绪，取消订阅和项目失效均不会遗留可用状态', async () => {
  const { services, identities } = await setup();
  const source = identities.source(project);
  const listener = jest.fn();
  const stop = source.subscribe(listener);
  expect(source.setPublication('writing')).toBe(true);
  const manifest = {
    task_id: project.task_id,
    batch_id: project.batch_id,
    source_participant_id: source.identity.participant_id,
  } as SharedFileManifest;
  expect(() => source.setPublication('ready')).toThrow();
  for (const key of ['task_id', 'batch_id', 'source_participant_id']) {
    expect(() => source.setPublication('ready', { ...manifest, [key]: 'other' })).toThrow();
  }
  expect(source.setPublication('ready', manifest)).toBe(true);
  source.setViewReady(true);
  expect(source.getSnapshot()).toMatchObject({
    publication_phase: 'ready',
    view_ready: true,
    manifest,
  });
  stop();
  listener.mockClear();
  source.setPublication('failed', undefined, 'cache_invalid');
  expect(source.getSnapshot().error).toBe('cache_invalid');
  expect(listener).not.toHaveBeenCalled();
  identities.close();
  expect(source.getSnapshot().publication_phase).toBe('cancelled');
  services.session.invalidate();
  expect(() => identities.viewer('task-a')).toThrow();
});

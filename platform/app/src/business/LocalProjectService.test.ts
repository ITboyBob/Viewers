import { createBusinessServices } from './createBusinessServices';
import parser from '../routes/Local/filesToImportBatch';
import { randomUUID } from 'crypto';
import { LocalProjectService } from './LocalProjectService';
import type { BusinessSessionSnapshot, BusinessSession, ImportBatch } from '@ohif/core';
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID, configurable: true });
jest.mock('../routes/Local/filesToImportBatch', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseImportBatch: jest.fn(),
}));
const context = (uid = 'u', team = 't') =>
  ({
    status: 'authenticated',
    context: {
      user: { uid, username: uid, avatar_url: null },
      expires_at: '2026-11-02T00:00:00Z',
      default_team_id: team,
      memberships: [{ team_id: team, name: team, owner_uid: uid, role: 'owner' }],
    },
    currentTeamId: team,
    error: null,
  }) as BusinessSessionSnapshot;
const batch = (kind = 'files', successes = [1, 2]) =>
  ({
    batch_id: 'b',
    kind,
    folder_name: '根目录',
    failures: [],
    study_uids: ['1'],
    successes: successes.map(i => ({
      selection_index: i,
      file_name: `${i}.dcm`,
      image_id: `dicomfile:${i}`,
      study_uid: '1',
      series_uid: '1.2',
      sop_uid: '1.2.3',
      dataset: { Modality: 'CT' },
    })),
  }) as ImportBatch;
let snapshot: BusinessSessionSnapshot;
let emit: () => void;
let parse: jest.Mock;
let release: jest.Mock;
let service: LocalProjectService;
let credentialGeneration: number;
beforeEach(() => {
  credentialGeneration = 0;
  snapshot = context();
  parse = jest.fn().mockResolvedValue(batch());
  release = jest.fn();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      emit = listener;
      return jest.fn();
    },
  } as unknown as BusinessSession;
  service = new LocalProjectService(session, {
    parse,
    release,
    identityGeneration: () => credentialGeneration,
  });
});
const selection = { files: [], kind: 'files' as const };
test('发起时冻结团队和首次标题，保存全部文件而非展示折叠结果', async () => {
  let finish;
  parse.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = service.create(selection);
  snapshot = context('u', 'other');
  emit();
  finish(batch());
  const project = await pending;
  expect(project.team_id).toBe('t');
  expect(project.importer_uid).toBe('u');
  expect(project.title).toBe('1.dcm');
  expect(project.successes).toHaveLength(2);
  expect(project.task_id).toBeUndefined();
  expect(project.registration_key).toMatch(/^[a-f0-9-]{36}$/);
  expect(project.registration_key).not.toBe(project.batch_id);
  expect(() => {
    project.title = '改名';
  }).toThrow();
});
test('文件夹标题不由成功文件名推断', async () => {
  parse.mockResolvedValue(batch('folder'));
  expect((await service.create(selection)).title).toBe('根目录');
});
test('全失败不创建project', async () => {
  const empty = batch('files', []);
  parse.mockResolvedValue(empty);
  expect(await service.create(selection)).toBeNull();
  expect(release).toHaveBeenCalledWith(empty);
});
test('解析中账号变化或退出，晚完成不得回写且释放本批次文件', async () => {
  let finish;
  parse.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = service.create(selection);
  snapshot = context('other');
  emit();
  finish(batch());
  expect(await pending).toBeNull();
  expect(service.getCurrent()).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
});
test('同账号退出后再登录也不能恢复旧批次', async () => {
  const project = await service.create(selection);
  snapshot = { status: 'invalid', context: null, currentTeamId: null, error: null };
  emit();
  snapshot = context();
  emit();
  expect(service.isCurrent(project)).toBe(false);
  expect(project.phase).toBe('invalid');
});
test('废弃解析及重复进入不会让旧完成覆盖新批次', async () => {
  let finish;
  parse.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const old = service.create(selection);
  const current = await service.create(selection);
  finish(batch());
  expect(await old).toBeNull();
  expect(service.getCurrent()).toBe(current);
  service.dispose();
  service.dispose();
  expect(service.getCurrent()).toBeNull();
  expect(current.phase).toBe('disposed');
});
test('非认证身份不启动解析', async () => {
  snapshot = { status: 'invalid', context: null, currentTeamId: null, error: null };
  await expect(service.create(selection)).rejects.toThrow('身份');
  expect(parse).not.toHaveBeenCalled();
});
test('默认路径与SM路径从成功子集计算，不改共享modePath', async () => {
  expect((await service.create(selection)).mode_path).toBe('segmentation/dicomlocal');
  const sm = batch();
  sm.successes[0].dataset.Modality = 'SM';
  parse.mockResolvedValue(sm);
  expect((await service.create(selection, true)).mode_path).toBe('microscopy');
});

test('同账号和相同到期时间下换凭证仍废弃旧generation，常规current恢复不废弃', async () => {
  const project = await service.create(selection);
  snapshot = { ...snapshot, status: 'loading', context: null };
  emit();
  snapshot = context();
  emit();
  expect(service.isCurrent(project)).toBe(true);
  credentialGeneration++;
  emit();
  expect(service.isCurrent(project)).toBe(false);
  expect(project.phase).toBe('invalid');
});

test('真实集中服务工厂在同账号同到期时间重新登录时更新凭证generation', async () => {
  (parser as jest.Mock).mockResolvedValue(batch());
  let token = 'synthetic-session-a';
  const transport = jest.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ data: { ...context().context, token } }),
  }));
  const services = createBusinessServices(
    { enabled: true },
    { storage: null, fetch: transport as unknown as typeof fetch }
  );
  await services.session.login({ username: 'u', password: 'synthetic' });
  const project = await services.localProjects!.create(selection);
  expect(services.localProjects!.isCurrent(project)).toBe(true);
  token = 'synthetic-session-b';
  await services.session.login({ username: 'u', password: 'synthetic' });
  expect(services.localProjects!.isCurrent(project)).toBe(false);
  expect(project.phase).toBe('invalid');
});

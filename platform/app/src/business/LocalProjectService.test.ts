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
test('狭义时间只采纳当前有效project同ID的递增响应，失效同步通知但不清图像', async () => {
  const p = await service.create(selection);
  Object.assign(p, { task_id: 'real', updated_at: '2026-11-01T00:00:00Z', phase: 'registered' });
  const notify = jest.fn(),
    stop = service.subscribe(notify);
  expect(service.updateTimestamp(p, { task_id: 'real', updated_at: '2026-11-01T00:00:01Z' })).toBe(
    true
  );
  for (const value of [
    { task_id: 'other', updated_at: '2026-11-01T00:00:02Z' },
    { task_id: 'real', updated_at: 'bad' },
    { task_id: 'real', updated_at: '2026-11-01T00:00:01Z' },
  ]) {
    expect(service.updateTimestamp(p, value)).toBe(false);
  }
  service.invalidate({ ...p });
  expect(notify).not.toHaveBeenCalled();
  service.invalidate(p);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(service.updateTimestamp(p, { task_id: 'real', updated_at: '2026-11-01T00:00:02Z' })).toBe(
    false
  );
  stop();
  service.dispose();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
test('发起时冻结团队和首次标题，保存全部文件而非展示折叠结果', async () => {
  let finish;
  parse.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    })
  );
  const pending = service.create(selection);
  snapshot = context('u', 'other');
  snapshot.context!.memberships.push({
    team_id: 't',
    name: '原团队',
    owner_uid: 'u',
    role: 'owner',
  });
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
  expect(project.phase).toBe('disposed');
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
  expect(project.phase).toBe('disposed');
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
  expect(project.phase).toBe('disposed');
});
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });

test('显式目标团队覆盖当前选择，旧调用继续使用当前团队', async () => {
  snapshot.context!.memberships.push({
    team_id: 'joined',
    name: '已加入',
    owner_uid: 'other',
    role: 'annotator',
  });
  const explicit = await service.create(selection, false, { teamId: 'joined' });
  expect(explicit!.team_id).toBe('joined');
  expect(snapshot.currentTeamId).toBe('t');
  expect((await service.create(selection))!.team_id).toBe('t');
});

test('非法显式目标不回退，解析前拒绝且不销毁原项目', async () => {
  const original = await service.create(selection);
  parse.mockClear();
  await expect(service.create(selection, false, { teamId: 'unknown' })).rejects.toThrow('团队');
  expect(parse).not.toHaveBeenCalled();
  expect(service.isCurrent(original!)).toBe(true);
});

test('显式目标在解析期间被冻结；成员资格撤销后释放批次', async () => {
  let finish!: (value: ImportBatch) => void;
  parse.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const pending = service.create(selection, false, { teamId: 't' });
  snapshot = { ...snapshot, currentTeamId: 'other' };
  finish(batch());
  expect((await pending)!.team_id).toBe('t');
  const revoked = service.create(selection, false, { teamId: 't' });
  snapshot = { ...snapshot, context: { ...snapshot.context!, memberships: [] } };
  finish(batch());
  expect(await revoked).toBeNull();
  expect(release).toHaveBeenCalled();
});

test('已登记任务暂停后保留资源，创建同UID的B再激活A不重复解析或释放', async () => {
  parse.mockResolvedValueOnce(batch()).mockResolvedValueOnce(batch());
  const a = await service.create(selection);
  Object.assign(a, { phase: 'registered', task_id: 'a' });
  service.retain(a);
  service.suspend();
  expect(service.getCurrent()).toBeNull();
  expect(service.getRetained('a')).toBe(a);
  expect(release).not.toHaveBeenCalled();
  const b = await service.create(selection);
  Object.assign(b, { phase: 'registered', task_id: 'b' });
  service.retain(b);
  service.suspend();
  expect(service.activate('a')).toBe(a);
  expect(service.isCurrent(a)).toBe(true);
  expect(parse).toHaveBeenCalledTimes(2);
  service.disposeAll();
  expect(service.getRetained('a')).toBeNull();
  expect(service.getRetained('b')).toBeNull();
  expect(release).toHaveBeenCalledTimes(2);
});

test('身份失效清理全部已保留任务；迟到响应不能重新保留旧项目', async () => {
  const a = await service.create(selection);
  Object.assign(a, { phase: 'registered', task_id: 'a' });
  service.retain(a);
  service.suspend();
  snapshot = { status: 'invalid', context: null, currentTeamId: null, error: null };
  emit();
  expect(service.getRetained('a')).toBeNull();
  expect(release).toHaveBeenCalledTimes(1);
  expect(() => service.retain(a)).toThrow();
});

test.each(['loading', 'error'] as const)(
  '复开身份验证%s期间离开不能销毁已保留项目',
  async status => {
    const a = await service.create(selection);
    Object.assign(a, { phase: 'registered', task_id: 'a' });
    service.retain(a);
    service.setWorkspaceState(a, { saved: true });
    snapshot = { status, context: null, currentTeamId: null, error: null };
    emit();
    service.suspend();
    expect(release).not.toHaveBeenCalled();
    snapshot = context();
    emit();
    expect(service.getRetained('a')).toBe(a);
    expect(service.getWorkspaceState(a)).toEqual({ saved: true });
  }
);

function storedMaterials(): any {
  return {
    task: {
      task_id: 'stored-task',
      team_id: 't',
      title: 'backend-title',
      assignee_uid: 'original-creator',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    },
    source: {
      mode_path: 'segmentation/dicomlocal',
      registration_key: 'stored-key',
      files: batch().successes.map(x => ({ ...x, file_id: String(x.selection_index), size: 1 })),
    },
    access: { can_edit: true },
  };
}
test('后端重开保留真实创建者和task_id，以当前查看者资格激活而不伪造Owner', async () => {
  const p = await service.restoreStored(storedMaterials(), selection);
  expect(p.importer_uid).toBe('original-creator');
  expect(p.viewer_uid).toBe('u');
  expect(p.task_id).toBe('stored-task');
  expect(service.isCurrent(p)).toBe(true);
});
test('登记阶段仍能取得原始文件，但已失效身份不能取得', async () => {
  const p = await service.create(selection);
  p!.phase = 'registering';
  expect(service.getSelection(p!)).toEqual(selection);
  snapshot = { status: 'invalid', context: null, currentTeamId: null, error: null };
  emit();
  expect(service.getSelection(p!)).toBeUndefined();
});
test('已取消或成员资格变化的后端恢复不能激活，必须释放解析批次', async () => {
  const controller = new AbortController();
  parse.mockImplementationOnce(async () => {
    controller.abort();
    return batch();
  });
  await expect(
    service.restoreStored(storedMaterials(), selection, controller.signal)
  ).rejects.toThrow();
  expect(service.getCurrent()).toBeNull();
  expect(release).toHaveBeenCalled();
  parse.mockImplementationOnce(async () => {
    snapshot = { ...snapshot, context: { ...snapshot.context!, memberships: [] } };
    return batch();
  });
  await expect(service.restoreStored(storedMaterials(), selection)).rejects.toThrow();
  expect(service.getCurrent()).toBeNull();
});

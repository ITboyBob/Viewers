import { SharedViewService } from './SharedViewService';
import type {
  BusinessSession,
  ImportBatch,
  LocalParticipationPort,
  SharedFileBundle,
} from '@ohif/core';

function setup() {
  const listeners = new Set<() => void>();
  let status = 'authenticated',
    generation = 1;
  const session = {
    getSnapshot: () => ({
      status,
      context: status === 'invalid' ? null : { user: { uid: 'b', username: '乙' } },
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as BusinessSession;
  const manifest: SharedFileBundle['manifest'] = {
    cache_version: 1,
    cache_state: 'ready',
    task_id: 'task',
    batch_id: 'source-batch',
    source_participant_id: 'source',
    title: '原任务',
    team_id: 'team-a',
    importer_uid: 'a',
    mode_path: 'segmentation/dicomlocal',
    files: [0, 3].map((selection_index, index) => ({
      selection_index,
      file_name: `${index}.dcm`,
      study_uid: '1',
      series_uid: '1.2',
      sop_uid: `1.2.${index + 1}`,
      byte_length: 3,
    })),
  };
  const bundle: SharedFileBundle = {
    manifest,
    files: manifest.files.map(item => ({
      batch_id: manifest.batch_id,
      selection_index: item.selection_index,
      blob: new Blob(['abc']),
    })),
  };
  const parsed: ImportBatch = {
    batch_id: 'local-batch',
    kind: 'files',
    failures: [],
    study_uids: ['1'],
    successes: manifest.files.map((item, index) => ({
      ...item,
      selection_index: index,
      image_id: `dicomfile:${index + 10}`,
      dataset: {
        StudyInstanceUID: item.study_uid,
        SeriesInstanceUID: item.series_uid,
        SOPInstanceUID: item.sop_uid,
      },
    })),
  };
  const participants: Array<LocalParticipationPort & { end(): void }> = [];
  const createParticipation = jest.fn(() => {
    let phase = 'idle';
    const subscribers = new Set<() => void>();
    const participant = {
      identity: {
        participant_id: `viewer-${participants.length}`,
        task_id: 'task',
        user: { uid: 'b', username: '乙' },
        session_generation: generation,
        isCurrent: () => phase !== 'closed',
      },
      getSnapshot: () => ({ phase, source_participant_id: 'source', batch_id: 'source-batch' }),
      subscribe: (callback: () => void) => {
        subscribers.add(callback);
        return () => {
          subscribers.delete(callback);
        };
      },
      join: jest.fn(async (value: string) => {
        phase = value;
        return { task_id: 'task', batch_id: 'source-batch', source_participant_id: 'source' };
      }),
      setViewReady: jest.fn(),
      sendCursor: jest.fn(),
      close: jest.fn(() => {
        if (phase === 'closed') {
          return;
        }
        phase = 'closed';
        subscribers.forEach(callback => callback());
      }),
      end: () => {
        phase = 'closed';
        subscribers.forEach(callback => callback());
      },
    } as unknown as LocalParticipationPort & { end(): void };
    participants.push(participant);
    return participant;
  });
  const scopes: Array<{ activate: jest.Mock; release: jest.Mock; isActive: () => boolean }> = [];
  const prepareScope = jest.fn(() => {
    let active = false;
    const scope = {
      activate: jest.fn(() => {
        active = true;
      }),
      release: jest.fn(() => {
        active = false;
      }),
      isActive: () => active,
    };
    scopes.push(scope);
    return scope;
  });
  const files = { read: jest.fn(async () => bundle), publish: jest.fn() };
  const parse = jest.fn(async () => parsed);
  const release = jest.fn();
  const service = new SharedViewService({
    session,
    generation: () => generation,
    files,
    createParticipation,
    parse,
    release,
    prepareScope,
  });
  return {
    service,
    participants,
    scopes,
    parsed,
    parse,
    release,
    files,
    prepareScope,
    invalidate: () => {
      status = 'invalid';
      generation++;
      listeners.forEach(listener => listener());
    },
  };
}
test('B两阶段进入保持任务来源，原索引映射到本窗loader；画面完成前仅通信active', async () => {
  const { service, participants, scopes, parse } = setup();
  await service.open('task');
  expect(service.getSnapshot()).toMatchObject({
    task_id: 'task',
    batch_id: 'source-batch',
    importer_uid: 'a',
    viewer_uid: 'b',
    team_id: 'team-a',
    phase: 'active',
    view_ready: false,
  });
  expect(
    service.getSnapshot()!.local_files.map(file => [file.selection_index, file.image_id])
  ).toEqual([
    [0, 'dicomfile:10'],
    [3, 'dicomfile:11'],
  ]);
  expect(parse.mock.calls[0][0].files.every(file => file instanceof File)).toBe(true);
  expect(participants[0].join.mock.calls.map(args => args[0])).toEqual(['loading', 'active']);
  expect(scopes[0].activate).toHaveBeenCalledTimes(1);
  service.markSetupComplete(service.getSnapshot()!.load_generation);
  expect(service.getSnapshot()!.view_ready).toBe(false);
  service.markViewReady(service.getSnapshot()!.load_generation);
  expect(service.getSnapshot()!.view_ready).toBe(true);
  expect(participants[0].setViewReady).toHaveBeenLastCalledWith(true);
  service.dispose();
  expect(scopes[0].release).toHaveBeenCalledTimes(1);
  expect(service.getSnapshot()!.local_files).toEqual([]);
  expect(service.getSnapshot()!.scope_handle).toBeNull();
});
test.each(['uid', 'partial', 'missing'])(
  '任何文件%s失败拒绝整次加载，不缩减子集激活',
  async kind => {
    const { service, parse, parsed, scopes, release } = setup();
    parse.mockResolvedValue({
      ...parsed,
      successes:
        kind === 'missing'
          ? parsed.successes.slice(1)
          : parsed.successes.map((item, index) =>
              kind === 'uid' && index === 0 ? { ...item, sop_uid: '9' } : item
            ),
      failures:
        kind === 'partial'
          ? [{ selection_index: 0, file_name: 'bad', reason: 'PARSE_FAILED' }]
          : [],
    });
    await expect(service.open('task')).rejects.toThrow();
    expect(scopes).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  }
);
test('source结束：画面前取消，画面后detached保留scope；B自身失效优先invalid', async () => {
  const first = setup();
  await first.service.open('task');
  first.participants[0].end();
  expect(first.scopes[0].release).toHaveBeenCalledTimes(1);
  expect(first.service.getSnapshot()!.phase).not.toBe('detached');
  const second = setup();
  await second.service.open('task');
  second.service.markViewReady(second.service.getSnapshot()!.load_generation);
  expect(second.service.getSnapshot()!.view_ready).toBe(false);
  second.service.markSetupComplete(second.service.getSnapshot()!.load_generation);
  second.participants[0].end();
  expect(second.service.getSnapshot()!.phase).toBe('detached');
  expect(second.scopes[0].release).not.toHaveBeenCalled();
  second.invalidate();
  expect(second.service.getSnapshot()!.phase).toBe('invalid');
  expect(second.scopes[0].release).not.toHaveBeenCalled();
  second.service.dispose();
  expect(second.scopes[0].release).toHaveBeenCalledTimes(1);
});
test('晚解析与旧native清理不能释放新scope或激活旧代次', async () => {
  const { service, parse, parsed, release, scopes } = setup();
  let finish: (value: ImportBatch) => void;
  parse.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  let oldError: unknown;
  const old = service.open('task').catch(error => {
    oldError = error;
  });
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
  expect(finish!).toEqual(expect.any(Function));
  service.dispose();
  await service.open('task');
  const current = service.getSnapshot()!;
  finish!({ ...parsed, batch_id: 'late' });
  await old;
  expect(oldError).toBeInstanceOf(Error);
  expect(release).toHaveBeenCalledWith(expect.objectContaining({ batch_id: 'late' }));
  expect(scopes[0].release).not.toHaveBeenCalled();
  service.markViewReady(current.load_generation - 1);
  expect(service.getSnapshot()!.view_ready).toBe(false);
  const oldLifecycle = service.getModeLifecycle()!;
  service.dispose();
  await service.open('task');
  oldLifecycle.dispose();
  expect(scopes[1].release).not.toHaveBeenCalled();
  service.dispose();
});
test('原生退出先于scope及本窗文件释放，重复清理幂等', async () => {
  const { service, release, scopes } = setup();
  await service.open('task');
  const order: string[] = [];
  scopes[0].release.mockImplementation(() => order.push('scope'));
  release.mockImplementation(() => order.push('files'));
  service.getModeLifecycle()!.setNativeExit(() => order.push('native'));
  service.dispose();
  service.dispose();
  expect(order).toEqual(['native', 'scope', 'files']);
});
test('scope激活或释放抛错仍释放本批文件，不保留假完成画面', async () => {
  const first = setup();
  first.prepareScope.mockImplementation(() => {
    const scope = {
      activate: jest.fn(() => {
        throw new Error('activate');
      }),
      release: jest.fn(),
      isActive: () => false,
    };
    first.scopes.push(scope);
    return scope;
  });
  await expect(first.service.open('task')).rejects.toThrow();
  expect(first.scopes[0].release).toHaveBeenCalledTimes(1);
  expect(first.release).toHaveBeenCalledTimes(1);
  const second = setup();
  await second.service.open('task');
  second.scopes[0].release.mockImplementation(() => {
    throw new Error('release');
  });
  second.service.dispose();
  expect(second.release).toHaveBeenCalledTimes(1);
  expect(second.service.getSnapshot()).toMatchObject({
    phase: 'invalid',
    view_ready: false,
    local_files: [],
    scope_handle: null,
  });
});

test('首帧先到仍等setup，旧代次或源关闭后的完成不能复活', async () => {
  const { service, participants } = setup();
  await service.open('task');
  const generation = service.getSnapshot()!.load_generation;
  service.markViewReady(generation);
  service.markSetupComplete(generation - 1);
  expect(service.getSnapshot()!.view_ready).toBe(false);
  participants[0].end();
  service.markSetupComplete(generation);
  expect(service.getSnapshot()).toMatchObject({ phase: 'disposed', view_ready: false });
  expect(participants[0].setViewReady).not.toHaveBeenCalled();
});

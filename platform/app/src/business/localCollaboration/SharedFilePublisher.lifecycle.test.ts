import type { BusinessSession, LocalProject, LocalProjects, SharedFilePort } from '@ohif/core';
import { SharedFilePublisher } from './SharedFilePublisher';
import { LocalParticipationIdentity } from './LocalParticipationIdentity';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup() {
  let status = 'authenticated',
    generation = 1;
  let user = { uid: 'a', username: '甲' };
  const sessionListeners = new Set<() => void>();
  const projectListeners = new Set<() => void>();
  const project: LocalProject = {
    task_id: 'task',
    batch_id: 'batch',
    kind: 'files',
    registration_key: 'registration',
    failures: [],
    study_uids: ['1.2'],
    title: '合成影像',
    team_id: 'team',
    importer_uid: 'a',
    mode_path: 'segmentation/dicomlocal',
    phase: 'registered',
    successes: [
      {
        selection_index: 0,
        file_name: '合成.dcm',
        image_id: 'dicomfile:0',
        dataset: {},
        study_uid: '1.2',
        series_uid: '1.3',
        sop_uid: '1.4',
      },
    ],
  };
  let current: LocalProject | null = project;
  const session = {
    getSnapshot: () => ({ status, context: status === 'authenticated' ? { user } : null }),
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  } as unknown as BusinessSession;
  const projects = {
    getCurrent: () => current,
    isCurrent: (value: LocalProject) =>
      value === current &&
      status === 'authenticated' &&
      value.phase === 'registered' &&
      user.uid === value.importer_uid,
    subscribe: (listener: () => void) => {
      projectListeners.add(listener);
      return () => projectListeners.delete(listener);
    },
  } as unknown as LocalProjects;
  const identities = new LocalParticipationIdentity(
    session,
    projects,
    () => generation,
    () => 'source'
  );
  let commit!: () => void;
  const write = jest.fn(
    bundle =>
      new Promise(resolve => {
        commit = () => resolve(bundle.manifest);
      })
  );
  const publisher = new SharedFilePublisher({
    session,
    projects,
    identities,
    files: { publish: write } as unknown as SharedFilePort,
    generation: () => generation,
  });
  const preparation = publisher.prepare({
    files: [new File(['synthetic'], '合成.dcm')],
    kind: 'files',
  });
  preparation.attach(project);
  const pending = publisher.publish(project);
  const source = identities.getSource()!;
  const baselineSessionListeners = sessionListeners.size;
  const change = (value: string) => {
    status = value;
    sessionListeners.forEach(listener => listener());
  };
  return {
    publisher,
    project,
    identities,
    pending,
    source,
    write,
    preparation,
    change,
    commit: () => commit(),
    baselineSessionListeners,
    sessionListeners,
    notifyProject: () => projectListeners.forEach(listener => listener()),
    invalidateProject: () => {
      current = null;
      projectListeners.forEach(listener => listener());
    },
    changeAccount: () => {
      generation++;
      user = { uid: 'b', username: '乙' };
      change('authenticated');
    },
  };
}

test('事务完成后连续同凭证校验不误取消源，也不重复发布文件', async () => {
  const x = setup();
  x.change('loading');
  x.commit();
  await flush();
  x.change('authenticated');
  x.change('loading');
  await flush();
  expect(x.source.getSnapshot().publication_phase).toBe('writing');
  x.change('authenticated');
  await x.pending;
  expect(x.source.getSnapshot().publication_phase).toBe('ready');
  expect(x.identities.getSource()).toBe(x.source);
  expect(x.write).toHaveBeenCalledTimes(1);
});

test('校验网络失败保持不可用，原身份重试通过后完成同次发布', async () => {
  const x = setup();
  x.change('loading');
  x.commit();
  await flush();
  x.change('error');
  await flush();
  expect(x.source.getSnapshot().publication_phase).toBe('writing');
  expect(x.identities.getSource()).toBeNull();
  x.change('loading');
  x.change('authenticated');
  await x.pending;
  expect(x.source.getSnapshot().publication_phase).toBe('ready');
  expect(x.write).toHaveBeenCalledTimes(1);
});

test.each(['loading', 'error'])('%s期间同项目通知不得关闭仍归当前凭证的源', async status => {
  const x = setup();
  x.change(status);
  x.notifyProject();
  expect(x.source.getSnapshot().publication_phase).toBe('writing');
  x.commit();
  await flush();
  x.change('authenticated');
  await x.pending;
  expect(x.source.getSnapshot().publication_phase).toBe('ready');
});

test.each(['cancel', 'logout', 'account', 'project'] as const)(
  '身份等待期间%s立即结束发布并退订，晚结果不得复活',
  async reason => {
    const x = setup();
    x.change('loading');
    x.commit();
    await flush();
    if (reason === 'cancel') x.preparation.cancel();
    if (reason === 'logout') x.change('invalid');
    if (reason === 'account') x.changeAccount();
    if (reason === 'project') x.invalidateProject();
    await x.pending;
    expect(x.source.getSnapshot().publication_phase).toBe('cancelled');
    expect(x.sessionListeners.size).toBe(x.baselineSessionListeners);
    x.change('authenticated');
    await flush();
    expect(x.source.getSnapshot().publication_phase).toBe('cancelled');
    expect(x.write).toHaveBeenCalledTimes(1);
  }
);

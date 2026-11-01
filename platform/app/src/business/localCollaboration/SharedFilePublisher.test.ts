import { SharedFilePublisher } from './SharedFilePublisher';
import { LocalParticipationIdentity } from './LocalParticipationIdentity';
import type { BusinessSession, LocalProject, LocalProjects, SharedFilePort } from '@ohif/core';

function setup() {
  let generation = 1;
  let sessionStatus = 'authenticated';
  const sessionListeners = new Set<() => void>();
  const project = {
    task_id: 'task',
    batch_id: 'batch',
    title: '原标题',
    team_id: 'team',
    importer_uid: 'a',
    mode_path: 'segmentation/dicomlocal',
    phase: 'registered',
    successes: [
      {
        selection_index: 2,
        file_name: 'last.dcm',
        study_uid: '1.2',
        series_uid: '1.3',
        sop_uid: '1.4',
      },
      {
        selection_index: 0,
        file_name: 'first.dcm',
        study_uid: '1.2',
        series_uid: '1.3',
        sop_uid: '1.5',
      },
    ],
  } as LocalProject;
  const session = {
    getSnapshot: () => ({
      status: sessionStatus,
      context: { user: { uid: 'a', username: '甲' } },
    }),
    subscribe: listener => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  } as unknown as BusinessSession;
  const projects = {
    isCurrent: value => value === project,
    subscribe: () => () => undefined,
  } as LocalProjects;
  const identities = new LocalParticipationIdentity(
    session,
    projects,
    () => generation,
    () => 'participant'
  );
  const files = { publish: jest.fn(async value => value.manifest) } as unknown as SharedFilePort;
  const publisher = new SharedFilePublisher({
    session,
    projects,
    identities,
    files,
    generation: () => generation,
  });
  const originals = [
    new File(['first'], 'first.dcm'),
    new File(['bad'], 'bad.dcm'),
    new File(['last'], 'last.dcm'),
  ];
  const prepare = () => {
    const handle = publisher.prepare({ files: originals, kind: 'files' });
    handle.attach(project);
    return handle;
  };
  return {
    publisher,
    project,
    files,
    identities,
    originals,
    prepare,
    changeIdentity: () => generation++,
    setSessionStatus: (value: string) => {
      sessionStatus = value;
      sessionListeners.forEach(listener => listener());
    },
  };
}
test('A导航的同凭证current校验期间提交完成须等待身份恢复，不能误取消源', async () => {
  const { publisher, project, files, identities, prepare, setSessionStatus } = setup();
  prepare();
  let finish: () => void;
  (files.publish as jest.Mock).mockImplementation(
    value =>
      new Promise(resolve => {
        finish = () => resolve(value.manifest);
      })
  );
  const pending = publisher.publish(project);
  const source = identities.getSource()!;
  setSessionStatus('loading');
  finish!();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  expect(source.getSnapshot().publication_phase).toBe('writing');
  setSessionStatus('authenticated');
  await pending;
  expect(source.getSnapshot().publication_phase).toBe('ready');
});
test('只发布原始成功子集，按选择索引排序并保留真实ID、首次标题和唯一源', async () => {
  const { publisher, project, files, identities, originals, prepare } = setup();
  prepare();
  await publisher.publish(project);
  expect(files.publish).toHaveBeenCalledTimes(1);
  const [bundle] = (files.publish as jest.Mock).mock.calls[0];
  expect(bundle.manifest).toMatchObject({
    task_id: 'task',
    title: '原标题',
    source_participant_id: 'participant',
  });
  expect(bundle.files.map(item => item.selection_index)).toEqual([0, 2]);
  expect(bundle.files[0].blob).toBe(originals[0]);
  expect(bundle.files[1].blob).toBe(originals[2]);
  expect(identities.source(project).getSnapshot().publication_phase).toBe('ready');
  await publisher.publish(project);
  expect(files.publish).toHaveBeenCalledTimes(1);
});
test('真实登记前不发布，随后登记成功可继续同次原始文件', async () => {
  const { publisher, project, files, prepare } = setup();
  prepare();
  project.phase = 'registering';
  delete project.task_id;
  await publisher.publish(project);
  expect(files.publish).not.toHaveBeenCalled();
  project.phase = 'registered';
  project.task_id = 'task';
  await publisher.publish(project);
  expect(files.publish).toHaveBeenCalledTimes(1);
});
test('缓存失败不修改原项目或抛出阻断A；显式重试复用原源实例', async () => {
  const { publisher, project, files, identities, prepare } = setup();
  prepare();
  (files.publish as jest.Mock).mockRejectedValueOnce(new Error('quota'));
  await expect(publisher.publish(project)).resolves.toBeUndefined();
  expect(project.phase).toBe('registered');
  expect(identities.getSource()!.getSnapshot().publication_phase).toBe('failed');
  await publisher.publish(project);
  expect(identities.getSource()!.getSnapshot().publication_phase).toBe('ready');
});
test.each(['cancel', 'identity'])(
  '写入期间%s后晚结果不能复活ready，也不能释放A loader',
  async reason => {
    const { publisher, project, files, identities, prepare, changeIdentity } = setup();
    const handle = prepare();
    let finish: (value: unknown) => void;
    (files.publish as jest.Mock).mockImplementation(
      value =>
        new Promise(resolve => {
          finish = () => resolve(value.manifest);
        })
    );
    const pending = publisher.publish(project);
    const source = identities.getSource()!;
    reason === 'cancel' ? handle.cancel() : changeIdentity();
    finish!(undefined);
    await pending;
    expect(source.getSnapshot().publication_phase).not.toBe('ready');
    expect(project.phase).toBe('registered');
  }
);
test('缺少原引用不能发布，并且旧准备取消不关闭新源', async () => {
  const { publisher, project, files, identities } = setup();
  const old = publisher.prepare({ files: [], kind: 'files' });
  old.attach(project);
  await publisher.publish(project);
  expect(files.publish).not.toHaveBeenCalled();
  expect(identities.getSource()!.getSnapshot().publication_phase).toBe('failed');
  publisher.cancel();
  old.cancel();
  expect(identities.getSource()).toBeNull();
});

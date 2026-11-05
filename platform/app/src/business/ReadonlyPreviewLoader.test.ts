import { loadReadonlyPreview } from './ReadonlyPreviewLoader';
const source = {
  file_id: 'f',
  file_name: 'a.dcm',
  selection_index: 0,
  study_uid: '1',
  series_uid: '2',
  sop_uid: '3',
};
const materials = {
  task: { task_id: 't', team_id: 'actual-team' },
  source: { files: [source] },
  access: { owner_uid: 'u', can_edit: false },
};
const list = (revision = 0, objects: any[] = []) => ({
  revision,
  objects,
  access: materials.access,
});
const result: any = { status: 'ready', image: 'x', release: jest.fn() };
const signal = new AbortController().signal;
test('只读也可从任务真实团队读取，并在产出前核验revision', async () => {
  const api = {
    request: jest
      .fn()
      .mockResolvedValueOnce(materials)
      .mockResolvedValueOnce(new Blob())
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list()),
  } as any;
  const compose = jest.fn().mockResolvedValue(result);
  expect(await loadReadonlyPreview(api, 'u', 't', signal, compose)).toBe(result);
  expect(compose.mock.calls[0][0]).toMatchObject({
    account_uid: 'u',
    team_id: 'actual-team',
    frame_index: 0,
    revision: 0,
  });
  expect(api.request.mock.calls[3][0]).toBe('/tasks/t/results');
});
test('旧对象404仅在revision改变后整版重取，不混版', async () => {
  const api = {
    request: jest
      .fn()
      .mockResolvedValueOnce(materials)
      .mockResolvedValueOnce(new Blob())
      .mockResolvedValueOnce(list(1, [{ object_id: 'old', type: 'SR' }]))
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce(list(2))
      .mockResolvedValueOnce(list(2))
      .mockResolvedValueOnce(list(2))
      .mockResolvedValueOnce(list(2)),
  } as any;
  const compose = jest.fn().mockResolvedValue(result);
  await loadReadonlyPreview(api, 'u', 't', signal, compose);
  expect(compose).toHaveBeenCalledTimes(1);
  expect(compose.mock.calls[0][0]).toMatchObject({ revision: 2, objects: [] });
});
test('未变revision的404、撤权及持续变版均不可退化原图成功', async () => {
  const api = {
    request: jest.fn(async (path: string) => {
      if (path.endsWith('/materials')) return materials;
      if (path.includes('/files/')) return new Blob();
      if (path.endsWith('/results')) return list(1, [{ object_id: 'bad', type: 'SR' }]);
      throw { status: 404 };
    }),
  } as any;
  await expect(loadReadonlyPreview(api, 'u', 't', signal, jest.fn())).rejects.toBeDefined();
});

test('持续换版有限重试并释放每一版局部资源', async () => {
  let revision = 0;
  const release = jest.fn();
  const api: any = {
    request: jest.fn(async (path: string) =>
      path.endsWith('/materials')
        ? materials
        : path.includes('/files/')
          ? new Blob()
          : list(revision)
    ),
  };
  const compose = jest.fn().mockImplementation(() => {
    revision++;
    return { ...result, release };
  });
  await expect(loadReadonlyPreview(api, 'u', 't', signal, compose)).rejects.toThrow('持续变化');
  expect(compose).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledTimes(3);
});
test('产出前撤权不能沿用已渲染资源；缺少材料与损坏清单显错', async () => {
  const release = jest.fn();
  const api: any = {
    request: jest
      .fn()
      .mockResolvedValueOnce(materials)
      .mockResolvedValueOnce(new Blob())
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list())
      .mockRejectedValueOnce({ status: 401 }),
  };
  await expect(
    loadReadonlyPreview(api, 'u', 't', signal, jest.fn().mockResolvedValue({ ...result, release }))
  ).rejects.toMatchObject({ status: 401 });
  expect(release).toHaveBeenCalledTimes(1);
  api.request.mockReset().mockResolvedValue({});
  await expect(loadReadonlyPreview(api, 'u', 't', signal, jest.fn())).rejects.toThrow();
  api.request
    .mockReset()
    .mockResolvedValueOnce(materials)
    .mockResolvedValueOnce(new Blob())
    .mockResolvedValueOnce({ revision: -1 });
  await expect(loadReadonlyPreview(api, 'u', 't', signal, jest.fn())).rejects.toThrow('清单');
});

test('下载完成后先重验修订，失效整版不能进入只读组合器', async () => {
  let revision = 1;
  const api: any = {
    request: jest.fn(async (path: string) => {
      if (path.endsWith('/materials')) return materials;
      if (path.includes('/files/')) return new Blob();
      if (path.endsWith('/results'))
        return list(revision, [{ object_id: `r${revision}`, type: 'SR' }]);
      if (path.endsWith('/result-files/r1')) revision = 2;
      return new Blob();
    }),
  };
  const compose = jest.fn().mockResolvedValue(result);
  expect(await loadReadonlyPreview(api, 'u', 't', signal, compose)).toBe(result);
  expect(compose).toHaveBeenCalledTimes(1);
  expect(compose.mock.calls[0][0]).toMatchObject({ revision: 2, objects: [{ object_id: 'r2' }] });
});

test('下载后重验撤权停止读取，不能进入组合器', async () => {
  const api: any = {
    request: jest
      .fn()
      .mockResolvedValueOnce(materials)
      .mockResolvedValueOnce(new Blob())
      .mockResolvedValueOnce(list())
      .mockRejectedValueOnce({ status: 401 }),
  };
  const compose = jest.fn();
  await expect(loadReadonlyPreview(api, 'u', 't', signal, compose)).rejects.toMatchObject({
    status: 401,
  });
  expect(compose).not.toHaveBeenCalled();
});

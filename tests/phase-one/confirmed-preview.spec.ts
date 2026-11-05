import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { encodeResult } from '../../extensions/cornerstone/src/utils/TaskResultCodec';
import { syntheticSeries } from './syntheticDicom';

test('固定来源封面叠加整版SEG/SR/RTSTRUCT，刷新变色和删除且最近任务规则一致', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const password = 'preview-confirmed-test',
    username = '封面-' + randomUUID().slice(0, 8);
  const registered = await request.post('/api/v1/users', { data: { username, password } });
  const actor = (await registered.json()).data;
  const headers = { Authorization: `Bearer ${actor.token}` };
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    l => l.click()
  );
  const series = syntheticSeries(2);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '创建新任务', exact: true }).click();
  const done = page.waitForResponse(
    r =>
      r.request().method() === 'POST' &&
      /\/task-imports\/[^/]+\/complete$/.test(new URL(r.url()).pathname)
  );
  await (await chooser).setFiles(series.files);
  const task = (await (await done).json()).data;
  await expect(page.getByRole('status').filter({ hasText: /成果已(同步|保存)/ })).toBeVisible({
    timeout: 60000,
  });
  await page.goto('/team/tasks');
  const materials = (
    await (await request.get(`/api/v1/tasks/${task.task_id}/materials`, { headers })).json()
  ).data;
  const files = [...materials.source.files].sort((a, b) => a.selection_index - b.selection_index);
  const project: any = {
    task_id: task.task_id,
    successes: files.map((f, i) => ({
      ...f,
      image_id: `raw-${i}`,
      dataset: { NumberOfFrames: 1 },
    })),
  };
  const state = (value: any) => ({
    taskId: task.task_id,
    annotations: [],
    measurements: [],
    segmentations: [],
    ...value,
  });
  const mask = (index: number, rgba: number[]) => {
    const pixels = new Uint8Array(32 * 32);
    pixels[16 * 32 + 16] = 1;
    return state({
      segmentations: [
        {
          segmentationId: 'preview-labelmap',
          frames: [{ referenceId: `raw-${index}`, rows: 32, columns: 32, pixels }],
          colors: { 1: rgba },
          visible: { 1: false },
        },
      ],
    });
  };
  const commit = async (values: Array<{ type: 'SEG' | 'SR' | 'RTSTRUCT'; value: any }>) => {
    const objects = [];
    for (const item of values) {
      const id = randomUUID(),
        blob = encodeResult(project, item.type, item.value);
      const r = await request.put(`/api/v1/tasks/${task.task_id}/result-files/${id}`, {
        headers: { ...headers, 'Content-Type': 'application/octet-stream' },
        data: Buffer.from(await blob.arrayBuffer()),
      });
      expect(r.status()).toBe(200);
      objects.push({ object_id: id, type: item.type });
    }
    const current = (
      await (await request.get(`/api/v1/tasks/${task.task_id}/results`, { headers })).json()
    ).data;
    const r = await request.post(`/api/v1/tasks/${task.task_id}/results/commit`, {
      headers,
      data: { base_revision: current.revision, operation_id: randomUUID(), objects },
    });
    expect(r.status()).toBe(200);
  };
  const annotation = {
    annotationUID: 'a',
    metadata: { referencedImageId: 'raw-0', toolName: 'Length' },
    data: {
      handles: {
        points: [
          [4, 4, 0],
          [12, 4, 0],
        ],
      },
      text: '确认测量',
    },
  };
  // 合成源的坐标系从原始文件解析，不依赖当前视口或活动切片。
  const dcmjs = await import('dcmjs');
  const raw = series.files[0].buffer;
  const dataset = dcmjs.default.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.default.data.DicomMessage.readFile(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    ).dict
  );
  await commit([
    { type: 'SEG', value: mask(0, [255, 0, 0, 255]) },
    { type: 'SR', value: state({ annotations: [annotation] }) },
    {
      type: 'RTSTRUCT',
      value: state({
        segmentations: [
          {
            segmentationId: 'preview-contour',
            frames: [],
            colors: {},
            contour: {},
            geometries: [
              {
                frameOfReferenceUID: dataset.FrameOfReferenceUID,
                color: [0, 255, 0],
                data: [
                  {
                    points: [
                      [4, 8, 0],
                      [10, 8, 0],
                      [10, 12, 0],
                    ],
                    type: 'CLOSED_PLANAR',
                  },
                ],
              },
            ],
          },
        ],
      }),
    },
  ]);
  const image = page.locator(`[data-task-card="${task.task_id}"] img`);
  const pixels = async () =>
    image.evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(16, 16, 1, 1).data);
    });
  const refresh = async () => {
    const verified = page.waitForResponse(
      r =>
        r.request().method() === 'GET' &&
        new URL(r.url()).pathname === `/api/v1/tasks/${task.task_id}/results`
    );
    await page.getByRole('button', { name: '刷新列表' }).click();
    await verified;
    await expect(image).toBeVisible();
  };
  await refresh();
  let p = await pixels();
  expect(p[0]).toBeGreaterThan(p[1]);
  await page.screenshot({ path: testInfo.outputPath('confirmed-preview.png'), fullPage: true });
  await commit([{ type: 'SEG', value: mask(0, [0, 0, 255, 255]) }]);
  await refresh();
  p = await pixels();
  expect(p[2]).toBeGreaterThan(p[0]);
  await page.getByRole('button', { name: '最近任务', exact: true }).click();
  await expect(image).toBeVisible();
  p = await pixels();
  expect(p[2]).toBeGreaterThan(p[0]);
  await commit([{ type: 'SEG', value: mask(1, [255, 0, 0, 255]) }]);
  await refresh();
  p = await pixels();
  expect(p[0]).toBe(p[1]);
  expect(p[1]).toBe(p[2]);
  await commit([]);
  await page.reload();
  await expect(image).toBeVisible();
  p = await pixels();
  expect(p[0]).toBe(p[1]);
  expect(p[1]).toBe(p[2]);
});

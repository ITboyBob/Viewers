import { isImportComplete, workspaceReady } from './businessImport';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syntheticSeries } from './syntheticDicom';

async function login(page: Page, request: APIRequestContext) {
  const username = 'import-' + randomUUID().slice(0, 8),
    password = 'synthetic-password';
  const registered = await request.post('/api/v1/users', { data: { username, password } });
  expect(registered.status()).toBe(201);
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.goto('/local-mask');
  await expect(page.getByRole('button', { name: 'Load files', exact: true })).toBeVisible();
}
const taskPath = isImportComplete;

test('真实解析部分成功，先提交后丢响应留页，同key重试取回同一真实ID才进入影像页', async ({
  page,
  request,
}) => {
  await login(page, request);
  const sample = syntheticSeries();
  sample.files[0].name = '首个成功.dcm';
  const records: Array<{
    key: string;
    body: unknown;
    status: number;
    task: Record<string, unknown>;
  }> = [];
  let committed!: () => void, deliver!: () => void;
  const firstCommit = new Promise<void>(resolve => {
    committed = resolve;
  });
  const allowDrop = new Promise<void>(resolve => {
    deliver = resolve;
  });
  await page.route('**/api/v1/task-imports/*/complete', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const payload = await response.json();
    records.push({
      key: new URL(route.request().url()).pathname.split('/')[4],
      body: route.request().postDataJSON(),
      status: response.status(),
      task: payload.data,
    });
    if (records.length === 1) {
      committed();
      await allowDrop;
      await route.abort('failed');
    } else {
      await route.fulfill({ response });
    }
  });
  try {
    await page
      .getByLabel('导入文件', { exact: true })
      .setInputFiles([
        { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('not dicom') },
        ...sample.files,
      ]);
    await test.step('后端complete已提交，客户端响应尚未交付', async () => {
      await expect.poll(() => records.length, { message: '等待实际完成登记接口提交' }).toBe(1);
      await firstCommit;
    });
    expect(records[0].status).toBe(200);
    expect(records[0].task.task_id).toBeTruthy();
    expect(records[0].task.title).toBe('首个成功.dcm');
    expect(records[0].body).toBeNull();
    await expect(page).toHaveURL(/\/local-mask$/);
    await expect(
      page.getByTestId('mask-import-drop').getByText('坏.dcm', { exact: true })
    ).toBeVisible();
    deliver();
    await page.getByRole('button', { name: '重试登记' }).click();
    await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
    expect(records).toHaveLength(2);
    expect(records[1].status).toBe(200);
    expect(records[1].task.task_id).toBe(records[0].task.task_id);
    expect(records[1].key).toBe(records[0].key);
    expect(records[1].body).toEqual(records[0].body);
    // page.request不共享业务Token，另以当前实际会话凭据取得后端记录数。
    const token = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem('colla.phaseOne.session')!).token
    );
    const listed = await request.get(`/api/v1/teams/${records[0].task.team_id}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).data.items).toHaveLength(1);
    expect(new URL(page.url()).searchParams.getAll('StudyInstanceUIDs')).toEqual([sample.study]);
    await expect(page.locator('canvas').first()).toBeVisible();
  } finally {
    deliver();
  }
});

test('全失败不POST、不跳转，能重新选择并按单文件首次标题真实登记', async ({ page, request }) => {
  await login(page, request);
  let posts = 0;
  page.on('request', req => {
    if (req.method() === 'POST' && taskPath(req.url())) {
      posts++;
    }
  });
  await page
    .getByLabel('导入文件', { exact: true })
    .setInputFiles({ name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toContainText('没有可用影像');
  await expect(page).toHaveURL(/\/local-mask$/);
  expect(posts).toBe(0);
  const sample = syntheticSeries(1);
  sample.files[0].name = '单文件.dcm';
  const written = page.waitForResponse(
    response => response.request().method() === 'POST' && taskPath(response.url())
  );
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(sample.files[0]);
  const response = await written;
  expect(response.status()).toBe(200);
  expect((await response.json()).data.title).toBe('单文件.dcm');
  await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
  expect(posts).toBe(1);
});

test('文件夹使用共同首级目录名，嵌套文件经真实解析后登记', async ({ page, request }) => {
  await login(page, request);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-one-c-'));
  const folder = path.join(temp, '项目根目录'),
    nested = path.join(folder, '嵌套');
  try {
    await fs.mkdir(nested, { recursive: true });
    const sample = syntheticSeries();
    await Promise.all(
      sample.files.map(file => fs.writeFile(path.join(nested, file.name), file.buffer))
    );
    const written = page.waitForResponse(
      response => response.request().method() === 'POST' && taskPath(response.url())
    );
    await page.getByLabel('导入文件夹', { exact: true }).setInputFiles(folder);
    const response = await written;
    expect(response.status()).toBe(200);
    expect((await response.json()).data.title).toBe('项目根目录');
    await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
    expect(new URL(page.url()).searchParams.getAll('StudyInstanceUIDs')).toEqual([sample.study]);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('原生Local保持原解析导航，导入全程不发Task业务请求', async ({ page }) => {
  let posts = 0;
  page.on('request', req => {
    if (req.method() === 'POST' && taskPath(req.url())) {
      posts++;
    }
  });
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  await page.goto('/local');
  await expect(page.getByRole('button', { name: 'Load files', exact: true })).toBeVisible();
  const sample = syntheticSeries(1);
  await page.locator('input[type=file]').first().setInputFiles(sample.files[0]);
  // 原生Local先进入Study List，WorkList会规范化查询参数；选模式后才进入Viewer。
  await expect(page.getByRole('heading', { name: 'Study List', exact: true })).toBeVisible();
  const study = page.locator(`[data-cy="${sample.study}"]`);
  await expect(study).toContainText('Synthetic Import Test - Not Patient Data');
  await study.click();
  await page
    .locator(`[data-cy="studyRow-${sample.study}"] [data-cy="mode-viewer-${sample.study}"]`)
    .click();
  await expect(page).toHaveURL(/\/viewer(?:\/dicomlocal)?\?/);
  expect(new URL(page.url()).searchParams.getAll('StudyInstanceUIDs')).toContain(sample.study);
  expect(posts).toBe(0);
});

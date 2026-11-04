import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syntheticSeries } from './syntheticDicom';
const password = 'workspace-storage-test';
const fixtures = process.env.COLLA_CAPACITY_FIXTURES ?? '/Users/itboybob/Project/colla_tool/data';
async function account(request: APIRequestContext) {
  const r = await request.post('/api/v1/users', {
    data: { username: '保存-' + randomUUID().slice(0, 8), password },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).data;
}
async function login(page: Page, user: any) {
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(user.user.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    l => l.click()
  );
}
async function create(page: Page, files: any) {
  page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
  page.on('response', async r => {
    if (r.status() >= 400 && r.url().includes('/api/v1/'))
      console.log('API_FAILURE', r.status(), r.url(), await r.text().catch(() => ''));
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '创建新任务', exact: true }).click();
  const done = page.waitForResponse(
    r =>
      r.request().method() === 'POST' &&
      /\/task-imports\/[^/]+\/complete$/.test(new URL(r.url()).pathname),
    { timeout: 300000 }
  );
  await (await chooser).setFiles(files);
  await expect(page.locator('.team-page-create [role=alert]')).toHaveCount(0);
  const r = await done;
  expect(r.status()).toBe(200);
  const task = (await r.json()).data;
  await expect(page).toHaveURL(/segmentation\/dicomlocal/);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean((window as any).services?.businessServices?.projectRuntime?.getCurrent()?.task_id)
        ),
      { timeout: 60000 }
    )
    .toBe(true);
  await expect(page.getByRole('status').filter({ hasText: /成果已(同步|保存)/ })).toBeVisible({
    timeout: 60000,
  });
  return task;
}
async function nativeState(page: Page) {
  return page.evaluate(() => {
    const w = window as any,
      s = w.services;
    return {
      masks: s.segmentationService.getSegmentations().map((m: any) => ({
        id: m.segmentationId,
        label: m.label,
        segments: Object.fromEntries(
          Object.entries(m.segments).map(([key, value]: any) => [
            key,
            { label: value.label, segmentIndex: value.segmentIndex, locked: value.locked },
          ])
        ),
        frames: w.cornerstoneTools.segmentation
          .getLabelmapImageIds(m.segmentationId)
          .map((id: string) =>
            Array.from(w.cornerstone.cache.getImage(id).voxelManager.getScalarData())
          ),
      })),
      measurements: s.measurementService
        .getMeasurements()
        .map((m: any) => ({ uid: m.uid, toolName: m.toolName, points: m.points })),
    };
  });
}

test('邀请红点、查看标读、接受入队、真实切队及重登保留', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  const a = await account(request),
    b = await account(request);
  await login(page, b);
  const sent = await request.post(`/api/v1/teams/${a.default_team_id}/invitations`, {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { username: b.user.username },
  });
  expect(sent.status()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('有未读通知')).toBeVisible();
  await page.getByRole('button', { name: '通知', exact: true }).click();
  await expect(page.getByText(a.user.username, { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel('有未读通知')).toHaveCount(0);
  let notices = await request.get('/api/v1/notifications/team-invitations', {
    headers: { Authorization: `Bearer ${b.token}` },
  });
  const item = (await notices.json()).data[0];
  expect(item.decision).toBe('pending');
  expect(item.read_at).not.toBeNull();
  await page.getByRole('button', { name: '接受', exact: true }).click();
  await expect
    .poll(async () => {
      const r = await request.get('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${b.token}` },
      });
      return (await r.json()).data.memberships.length;
    })
    .toBe(2);
  await expect(page.getByText('已接受', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭通知弹窗', exact: true }).click();
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('menuitem', { name: '查看我的团队' }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(a.user.username) }).click();
  await expect(
    page.getByRole('heading', { name: a.user.username + '的团队', exact: true })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: a.user.username + '的团队', exact: true })
  ).toBeVisible();
  const context = await browser.newContext({ baseURL });
  try {
    const other = await context.newPage();
    await login(other, b);
    await expect(
      other.getByRole('heading', { name: a.user.username + '的团队', exact: true })
    ).toBeVisible();
    await expect(other.getByLabel('有未读通知')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('原图与非空Mask自动保存后关闭A窗口，B从后端重开并恢复删除结果', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  test.setTimeout(180000);
  const a = await account(request),
    b = await account(request);
  const invitation = await request.post(`/api/v1/teams/${a.default_team_id}/invitations`, {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { username: b.user.username },
  });
  const inv = (await invitation.json()).data;
  expect(
    (
      await request.post(`/api/v1/invitations/${inv.invitation_id}/accept`, {
        headers: { Authorization: `Bearer ${b.token}` },
      })
    ).status()
  ).toBe(200);
  await login(page, a);
  const task = await create(page, syntheticSeries(8).files);
  await page.locator('[data-cy="addSegmentation"]').click();
  await page.getByLabel('阈值下限', { exact: true }).fill('50');
  await page.getByLabel('阈值上限', { exact: true }).fill('150');
  await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
  await expect(page.locator('section[aria-label="Mask 编辑"]').getByRole('status')).toContainText(
    '阈值选区完成'
  );
  await page.evaluate(async () => {
    const w = window as any,
      s = w.services;
    const m = s.segmentationService.getSegmentations()[0];
    s.segmentationService.setSegmentLabel(m.segmentationId, 1, '已保存区域');
    await w.commandsManager.run('runSegmentBidirectional', {
      segmentationId: m.segmentationId,
      segmentIndex: 1,
    });
  });
  await expect(page.getByRole('status').filter({ hasText: '成果已保存' })).toBeVisible({
    timeout: 30000,
  });
  const expected = await nativeState(page);
  expect(expected.masks[0].frames.flat().some((x: any) => x !== 0)).toBe(true);
  await page.close();
  const context = await browser.newContext({ baseURL });
  try {
    const view = await context.newPage();
    await login(view, b);
    await view.getByRole('button', { name: '我的', exact: true }).click();
    await view.getByRole('menuitem', { name: '查看我的团队' }).click();
    await view.getByRole('menuitemradio', { name: new RegExp(a.user.username) }).click();
    await expect(view.locator(`[data-task-id="${task.task_id}"] img`)).toBeVisible({
      timeout: 30000,
    });
    await view.locator(`[data-task-id="${task.task_id}"]`).click();
    await expect(view).toHaveURL(/segmentation\/dicomlocal/);
    await expect(view.getByRole('status').filter({ hasText: /成果已(同步|保存)/ })).toBeVisible({
      timeout: 60000,
    });
    expect(await nativeState(view)).toEqual(expected);
    expect(
      await view.evaluate(() => {
        const w = window as any;
        const s = w.services;
        w.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
        const group = s.toolGroupService.getToolGroupForViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return group.getToolInstances().CircularBrush.mode;
      })
    ).toBe('Active');
    await view.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(
      view.getByRole('status').filter({ hasText: '连接已断开，编辑暂停' })
    ).toBeVisible();
    expect(
      await view.evaluate(() => {
        const w = window as any,
          s = w.services;
        w.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
        const group = s.toolGroupService.getToolGroupForViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return group.getToolInstances().CircularBrush.mode;
      })
    ).toBe('Enabled');
    await expect(
      view.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeDisabled();
    await view.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(view.getByRole('status').filter({ hasText: /成果已(同步|保存)/ })).toBeVisible({
      timeout: 30000,
    });
    expect(await nativeState(view)).toEqual(expected);
    await view.evaluate(() => {
      const s = (window as any).services;
      for (const m of s.segmentationService.getSegmentations())
        s.segmentationService.remove(m.segmentationId);
    });
    await expect
      .poll(async () => {
        const r = await request.get(`/api/v1/tasks/${task.task_id}/results`, {
          headers: { Authorization: `Bearer ${b.token}` },
        });
        return (await r.json()).data.objects.length;
      })
      .toBe(0);
    await view.reload();
    await expect(view.getByRole('status').filter({ hasText: /成果已(同步|保存)/ })).toBeVisible({
      timeout: 60000,
    });
    expect((await nativeState(view)).masks).toHaveLength(0);
  } finally {
    await context.close();
  }
});

for (const count of [200, 800])
  test(`${count}文件单Study真实导入容量验证`, async ({ page, request }) => {
    test.setTimeout(600000);
    const user = await account(request);
    await login(page, user);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colla-study-'));
    if (!fs.existsSync(path.join(fixtures, `synthetic-ct-study-${count}.zip`)))
      execFileSync('python3', ['.scripts/generate-study-fixtures.py', '--output-dir', fixtures]);
    try {
      execFileSync('python3', [
        '-c',
        'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
        path.join(fixtures, `synthetic-ct-study-${count}.zip`),
        dir,
      ]);
      const files = fs
        .readdirSync(path.join(dir, `study-${count}`))
        .sort()
        .map(name => path.join(dir, `study-${count}`, name));
      expect(files).toHaveLength(count);
      const task = await create(page, files);
      const r = await request.get(`/api/v1/tasks/${task.task_id}/materials`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      expect(r.status()).toBe(200);
      const material = (await r.json()).data;
      expect(material.source.files).toHaveLength(count);
      expect(material.source.files.reduce((s: number, f: any) => s + f.size, 0)).toBeGreaterThan(
        count * 512 * 512 * 2
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).services.businessServices.localProjects.getCurrent().successes.length
          )
        )
        .toBe(count);
      for (const index of [0, count - 1]) {
        const spec = [...material.source.files].sort(
          (a: any, b: any) => a.selection_index - b.selection_index
        )[index];
        const response = await request.get(`/api/v1/tasks/${task.task_id}/files/${spec.file_id}`, {
          headers: { Authorization: `Bearer ${user.token}` },
        });
        expect(response.status()).toBe(200);
        expect(await response.body()).toEqual(fs.readFileSync(files[index]));
      }
      await page.locator('[data-cy="addSegmentation"]').click();
      await page.getByLabel('阈值处理范围', { exact: true }).selectOption('slice');
      await page.getByLabel('阈值下限', { exact: true }).fill('50');
      await page.getByLabel('阈值上限', { exact: true }).fill('150');
      await page.getByRole('button', { name: '应用阈值到当前切片', exact: true }).click();
      await expect(
        page.locator('section[aria-label="Mask 编辑"]').getByRole('status')
      ).toContainText('阈值选区完成');
      await expect(page.getByRole('status').filter({ hasText: '成果已保存' })).toBeVisible({
        timeout: 120000,
      });
      const saved = await request.get(`/api/v1/tasks/${task.task_id}/results`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      const seg = (await saved.json()).data.objects.find((o: any) => o.type === 'SEG');
      expect(seg).toBeTruthy();
      const head = await request.head(
        `/api/v1/tasks/${task.task_id}/result-files/${seg.object_id}`,
        { headers: { Authorization: `Bearer ${user.token}` } }
      );
      expect(head.status()).toBe(200);
      expect(Number(head.headers()['content-length'])).toBeGreaterThan(count * 512 * 512);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

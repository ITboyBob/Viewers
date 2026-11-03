import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { syntheticSeries } from './syntheticDicom';
import type { ProjectTestWindow } from './project-events.spec';

for (const path of ['/local', '/localbasic']) {
  test(`原生${path}保留真实解析、影像与输出入口，全程无Task写入`, async ({ page, request }) => {
    const username = `native-${randomUUID().slice(0, 8)}`,
      password = 'synthetic-password';
    expect((await request.post('/api/v1/users', { data: { username, password } })).status()).toBe(
      201
    );
    await page.goto('/account/login');
    await page.getByLabel('用户名').fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/team\/tasks$/);
    let writes = 0;
    page.on('request', req => {
      if (
        req.method() !== 'GET' &&
        /\/api\/v1\/teams\/[^/]+\/tasks(?:\/|$)/.test(new URL(req.url()).pathname)
      ) {
        writes++;
      }
    });
    await page.addLocatorHandler(
      page.getByRole('button', { name: 'Confirm and hide', exact: true }),
      locator => locator.click()
    );
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Load files', exact: true })).toBeVisible();
    const sample = syntheticSeries();
    await page.locator('input[type=file]').first().setInputFiles(sample.files);
    if (path === '/local') {
      await expect(page.getByRole('heading', { name: 'Study List', exact: true })).toBeVisible();
      const study = page.locator(`[data-cy="${sample.study}"]`);
      await expect(study).toBeVisible();
      await expect(study).toContainText('Synthetic Import Test - Not Patient Data');
      await expect(
        study.getByRole('cell', { name: String(sample.files.length), exact: true })
      ).toBeVisible();
      await study.click();
      const viewer = page.locator(
        `[data-cy="studyRow-${sample.study}"] [data-cy="mode-viewer-${sample.study}"]`
      );
      await expect(viewer).toBeEnabled();
      await viewer.click();
      await expect(page).toHaveURL(/\/viewer(?:\/dicomlocal)?\?/);
    }
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(new URL(page.url()).searchParams.getAll('StudyInstanceUIDs')).toContain(sample.study);
    expect(writes).toBe(0);
    // 调用既有原生输出命令，验证原对话框仍存在，不新增业务保存服务。
    await page.evaluate(() =>
      (window as unknown as ProjectTestWindow).commandsManager.run('showDownloadViewportModal')
    );
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(writes).toBe(0);
  });
}

test('mask原生测量、分割、MPR和刷子实际绘制仍可用', async ({ page, request }) => {
  const username = `brush-${randomUUID().slice(0, 8)}`,
    password = 'synthetic-password';
  expect((await request.post('/api/v1/users', { data: { username, password } })).status()).toBe(
    201
  );
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.goto('/local-mask');
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(syntheticSeries().files);
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.locator('[data-cy="addSegmentation"]').click();
  await expect(page.getByRole('button', { name: '应用阈值到整组切片', exact: true })).toBeEnabled();
  await page.evaluate(() =>
    (window as unknown as ProjectTestWindow).commandsManager.run('setHangingProtocol', {
      protocolId: 'mpr',
      reset: true,
    })
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as ProjectTestWindow).services;
        const viewport = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return viewport?.type === 'orthographic' && Boolean(viewport.getImageData());
      })
    )
    .toBe(true);
  let dataUpdates = 0;
  page.on('request', req => {
    if (req.method() === 'PATCH' && req.url().endsWith('/updated-at')) {
      dataUpdates++;
    }
  });
  const point = await page.evaluate(() => {
    const w = window as unknown as ProjectTestWindow;
    const audit = { count: 0, stop: () => {} };
    const segmentation = w.services.segmentationService;
    const subscription = segmentation.subscribe(
      segmentation.EVENTS.SEGMENTATION_DATA_MODIFIED,
      () => {
        audit.count++;
      }
    );
    audit.stop = () => subscription.unsubscribe();
    w.eventAudit = audit;
    w.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
    w.commandsManager.run('setBrushSize', { value: 3, toolNames: ['CircularBrush'] });
    const s = w.services,
      rect = s.cornerstoneViewportService
        .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
        .element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x - 6, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 6, point.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.count))
    .toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.stop());
  await expect.poll(() => dataUpdates).toBeGreaterThan(0);
  await expect(page.locator('canvas').first()).toBeVisible();
});

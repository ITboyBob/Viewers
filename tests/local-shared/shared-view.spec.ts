import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { syntheticSeries } from '../phase-one/syntheticDicom';
import type { ProjectTestWindow } from '../phase-one/project-events.spec';

async function login(page: Page, request: APIRequestContext, label: string) {
  const username = `${label}-${randomUUID().slice(0, 8)}`,
    password = 'shared-view-synthetic';
  const response = await request.post('/api/v1/users', { data: { username, password } });
  expect(response.status()).toBe(201);
  const uid = (await response.json()).data.user.uid;
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  return uid;
}
async function source(page: Page, request: APIRequestContext) {
  const uid = await login(page, request, 'source');
  const sample = syntheticSeries(3);
  const registered = page.waitForResponse(
    response =>
      response.request().method() === 'POST' && /\/tasks$/.test(new URL(response.url()).pathname)
  );
  await page
    .getByLabel('导入文件', { exact: true })
    .setInputFiles([
      { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('invalid') },
      ...sample.files,
    ]);
  expect((await registered).status()).toBe(201);
  await expect(page.getByRole('link', { name: '共享链接', exact: true })).toBeVisible();
  const href = await page.getByRole('link', { name: '共享链接', exact: true }).getAttribute('href');
  const original = await page.evaluate(() => {
    const business = (window as unknown as ProjectTestWindow).services.businessServices;
    const project = business.projectRuntime!.getCurrent()!;
    return {
      task: project.task_id,
      batch: project.batch_id,
      team: project.team_id,
      title: project.title,
      files: project.successes.map(file => ({
        index: file.selection_index,
        image: file.image_id,
        sop: file.sop_uid,
      })),
    };
  });
  return { uid, href: href!, original };
}
async function hasImage(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const services = (window as unknown as ProjectTestWindow).services;
        const viewport = services.cornerstoneViewportService.getCornerstoneViewport(
          services.viewportGridService.getActiveViewportId()
        );
        return !!viewport?.getImageData()?.imageData;
      })
    )
    .toBe(true);
}
test('G3：A一次导入，B不选文件独立进入同任务，刷新重建，A离开保留B画面', async ({
  page,
  request,
}) => {
  let sourceCreates = 0;
  page.on('request', req => {
    if (req.method() === 'POST' && /\/tasks$/.test(new URL(req.url()).pathname)) {
      sourceCreates++;
    }
  });
  const a = await source(page, request);
  await hasImage(page);
  const viewer = await page.context().newPage();
  const bUid = await login(viewer, request, 'viewer');
  const writes: string[] = [];
  viewer.on('request', req => {
    if (/\/tasks(?:\/|$)/.test(new URL(req.url()).pathname)) {
      writes.push(req.method());
    }
  });
  await viewer.goto(a.href);
  await expect(viewer.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await hasImage(viewer);
  const first = await viewer.evaluate(() => {
    const business = (window as unknown as ProjectTestWindow).services.businessServices;
    const shared = business.localCollaboration!;
    const view = shared.sharedView!.getSnapshot()!;
    return {
      task: view.task_id,
      batch: view.batch_id,
      title: view.title,
      team: view.team_id,
      importer: view.importer_uid,
      viewer: view.viewer_uid,
      ready: view.view_ready,
      scope: view.scope_handle!.isActive!(),
      files: view.local_files.map(file => ({
        index: file.selection_index,
        image: file.image_id,
        sop: file.sop_uid,
      })),
      project: business.localProjects!.getCurrent(),
      mask: business.projectRuntime!.phaseOneMask,
      participant: shared.participation!.identity.participant_id,
      colors: shared.participation!.getSnapshot().color_registry,
    };
  });
  expect(first).toMatchObject({
    task: a.original.task,
    batch: a.original.batch,
    title: a.original.title,
    team: a.original.team,
    importer: a.uid,
    viewer: bUid,
    ready: true,
    scope: true,
    project: null,
    mask: false,
  });
  expect(first.files.map(({ index, sop }) => ({ index, sop }))).toEqual(
    a.original.files.map(({ index, sop }) => ({ index, sop }))
  );
  expect(first.files.some((file, index) => file.image !== a.original.files[index].image)).toBe(
    true
  );
  expect(sourceCreates).toBe(1);
  expect(writes).toEqual([]);
  await viewer.reload();
  await expect(viewer.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await hasImage(viewer);
  const reentry = await viewer.evaluate(() => {
    const shared = (window as unknown as ProjectTestWindow).services.businessServices
      .localCollaboration!;
    return {
      participant: shared.participation!.identity.participant_id,
      colors: shared.participation!.getSnapshot().color_registry,
    };
  });
  expect(reentry.participant).not.toBe(first.participant);
  expect(reentry.colors).toEqual(first.colors);
  await page.goto('/local-mask');
  await expect(viewer.getByRole('status').filter({ hasText: '源窗口已离开' })).toBeVisible();
  await hasImage(viewer);
  expect(
    await viewer.evaluate(() =>
      (
        window as unknown as ProjectTestWindow
      ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!.scope_handle!
        .isActive!()
    )
  ).toBe(true);
  await viewer.reload();
  await expect(viewer.getByRole('alert').filter({ hasText: '本地共享不可用' })).toBeVisible({
    timeout: 25000,
  });
  expect(await viewer.locator('.cornerstone-viewport-element').count()).toBe(0);
  expect(writes).toEqual([]);
  expect(sourceCreates).toBe(1);
  await viewer.close();
});

test('G3：active确认前源关闭取消本窗加载并释放本次资源', async ({ page, request }) => {
  const a = await source(page, request);
  const viewer = await page.context().newPage();
  await login(viewer, request, 'cancel');
  let checks = 0,
    releaseCheck: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    releaseCheck = resolve;
  });
  await page.route('**/api/v1/auth/sessions/current', async route => {
    checks++;
    if (checks === 2) {
      await gate;
    }
    try {
      await route.continue();
    } catch (_error) {
      /* 源页关闭后的旧请求已被浏览器取消。 */
    }
  });
  await viewer.goto(a.href);
  await expect.poll(() => checks).toBe(2);
  await page.goto('/local-mask');
  releaseCheck();
  await expect(viewer.getByRole('alert').filter({ hasText: '本地共享不可用' })).toBeVisible();
  const cancelled = await viewer.evaluate(() => {
    const view = (
      window as unknown as ProjectTestWindow
    ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!;
    return { ready: view.view_ready, files: view.local_files.length, scope: view.scope_handle };
  });
  expect(cancelled).toEqual({ ready: false, files: 0, scope: null });
  expect(await viewer.locator('.cornerstone-viewport-element').count()).toBe(0);
  await viewer.close();
});

test('G3：B自己的真实401优先invalid，保留已完成画面且不影响A', async ({ page, request }) => {
  const a = await source(page, request);
  const viewer = await page.context().newPage();
  await login(viewer, request, 'identity');
  const writes: string[] = [];
  viewer.on('request', req => {
    if (/\/tasks(?:\/|$)/.test(new URL(req.url()).pathname)) {
      writes.push(req.method());
    }
  });
  await viewer.goto(a.href);
  await expect(viewer.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await hasImage(viewer);
  const unauthorized = viewer.waitForResponse(
    response =>
      response.status() === 401 &&
      new URL(response.url()).pathname.endsWith('/auth/sessions/current')
  );
  await viewer.evaluate(async () => {
    const business = (window as unknown as ProjectTestWindow).services.businessServices;
    // 仅注销本测试B自己的真实会话，不读取或输出凭据。
    await business.api.request('/auth/sessions/current', { method: 'DELETE' });
    await business.session.validateCurrent();
  });
  await unauthorized;
  await expect(viewer.getByRole('alert').filter({ hasText: '当前身份已失效' })).toBeVisible();
  expect(
    await viewer.evaluate(() => {
      const shared = (window as unknown as ProjectTestWindow).services.businessServices
        .localCollaboration!;
      const view = shared.sharedView!.getSnapshot()!;
      return {
        phase: view.phase,
        ready: view.view_ready,
        activeScope: view.scope_handle!.isActive!(),
      };
    })
  ).toEqual({ phase: 'invalid', ready: true, activeScope: true });
  await hasImage(viewer);
  expect(writes).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as ProjectTestWindow
          ).services.businessServices.localCollaboration!.participation!.getSnapshot().members
            .length
      )
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as ProjectTestWindow).services.businessServices.session.getSnapshot()
          .status
    )
  ).toBe('authenticated');
  await viewer.close();
});

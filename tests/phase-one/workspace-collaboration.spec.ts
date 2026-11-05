import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { syntheticSeries } from './syntheticDicom';
import { isImportComplete, workspaceReady } from './businessImport';
const password = 'collaboration-workspace-test';
async function account(request: APIRequestContext) {
  const r = await request.post('/api/v1/users', {
    data: { username: '协作-' + randomUUID().slice(0, 8), password },
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
async function create(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '创建新任务', exact: true }).click();
  const completed = page.waitForResponse(
    r => r.request().method() === 'POST' && isImportComplete(r.url())
  );
  await (await chooser).setFiles(syntheticSeries(4).files);
  const response = await completed;
  expect(response.status()).toBe(200);
  const task = (await response.json()).data;
  await expect(page).toHaveURL(/segmentation\/dicomlocal/);
  await workspaceReady(page);
  return task;
}
async function masks(page: Page) {
  return page.evaluate(() =>
    (window as any).services.segmentationService
      .getSegmentations()
      .map((s: any) => s.segmentationId)
  );
}
async function createMask(page: Page) {
  await page.locator('[data-cy="addSegmentation"]').click();
  await expect.poll(() => masks(page)).toHaveLength(1);
  await page.evaluate(() => {
    const w = window as any,
      s = w.services;
    w.commandsManager.run('addSegment', {
      segmentationId: s.segmentationService.getSegmentations()[0].segmentationId,
    });
  });
}
for (const permission of ['edit', 'view'] as const) {
  test(`${permission} 真实协作邀请、不入队、同任务恢复和定向分割权限`, async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    test.setTimeout(180000);
    page.setDefaultTimeout(15000);
    const owner = await account(request),
      recipient = await account(request);
    await login(page, owner);
    const task = await create(page);
    await createMask(page);
    await expect
      .poll(async () => {
        const r = await request.get(`/api/v1/tasks/${task.task_id}/results`, {
          headers: { Authorization: `Bearer ${owner.token}` },
        });
        return (await r.json()).data.revision;
      })
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: '邀请', exact: true }).click();
    expect(await page.getByRole('combobox', { name: '权限', exact: true }).inputValue()).toBe(
      'edit'
    );
    await expect(page.getByText(/合成|模拟|陈晨|李敏|周宁/)).toHaveCount(0);
    await page.getByLabel('用户名', { exact: true }).fill(recipient.user.username);
    await page.getByRole('combobox', { name: '权限', exact: true }).selectOption(permission);
    const sent = page.waitForResponse(
      r =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/collaboration-invitations')
    );
    await page.getByRole('button', { name: '按用户名邀请' }).click();
    expect((await sent).status()).toBe(201);
    await expect(page.getByRole('button', { name: '按用户名邀请' })).toHaveText('已邀请');
    await page.getByRole('button', { name: '关闭邀请弹窗' }).click();
    await page.getByRole('button', { name: '邀请', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill(recipient.user.username);
    await expect(page.getByRole('button', { name: '按用户名邀请' })).toBeDisabled();
    await page.getByRole('button', { name: '关闭邀请弹窗' }).click();
    const context = await browser.newContext({ baseURL });
    const receiver = await context.newPage();
    try {
      await login(receiver, recipient);
      await receiver.getByRole('button', { name: '通知', exact: true }).click();
      const row = receiver.getByRole('article', { name: `工作台协作邀请 ${task.title}` });
      await expect(row).toBeVisible();
      await expect(row.getByText(/可编辑|仅查看/)).toHaveCount(0);
      let acceptRequests = 0;
      receiver.on('request', r => {
        if (
          r.method() === 'POST' &&
          /collaboration-invitations\/[^/]+\/accept$/.test(new URL(r.url()).pathname)
        )
          acceptRequests++;
      });
      if (permission === 'view') {
        let failed = false;
        await receiver.route(`**/api/v1/tasks/${task.task_id}/files/*`, route => {
          if (!failed) {
            failed = true;
            return route.abort('failed');
          }
          return route.continue();
        });
      }
      await row.getByRole('button', { name: '接受', exact: true }).click();
      if (permission === 'view') {
        await expect(row.getByText('已接受', { exact: true })).toBeVisible();
        await expect(row.getByText(/邀请已接受；工作台加载失败/)).toBeVisible();
        await row.getByRole('button', { name: '重试进入工作台' }).click();
      }
      await expect(receiver).toHaveURL(new RegExp(`task_id=${task.task_id}`));
      await workspaceReady(receiver);
      expect(acceptRequests).toBe(1);
      await expect.poll(() => masks(receiver)).toHaveLength(1);
      const headers = { Authorization: `Bearer ${recipient.token}` };
      const material = (
        await (await request.get(`/api/v1/tasks/${task.task_id}/materials`, { headers })).json()
      ).data;
      expect(material.access.can_edit).toBe(true);
      expect(material.access.can_add_segmentation).toBe(permission === 'edit');
      const session = (
        await (await request.get('/api/v1/auth/sessions/current', { headers })).json()
      ).data;
      expect(session.memberships.map((m: any) => m.team_id)).not.toContain(owner.default_team_id);
      expect(session.selected_team_id).toBe(recipient.default_team_id);
      const original = await masks(receiver);
      // 调用公开命令而非修改内部权限；view 不能绕过按钮，edit 保持正常。
      await receiver.evaluate(async () => {
        const w = window as any;
        await w.commandsManager.run('createLabelmapForViewport', {
          viewportId: w.services.viewportGridService.getActiveViewportId(),
        });
      });
      await expect.poll(() => masks(receiver)).toHaveLength(permission === 'edit' ? 2 : 1);
      if (permission === 'view') {
        // 已有分割添加 segment 与测量仍可用，并通过真实成果提交确认。
        const before = await receiver.evaluate(
          () =>
            Object.keys((window as any).services.segmentationService.getSegmentations()[0].segments)
              .length
        );
        await receiver.evaluate(() => {
          const w = window as any;
          w.commandsManager.run('addSegment', {
            segmentationId: w.services.segmentationService.getSegmentations()[0].segmentationId,
          });
        });
        await expect
          .poll(() =>
            receiver.evaluate(
              () =>
                Object.keys(
                  (window as any).services.segmentationService.getSegmentations()[0].segments
                ).length
            )
          )
          .toBe(before + 1);
        await expect(receiver.getByRole('status').filter({ hasText: /成果已保存/ })).toBeVisible();
        expect(
          (await (await request.get(`/api/v1/tasks/${task.task_id}/results`, { headers })).json())
            .data.access.can_edit
        ).toBe(true);
      }
      if (permission === 'view') {
        const box = await receiver.evaluate(() => {
          const w = window as any,
            services = w.services,
            id = services.viewportGridService.getActiveViewportId();
          const group = services.toolGroupService.getToolGroupForViewport(id);
          if (!group.hasTool('Length')) group.addTool('Length');
          w.commandsManager.run('setToolActiveToolbar', {
            toolName: 'Length',
            toolGroupIds: [group.id],
          });
          const rect = services.cornerstoneViewportService
            .getCornerstoneViewport(id)
            .element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        await expect
          .poll(() =>
            receiver.evaluate(() => {
              const s = (window as any).services;
              return s.toolGroupService
                .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
                .getActivePrimaryMouseButtonTool();
            })
          )
          .toBe('Length');
        await receiver.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
        await receiver.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
        await receiver.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
        await expect
          .poll(async () =>
            (
              await (await request.get(`/api/v1/tasks/${task.task_id}/results`, { headers })).json()
            ).data.objects.some((item: any) => item.type === 'SR')
          )
          .toBe(true);
      }
      await receiver.reload();
      await workspaceReady(receiver);
      const reloaded = (
        await (await request.get(`/api/v1/tasks/${task.task_id}/materials`, { headers })).json()
      ).data;
      expect(reloaded.access.can_add_segmentation).toBe(permission === 'edit');
      expect(await masks(receiver)).toEqual(expect.arrayContaining(original));
      if (permission === 'view') {
        const workspaceUrl = receiver.url();
        await receiver.goto('/team/tasks');
        await receiver.getByRole('button', { name: '我的', exact: true }).click();
        await receiver.getByRole('menuitem', { name: '退出登录', exact: true }).click();
        await expect(receiver).toHaveURL(/\/account\/login/);
        await login(receiver, recipient);
        await receiver.goto(workspaceUrl);
        await workspaceReady(receiver);
        expect(
          (await (await request.get(`/api/v1/tasks/${task.task_id}/materials`, { headers })).json())
            .data.access.can_add_segmentation
        ).toBe(false);
      }
      // 删除已有分割后在空列表观察 Add Segmentation 的可见禁用与键盘行为。
      if (permission === 'view') {
        await receiver.evaluate(() => {
          const w = window as any;
          for (const s of w.services.segmentationService.getSegmentations())
            w.commandsManager.run('deleteSegmentation', { segmentationId: s.segmentationId });
        });
        const add = receiver.locator('[data-cy="addSegmentation"]');
        await expect(add).toBeVisible();
        await expect(add).toHaveText('Add Segmentation');
        await expect(add).toBeDisabled();
        await add.hover();
        await expect(add).toHaveCSS('cursor', 'not-allowed');
        await receiver.keyboard.press('Enter');
        await receiver.keyboard.press('Space');
        expect(await masks(receiver)).toHaveLength(0);
      }
    } finally {
      await context.close();
    }
  });
}

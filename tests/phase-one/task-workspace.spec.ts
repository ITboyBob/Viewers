import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  BusinessServices,
  BusinessTask,
  IssuedBusinessSession,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from './syntheticDicom';

type WorkspaceWindow = Window & {
  services: any;
  commandsManager: any;
  cornerstone: any;
  cornerstoneTools: any;
};
const password = 'workspace-synthetic';
async function account(request: APIRequestContext) {
  const response = await request.post('/api/v1/users', {
    data: { username: `重开验收-${randomUUID().slice(0, 8)}`, password },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as IssuedBusinessSession;
}
async function login(page: Page, user: IssuedBusinessSession) {
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(user.user.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
}
const pathFor = (view: string) => (view === 'team' ? '/team/tasks' : '/team/recent');
async function create(page: Page, files: ReturnType<typeof syntheticSeries>['files']) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '创建新任务', exact: true }).click();
  const registered = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      /\/teams\/[^/]+\/tasks$/.test(new URL(response.url()).pathname)
  );
  await (await chooser).setFiles(files);
  const response = await registered;
  expect(response.status()).toBe(201);
  const task = (await response.json()).data as BusinessTask;
  await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as WorkspaceWindow).services;
        return !!s.cornerstoneViewportService
          .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
          ?.getImageData()?.imageData;
      })
    )
    .toBe(true);
  return task;
}
async function draw(page: Page, nonempty: boolean) {
  const box = await page.evaluate(() => {
    const w = window as unknown as WorkspaceWindow,
      s = w.services;
    const id = s.viewportGridService.getActiveViewportId(),
      group = s.toolGroupService.getToolGroupForViewport(id);
    if (!group.hasTool('Length')) group.addTool('Length');
    w.commandsManager.run('setToolActiveToolbar', { toolName: 'Length', toolGroupIds: [group.id] });
    const r = s.cornerstoneViewportService
      .getCornerstoneViewport(id)
      .element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as WorkspaceWindow).services;
        return s.toolGroupService
          .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
          ?.getActivePrimaryMouseButtonTool();
      })
    )
    .toBe('Length');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as WorkspaceWindow).services.measurementService.getMeasurements()
            .length
      )
    )
    .toBe(1);
  await page.locator('[data-cy="addSegmentation"]').click();
  await page.getByLabel('阈值下限', { exact: true }).fill(nonempty ? '50' : '1000');
  await page.getByLabel('阈值上限', { exact: true }).fill(nonempty ? '150' : '2000');
  await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
  await expect(page.locator('section[aria-label="Mask 编辑"]').getByRole('status')).toContainText(
    '阈值选区完成'
  );
  await page.evaluate(nonempty => {
    const s = (window as unknown as WorkspaceWindow).services;
    s.segmentationService.setSegmentLabel(
      s.segmentationService.getSegmentations()[0].segmentationId,
      1,
      nonempty ? '任务A区域' : '任务B区域'
    );
  }, nonempty);
}
async function state(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as WorkspaceWindow,
      s = w.services;
    return {
      task: s.businessServices.projectRuntime.getCurrent()?.task_id,
      measurements: s.measurementService
        .getMeasurements()
        .map(m => ({ uid: m.uid, toolName: m.toolName, points: m.points })),
      masks: s.segmentationService.getSegmentations().map(mask => ({
        id: mask.segmentationId,
        label: mask.segments[1].label,
        frames: w.cornerstoneTools.segmentation
          .getLabelmapImageIds(mask.segmentationId)
          .map(id => Array.from(w.cornerstone.cache.getImage(id).voxelManager.getScalarData())),
      })),
    };
  });
}
async function back(page: Page, path: string) {
  await page.getByRole('button', { name: '返回工作列表', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path + '$'));
  await expect(page.getByLabel('任务数量')).toBeVisible();
}
for (const view of ['team', 'recent'])
  test(`${view}：真实列表→A/B同UID任务→恢复测量和Mask像素→继续编辑，无重登记或恢复伪写入`, async ({
    page,
    request,
  }, info) => {
    const owner = await account(request),
      user = await account(request);
    const invitation = await request.post(`/api/v1/teams/${owner.default_team_id}/invitations`, {
      headers: { Authorization: `Bearer ${owner.token}` },
      data: { username: user.user.username },
    });
    expect(invitation.status()).toBe(201);
    const accepted = await request.post(
      `/api/v1/invitations/${(await invitation.json()).data.invitation_id}/accept`,
      { headers: { Authorization: `Bearer ${user.token}` } }
    );
    expect(accepted.status()).toBe(200);
    await login(page, user);
    await page.evaluate(team => {
      const key = 'colla.phaseOne.session',
        saved = JSON.parse(sessionStorage.getItem(key)!);
      sessionStorage.setItem(key, JSON.stringify({ ...saved, current_team_id: team }));
    }, owner.default_team_id);
    await page.reload();
    if (view === 'recent')
      await page.getByRole('button', { name: '最近任务', exact: true }).click();
    await expect(page.getByText('暂无任务', { exact: true })).toBeVisible();
    await expect(page.getByText(/示例数据|腹部 CT 示例|标注任务示例/)).toHaveCount(0);
    let registrations = 0,
      touches = 0;
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /\/teams\/[^/]+\/tasks$/.test(path)) registrations++;
      if (req.method() === 'PATCH' && path.endsWith('/updated-at')) touches++;
    });
    const sample = syntheticSeries(3);
    const a = await create(page, sample.files);
    expect(a.team_id).toBe(view === 'team' ? owner.default_team_id : user.default_team_id);
    await draw(page, true);
    const expectedA = await state(page);
    expect(expectedA.masks[0].frames.flat().some(value => value !== 0)).toBe(true);
    await back(page, pathFor(view));
    await expect(page.locator(`[data-task-id="${a.task_id}"]`)).toBeVisible();
    const b = await create(page, sample.files);
    await draw(page, false);
    const expectedB = await state(page);
    expect(expectedB.masks[0].frames.flat().every(value => value === 0)).toBe(true);
    await back(page, pathFor(view));
    const otherView = view === 'team' ? 'recent' : 'team';
    await page
      .getByRole('button', { name: otherView === 'team' ? '团队任务' : '最近任务', exact: true })
      .click();
    // 最近入口的任务属于自有团队；当前页面团队仍是已加入的团队，先从最近列表打开。
    if (view === 'recent')
      await page.getByRole('button', { name: '最近任务', exact: true }).click();
    const returnPath = '/team/recent';
    for (const expected of [expectedA, expectedB]) {
      const before = touches;
      await page.locator(`[data-task-id="${expected.task}"]`).click();
      await expect.poll(() => state(page)).toEqual(expected);
      await expect(
        page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
      ).toBeEnabled();
      // 原生异步事件也必须静默，不能把恢复当作用户编辑。
      await page.waitForTimeout(1200);
      expect(touches).toBe(before);
      await page.screenshot({
        path: info.outputPath(`恢复-${expected.task === a.task_id ? 'A' : 'B'}.png`),
      });
      await back(page, returnPath);
    }
    expect(registrations).toBe(2);
    await page.locator(`[data-task-id="${b.task_id}"]`).click();
    await expect.poll(() => state(page)).toEqual(expectedB);
    const beforeEdit = touches;
    await page.getByLabel('阈值下限', { exact: true }).fill('50');
    await page.getByLabel('阈值上限', { exact: true }).fill('150');
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect.poll(() => touches).toBeGreaterThan(beforeEdit);
    await back(page, returnPath);
    await page.reload();
    await page.locator(`[data-task-id="${b.task_id}"]`).click();
    await expect(page.getByRole('alert')).toContainText('需重新导入');
    await expect(page).toHaveURL(/\/team\/recent$/);
    expect(registrations).toBe(2);
  });

test('退出登录撤销当前凭证、清空任务内存，独立会话仍有效，后退不可恢复', async ({
  page,
  request,
}) => {
  const user = await account(request);
  await login(page, user);
  const task = await create(page, syntheticSeries(3).files);
  await back(page, '/team/tasks');
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('colla.phaseOne.session')!).token
  );
  await page.getByRole('button', { name: '我的', exact: true }).click();
  const revoked = page.waitForResponse(
    response =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === '/api/v1/auth/sessions/current'
  );
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/login$/);
  expect((await revoked).status()).toBe(204);
  expect(
    await page.evaluate(taskId => {
      const business: BusinessServices = (window as unknown as WorkspaceWindow).services
        .businessServices;
      return {
        stored: sessionStorage.getItem('colla.phaseOne.session'),
        project: business.localProjects?.getRetained(taskId),
        runtime: business.projectRuntime?.getCurrent(),
      };
    }, task.task_id)
  ).toEqual({ stored: null, project: null, runtime: null });
  expect(
    (
      await request.get('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status()
  ).toBe(401);
  expect(
    (
      await request.get('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${user.token}` },
      })
    ).status()
  ).toBe(200);
  await page.goBack();
  await expect(page).toHaveURL(/\/account\/login$/);
});

test('远端注销断网仍本地退出并显示未确认提示', async ({ page, request }) => {
  const user = await account(request);
  await login(page, user);
  await page.route('**/api/v1/auth/sessions/current', async route =>
    route.request().method() === 'DELETE' ? route.abort('failed') : route.continue()
  );
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/login$/);
  await expect(page.getByRole('alert')).toContainText('本地已退出，服务端撤销未确认');
  expect(await page.evaluate(() => sessionStorage.getItem('colla.phaseOne.session'))).toBeNull();
});

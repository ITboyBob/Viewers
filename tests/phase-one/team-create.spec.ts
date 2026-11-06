import { isImportComplete, workspaceReady } from './businessImport';
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type FileChooser,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  BusinessServices,
  IssuedBusinessSession,
  BusinessTask,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from './syntheticDicom';

const password = 'team-create-synthetic';
const storageKey = 'colla.phaseOne.session';
const isTaskPost = (url: string, method: string) => method === 'POST' && isImportComplete(url);
async function register(request: APIRequestContext) {
  const response = await request.post('/api/v1/users', {
    data: { username: `新建验收-${randomUUID().slice(0, 8)}`, password },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data as IssuedBusinessSession;
}
async function enter(
  page: Page,
  session: IssuedBusinessSession,
  currentTeam: string,
  path: string
) {
  await page.goto('/account/login');
  await page.evaluate(
    ({ session, currentTeam, storageKey }) => {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          token: session.token,
          expires_at: session.expires_at,
          current_team_id: currentTeam,
        })
      );
    },
    { session, currentTeam, storageKey }
  );
  expect(
    (
      await page.request.put('/api/v1/auth/sessions/current/team', {
        headers: { Authorization: `Bearer ${session.token}` },
        data: { team_id: currentTeam },
      })
    ).status()
  ).toBe(200);
  await page.goto(path);
  await expect(page.getByRole('button', { name: '创建新任务' })).toBeEnabled();
}
async function memberships(request: APIRequestContext) {
  const owner = await register(request),
    member = await register(request);
  const sent = await request.post(`/api/v1/teams/${owner.default_team_id}/invitations`, {
    headers: { Authorization: `Bearer ${owner.token}` },
    data: { username: member.user.username },
  });
  expect(sent.status()).toBe(201);
  const invitation = (await sent.json()).data;
  const accepted = await request.post(`/api/v1/invitations/${invitation.invitation_id}/accept`, {
    headers: { Authorization: `Bearer ${member.token}` },
  });
  expect(accepted.status()).toBe(200);
  return { owner, member };
}

for (const view of ['team', 'recent'] as const) {
  test(`${view}：真实文件选择器导入，分别绑定页面团队或自有团队并进入工作台`, async ({
    page,
    request,
  }, testInfo) => {
    const { owner, member } = await memberships(request);
    const path = view === 'team' ? '/team/tasks' : '/team/recent';
    const expectedTeam = view === 'team' ? owner.default_team_id : member.default_team_id;
    await enter(page, member, owner.default_team_id, path);
    if (view === 'team')
      await expect(
        page.getByRole('heading', { name: owner.memberships[0].name, exact: true })
      ).toBeVisible();
    await expect(page.getByRole('button', { name: '我的', exact: true })).toBeVisible();
    await expect(page.getByText('团队空间', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${view}-创建入口.png`) });
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await page.getByRole('menuitem', { name: '查看我的团队' }).click();
    const menu = page.getByRole('menu', { name: '团队列表', exact: true });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(menu).toContainText(member.memberships[0].name);
    await expect(menu.getByText(/示例团队|团队 A|团队 B/)).toHaveCount(0);
    await menu.screenshot({ path: testInfo.outputPath(`${view}-团队菜单.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '创建新任务' }).click();
    await page.getByRole('menuitem', { name: '选择文件', exact: true }).click();
    const selection = await chooser;
    expect(selection.isMultiple()).toBe(true);
    const sample = syntheticSeries();
    const written = page.waitForResponse(response =>
      isTaskPost(response.url(), response.request().method())
    );
    await selection.setFiles(sample.files);
    const response = await written;
    expect(response.status()).toBe(200);
    expect(isImportComplete(response.url())).toBe(true);
    const task: BusinessTask = (await response.json()).data;
    expect(task.team_id).toBe(expectedTeam);
    expect(task.assignee_uid).toBe(member.user.uid);
    expect(task.title).toBe(sample.files[0].name);
    expect(response.request().postDataJSON()).toBeNull();
    await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
    expect(new URL(page.url()).searchParams.getAll('StudyInstanceUIDs')).toEqual([sample.study]);
    await expect(page.locator('canvas').first()).toBeVisible();
    const state = await page.evaluate(() => {
      const business = (window as unknown as { services: { businessServices: BusinessServices } })
        .services.businessServices;
      const project = business.projectRuntime!.getCurrent()!;
      return {
        team: project.team_id,
        task: project.task_id,
        phase: project.phase,
        current: business.session.getSnapshot().currentTeamId,
      };
    });
    expect(state).toEqual({
      team: expectedTeam,
      task: task.task_id,
      phase: 'registered',
      current: owner.default_team_id,
    });
    await expect(page.getByRole('button', { name: '通知', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '邀请', exact: true })).toBeVisible();
    const membersRead = page.waitForResponse(
      response => new URL(response.url()).pathname === `/api/v1/tasks/${task.task_id}/members`
    );
    await page.getByRole('button', { name: '任务成员', exact: true }).click();
    const membersResponse = await membersRead;
    expect(membersResponse.status()).toBe(200);
    const expectedMembers = {
      task_id: task.task_id,
      owner_uid: member.user.uid,
      members: [{ uid: member.user.uid, username: member.user.username }],
      mock: false,
    };
    expect((await membersResponse.json()).data).toEqual(expectedMembers);
    // 团队 Owner 和其他查看者不会改变任务创建者，也不会被自动加入任务名单。
    if (view === 'team') {
      const ownerRead = await request.get(`/api/v1/tasks/${task.task_id}/members`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      });
      expect(ownerRead.status()).toBe(200);
      expect((await ownerRead.json()).data).toEqual(expectedMembers);
    }
    const popup = page.getByRole('dialog', { name: '任务成员', exact: true });
    await expect(popup.getByRole('listitem')).toHaveCount(1);
    await expect(popup.getByText(member.user.username, { exact: true })).toBeVisible();
    await expect(popup.getByText('Owner', { exact: true })).toHaveCount(1);
    await expect(popup.getByText(/示例数据|示例用户甲|示例用户乙/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${view}-真实创建者工作台.png`) });
    await popup.screenshot({ path: testInfo.outputPath(`${view}-真实任务成员.png`) });
  });
}

test('列表读取失败仍可创建；全失败不登记，部分成功与丢响应重试沿用同一真实任务', async ({
  page,
  request,
}) => {
  const session = await register(request);
  await page.route('**/api/v1/teams/*/tasks', async route => {
    if (route.request().method() === 'GET')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '测试列表不可用' } }),
      });
    else await route.continue();
  });
  await enter(page, session, session.default_team_id, '/team/tasks');
  await expect(page.getByRole('alert')).toBeVisible();
  let posts = 0;
  page.on('request', request => {
    if (isTaskPost(request.url(), request.method())) posts++;
  });
  async function choose(files: Parameters<FileChooser['setFiles']>[0]) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '创建新任务' }).click();
    await page.getByRole('menuitem', { name: '选择文件', exact: true }).click();
    await (await chooser).setFiles(files);
  }
  await choose([
    { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('not dicom') },
  ]);
  await expect(page.getByRole('alert').filter({ hasText: '没有可用影像' })).toBeVisible();
  expect(posts).toBe(0);
  await expect(page).toHaveURL(/\/team\/tasks$/);
  const records: Array<{ key: string; task: string; status: number }> = [];
  await page.route('**/api/v1/task-imports/*/complete', async route => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    records.push({
      key: new URL(route.request().url()).pathname.split('/')[4],
      task: (await response.json()).data.task_id,
      status: response.status(),
    });
    if (records.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await choose([
    { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('bad') },
    ...syntheticSeries().files,
  ]);
  await page.getByRole('button', { name: '重试登记' }).click();
  await expect(page).toHaveURL(/\/segmentation\/dicomlocal\?/);
  expect(records).toHaveLength(2);
  expect(records[0].status).toBe(200);
  expect(records[1]).toEqual({ ...records[0], status: 200 });
  await expect(page.locator('canvas').first()).toBeVisible();
});

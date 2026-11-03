import { test, expect, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  BusinessServices,
  IssuedBusinessSession,
  TeamTaskList,
  RecentTaskList,
} from '../../platform/core/src/types/BusinessContracts';

const password = 'team-dashboard-synthetic';
const isRead = (response: Response, path: string) =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === path;
async function register(page: Page) {
  const username = `团队验收-${randomUUID().slice(0, 8)}`;
  await page.goto('/account/register');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  const issued = page.waitForResponse(
    response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/users'
  );
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const response = await issued;
  expect(response.status()).toBe(201);
  await expect(page).toHaveURL(/\/account\/invite$/);
  return { username, session: (await response.json()).data as IssuedBusinessSession };
}
async function skip(page: Page, teamId: string): Promise<TeamTaskList> {
  const read = page.waitForResponse(response => isRead(response, `/api/v1/teams/${teamId}/tasks`));
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  const response = await read;
  expect(response.status()).toBe(200);
  await expect(page.getByLabel('任务数量')).toBeVisible();
  return (await response.json()).data;
}

async function expectCards(page: Page, data: TeamTaskList | RecentTaskList) {
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(data.total);
  await expect(cards.locator('h3')).toHaveText(data.items.map(item => item.title));
  await expect(cards.locator('.team-page-card-info p')).toHaveText(
    data.items.map(item => item.subtitle)
  );
}

test('真实注册先邀请后跳过；两个 HTTP mock 看板切换、刷新及再次登录保持稳定', async ({ page }) => {
  const { username, session } = await register(page);
  const team = await skip(page, session.default_team_id);
  expect(team.mock).toBe(true);
  expect(team.total).toBe(team.items.length);
  expect(team.items.every(item => item.team_id === session.default_team_id)).toBe(true);
  await expectCards(page, team);
  const recentRead = page.waitForResponse(response => isRead(response, '/api/v1/tasks/recent'));
  await page.getByRole('button', { name: '最近任务', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/recent$/);
  const recent: RecentTaskList = (await (await recentRead).json()).data;
  expect(recent.mock).toBe(true);
  expect(recent.total).toBe(recent.items.length);
  expect(recent.items.some(item => item.team_id !== session.default_team_id)).toBe(true);
  await expectCards(page, recent);
  const external = recent.items.find(item => item.team_id !== session.default_team_id)!;
  await expect(page.getByRole('heading', { name: external.title, exact: true })).toBeVisible();
  const refreshed = page.waitForResponse(response => isRead(response, '/api/v1/tasks/recent'));
  await page.reload();
  expect((await (await refreshed).json()).data).toEqual(recent);
  await expectCards(page, recent);
  await expect(page.getByLabel('任务数量')).toHaveText(String(recent.total));
  const refreshedAgain = page.waitForResponse(response => isRead(response, '/api/v1/tasks/recent'));
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  expect((await (await refreshedAgain).json()).data).toEqual(recent);
  await expectCards(page, recent);
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  const loggedIn = page.waitForResponse(response =>
    isRead(response, `/api/v1/teams/${session.default_team_id}/tasks`)
  );
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  expect((await (await loggedIn).json()).data).toEqual(team);
  await expectCards(page, team);
});

test('原成员在团队空间左边；自有团队勾选，卡片／团队／注销／回收站不触发业务写入', async ({
  page,
}, testInfo) => {
  const { session } = await register(page);
  await skip(page, session.default_team_id);
  // 显式建立既有协作 mock 夹具；这次初始化与页面自身是否调用 forUser 分开记录。
  const fixture = await page.evaluate(() => {
    const w = window as unknown as {
      services: { businessServices: BusinessServices };
      teamPageAudit: { forUserCalls: number };
    };
    const business = w.services.businessServices;
    const user = business.session.getSnapshot().context!.user;
    const factory = business.collaborationMock!;
    const store = factory.forUser(user);
    const invitation = store.invite(store.recipients[0].username);
    w.teamPageAudit = { forUserCalls: 0 };
    const original = factory.forUser.bind(factory);
    factory.forUser = current => {
      w.teamPageAudit.forUserCalls++;
      return original(current);
    };
    return {
      username: invitation.recipient_username,
      pending: store.list().filter(item => item.decision === 'pending').length,
    };
  });
  expect(fixture.pending).toBe(1);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/')) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const member = page.getByRole('button', { name: '成员', exact: true });
  const space = page.getByLabel('团队空间导航').getByText('团队空间', { exact: true });
  expect((await member.boundingBox())!.x).toBeLessThan((await space.boundingBox())!.x);
  const card = page.getByRole('article').first();
  await expect(card.getByRole('link')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveCount(0);
  await card.click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await expect(page.getByRole('button', { name: '回收站（暂未开放）' })).toBeDisabled();
  await member.click();
  await expect(page.getByRole('menuitem', { name: '退出登录', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '查看你的团队', exact: true }).click();
  const menu = page.getByRole('menu', { name: '团队列表', exact: true });
  const owned = session.memberships.find(item => item.team_id === session.default_team_id)!;
  await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText(owned.name);
  for (const item of await menu.getByRole('menuitemradio').all()) await expect(item).toBeDisabled();
  await expect(menu.getByText('示例团队，仅展示，不可切换')).toBeVisible();
  await menu.screenshot({ path: testInfo.outputPath('自有团队下拉.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const noticeRead = page.waitForResponse(response =>
    isRead(response, '/api/v1/notifications/team-invitations')
  );
  await page.getByRole('button', { name: '通知', exact: true }).click();
  const notifications = page.getByRole('dialog', { name: '通知', exact: true });
  expect((await noticeRead).status()).toBe(200);
  await expect(notifications.getByRole('status')).toHaveCount(0);
  await expect(notifications.getByRole('alert')).toHaveCount(0);
  await expect(notifications.getByText('暂无通知', { exact: true })).toBeVisible();
  await expect(
    notifications.getByRole('article', { name: `协作模拟 ${fixture.username}`, exact: true })
  ).toHaveCount(0);
  await expect(notifications.getByRole('button', { name: '模拟接受', exact: true })).toHaveCount(0);
  await expect(notifications.getByRole('button', { name: '模拟拒绝', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { teamPageAudit: { forUserCalls: number } }).teamPageAudit
          .forUserCalls
    )
  ).toBe(0);
  await page.getByRole('button', { name: '关闭通知弹窗' }).click();
  expect(writes).toEqual([]);
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.screenshot({ path: testInfo.outputPath('团队任务.png') });
  // 正向控制：同一 pending 夹具在旧导入入口确实可见，防止空夹具造成负向假通过。
  await page.goto('/local-mask');
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '通知', exact: true }).click();
  const legacy = page.getByRole('article', { name: `协作模拟 ${fixture.username}`, exact: true });
  await expect(legacy.getByRole('button', { name: '模拟接受', exact: true })).toBeVisible();
  await expect(legacy.getByRole('button', { name: '模拟拒绝', exact: true })).toBeVisible();
  await page.goto('/team/tasks');
  await expect(page.getByLabel('任务数量')).toBeVisible();
  expect(writes).toEqual([]);
});

test('真实入队邀请发送成功后进入团队任务，不把邀请替换为 mock', async ({ page, request }) => {
  const recipientName = `team-recipient-${randomUUID().slice(0, 8)}`;
  expect(
    (await request.post('/api/v1/users', { data: { username: recipientName, password } })).status()
  ).toBe(201);
  const { session } = await register(page);
  await page.getByLabel('输入他的用户名').fill(recipientName);
  const sent = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/invitations')
  );
  await page.getByRole('button', { name: '完成', exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(201);
  expect((await response.json()).data.team_id).toBe(session.default_team_id);
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await expect(page.getByLabel('任务数量')).toBeVisible();
});

test('匿名团队路由末尾斜线变体仍重新校验并回登录，不发出列表读取', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', request => {
    if (/\/api\/v1\/(?:teams\/[^/]+\/tasks|tasks\/recent)$/.test(new URL(request.url()).pathname))
      reads.push(request.url());
  });
  for (const path of ['/team/tasks//', '/team/recent///']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/account\/login$/);
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
  }
  expect(reads).toEqual([]);
});

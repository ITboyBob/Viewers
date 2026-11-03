import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { BusinessTask, TaskMemberList } from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from './syntheticDicom';

async function login(page: Page, request: APIRequestContext) {
  const username = `task-members-${randomUUID().slice(0, 8)}`,
    password = 'task-members-synthetic';
  expect((await request.post('/api/v1/users', { data: { username, password } })).status()).toBe(
    201
  );
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.goto('/local-mask');
  await expect(page.getByRole('button', { name: 'Load files', exact: true })).toBeVisible();
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  return username;
}
async function importTask(page: Page): Promise<BusinessTask> {
  const registered = page.waitForResponse(
    response =>
      response.request().method() === 'POST' &&
      /\/api\/v1\/teams\/[^/]+\/tasks$/.test(new URL(response.url()).pathname)
  );
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(syntheticSeries(3).files);
  const response = await registered;
  expect(response.status()).toBe(201);
  const task: BusinessTask = (await response.json()).data;
  await expect(page.getByRole('button', { name: '任务成员', exact: true })).toBeVisible();
  return task;
}
const panel = (page: Page) => page.getByRole('dialog', { name: '任务成员', exact: true });
const membersPath = (taskId: string) => `/api/v1/tasks/${taskId}/members`;

test('真实导入的任务显示真实创建者与唯一 Owner，无示例名单和工作台通知', async ({
  page,
  request,
}, testInfo) => {
  const username = await login(page, request);
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '任务成员', exact: true })).toHaveCount(0);
  const task = await importTask(page);
  await expect(page.getByRole('button', { name: '成员', exact: true })).toHaveCount(0);
  const read = page.waitForResponse(
    response => new URL(response.url()).pathname === membersPath(task.task_id)
  );
  await page.getByRole('button', { name: '任务成员', exact: true }).click();
  const response = await read;
  expect(response.request().method()).toBe('GET');
  expect(response.status()).toBe(200);
  const data: TaskMemberList = (await response.json()).data;
  expect(data.task_id).toBe(task.task_id);
  expect(data.mock).toBe(false);
  expect(data.owner_uid).toBe(task.assignee_uid);
  expect(data.members).toEqual([{ uid: task.assignee_uid, username }]);
  await expect(page.getByRole('button', { name: '通知', exact: true })).toHaveCount(0);
  const popup = panel(page);
  await expect(popup.getByText(/示例数据|示例用户甲|示例用户乙/)).toHaveCount(0);
  await expect(popup.getByRole('listitem')).toHaveCount(data.members.length);
  await expect(popup.getByText('Owner', { exact: true })).toHaveCount(1);
  for (const member of data.members) {
    await expect(popup.getByText(member.username, { exact: true })).toBeVisible();
    await expect(popup).not.toContainText(member.uid);
  }
  const owner = data.members.find(member => member.uid === data.owner_uid)!;
  await expect(popup.getByRole('listitem').filter({ hasText: owner.username })).toContainText(
    'Owner'
  );
  await expect(popup.getByRole('img')).toHaveCount(0);
  await expect(popup.getByText(/在线|权限|邀请来源|转让|移除/)).toHaveCount(0);
  await popup.screenshot({ path: testInfo.outputPath('目标任务成员.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '任务成员', exact: true })).toBeFocused();
});

test('离开旧任务并重新真实导入后，旧任务迟到响应不能串入新名单', async ({ page, request }) => {
  await login(page, request);
  const old = await importTask(page);
  let release!: () => void, captured!: () => void, delivered!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const seen = new Promise<void>(resolve => {
    captured = resolve;
  });
  const finished = new Promise<void>(resolve => {
    delivered = resolve;
  });
  await page.route(`**${membersPath(old.task_id)}`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.members[0].username = '旧目标迟到成员';
    captured();
    await held;
    try {
      await route.fulfill({ response, json: body });
    } catch {
      /* 已取消的旧页面请求允许拒绝投递。 */
    }
    delivered();
  });
  try {
    await page.getByRole('button', { name: '任务成员', exact: true }).click();
    await seen;
    await page.goBack();
    await expect(page).toHaveURL(/\/local-mask$/);
    await expect(page.getByRole('button', { name: '成员', exact: true })).toBeVisible();
    const current = await importTask(page);
    expect(current.task_id).not.toBe(old.task_id);
    const read = page.waitForResponse(
      response => new URL(response.url()).pathname === membersPath(current.task_id)
    );
    await page.getByRole('button', { name: '任务成员', exact: true }).click();
    expect((await (await read).json()).data.task_id).toBe(current.task_id);
    await expect(panel(page).getByText('Owner', { exact: true })).toBeVisible();
    release();
    await finished;
    await expect(panel(page).getByText('旧目标迟到成员', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});

test('读取失败可重试；第二次请求 pending 与成功期间焦点留在浮层', async ({ page, request }) => {
  await login(page, request);
  const task = await importTask(page);
  let attempt = 0,
    release!: () => void,
    captured!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const seen = new Promise<void>(resolve => {
    captured = resolve;
  });
  await page.route(`**${membersPath(task.task_id)}`, async (route: Route) => {
    attempt++;
    if (attempt === 1) {
      await route.fulfill({
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: '合成读取故障' } },
      });
      return;
    }
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '任务成员', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toContainText('成员读取失败');
    const retry = panel(page).getByRole('button', { name: '重试', exact: true });
    await retry.focus();
    await retry.click();
    await seen;
    await expect(panel(page).getByRole('status')).toContainText('正在读取成员');
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('.task-members-panel')))
      .toBe(true);
    await page.keyboard.press('i');
    release();
    await expect(panel(page).getByText('Owner', { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('.task-members-panel')))
      .toBe(true);
    expect(attempt).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '任务成员', exact: true })).toBeFocused();
  } finally {
    release();
  }
});

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { openChromeWindows } from './chromeWindows';
import { copySharedLink } from './sharedLink';
import { syntheticSeries } from '../phase-one/syntheticDicom';
import type { BusinessServices } from '../../platform/core/src/types/BusinessContracts';

type TestWindow = Window & { services: { businessServices: BusinessServices } };
const password = 'share-entry-synthetic';
async function createAccount(request: APIRequestContext, label: string) {
  const username = `${label}-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/v1/users', { data: { username, password } });
  expect(response.status()).toBe(201);
  return { username, uid: (await response.json()).data.user.uid as string };
}
async function credentials(page: Page, username: string) {
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
}
async function login(page: Page, username: string) {
  await page.goto('/account/login');
  await credentials(page, username);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
}
async function ready(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
}

test.describe('共享入口完整用户旅程', () => {
  for (const mode of ['authenticated', 'login', 'register'] as const) {
    test(`普通双窗：点击复制，B状态=${mode}后进入原共享页且零Task写入`, async ({ request }) => {
      test.setTimeout(120000);
      const windows = await openChromeWindows();
      try {
        const a = await createAccount(request, 'copy-source');
        let creates = 0;
        windows.a.on('request', req => {
          if (req.method() === 'POST' && /\/tasks$/.test(new URL(req.url()).pathname)) {
            creates++;
          }
        });
        await ready(windows.a);
        await ready(windows.b);
        await login(windows.a, a.username);
        await windows.a
          .getByLabel('导入文件', { exact: true })
          .setInputFiles(syntheticSeries(3).files);
        await expect(
          windows.a.getByRole('button', { name: '共享链接', exact: true })
        ).toBeVisible();
        const address = await copySharedLink(windows.a);
        const taskId = new URL(address).searchParams.get('task_id')!;
        const b =
          mode === 'register'
            ? { username: `share-register-${randomUUID().slice(0, 8)}` }
            : await createAccount(request, 'copy-viewer');
        const taskRequests: string[] = [];
        windows.b.on('request', req => {
          if (/\/tasks(?:\/|$)/.test(new URL(req.url()).pathname)) {
            taskRequests.push(req.method());
          }
        });
        if (mode === 'authenticated') {
          await login(windows.b, b.username);
        }
        await windows.b.goto(address);
        if (mode !== 'authenticated') {
          await expect(windows.b).toHaveURL(
            new RegExp(`/account/login\\?shared_task_id=${taskId}$`)
          );
          if (mode === 'register') {
            await windows.b.getByRole('link', { name: '注册', exact: true }).click();
            await expect(windows.b).toHaveURL(
              new RegExp(`/account/register\\?shared_task_id=${taskId}$`)
            );
            await windows.b.reload();
            await windows.b.getByRole('link', { name: '登录', exact: true }).click();
            await windows.b.getByRole('link', { name: '注册', exact: true }).click();
          }
          await credentials(windows.b, b.username);
          await windows.b
            .getByRole('button', {
              name: mode === 'register' ? '注册并进入共享' : '登录',
              exact: true,
            })
            .click();
        }
        await expect(windows.b).toHaveURL(address);
        await expect(windows.b.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
        const identities = await windows.b.evaluate(() => {
          const business = (window as unknown as TestWindow).services.businessServices;
          const view = business.localCollaboration!.sharedView!.getSnapshot()!;
          return {
            current: business.session.getSnapshot().context!.user.uid,
            viewer: view.viewer_uid,
            importer: view.importer_uid,
            task: view.task_id,
          };
        });
        expect(identities.current).not.toBe(a.uid);
        expect(identities).toMatchObject({
          viewer: identities.current,
          importer: a.uid,
          task: taskId,
        });
        expect(creates).toBe(1);
        expect(taskRequests).toEqual([]);
        await expect(windows.a).toHaveURL(/\/segmentation\/dicomlocal\?/);
      } finally {
        await windows.close();
      }
    });
  }
});

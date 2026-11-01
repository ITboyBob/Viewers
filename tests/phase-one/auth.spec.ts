import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const username = () => 'auth_' + randomUUID();
const password = 'phase-one-synthetic-test';
const key = 'colla.phaseOne.session';
async function fill(page: Page, user: string) {
  await page.getByLabel('用户名', { exact: true }).fill(user);
  await page.getByLabel('密码', { exact: true }).fill(password);
}
async function storedToken(page: Page): Promise<string> {
  return page.evaluate(storageKey => JSON.parse(sessionStorage.getItem(storageKey)!).token, key);
}

test('真实API公开注册、owner关联、当前身份与幂等注销，无凭据字段披露', async ({ request }) => {
  const name = username();
  const response = await request.post('/api/v1/users', { data: { username: name, password } });
  expect(response.status()).toBe(201);
  const data = (await response.json()).data;
  expect(typeof data.token).toBe('string');
  expect(data.memberships.length).toBe(1);
  expect(data.memberships[0].role).toBe('owner');
  expect(data.memberships[0].owner_uid).toBe(data.user.uid);
  expect(data.memberships[0].team_id).toBe(data.default_team_id);
  expect(Object.hasOwn(data.user, 'password_hash')).toBe(false);
  expect(Object.hasOwn(data.user, 'email')).toBe(false);
  const current = await request.get('/api/v1/auth/sessions/current', {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  expect(current.status()).toBe(200);
  expect(Object.hasOwn((await current.json()).data, 'token')).toBe(false);
  for (let i = 0; i < 2; i++) {
    expect(
      (
        await request.delete('/api/v1/auth/sessions/current', {
          headers: { Authorization: `Bearer ${data.token}` },
        })
      ).status()
    ).toBe(204);
  }
  expect(
    (
      await request.get('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${data.token}` },
      })
    ).status()
  ).toBe(401);
});

test('真实注册到受保护邀请占位，刷新确认；真实登录到导入，注销后拒绝旧凭据', async ({
  page,
  request,
}) => {
  const name = username();
  await page.goto('/account/register');
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  await fill(page, name);
  await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '下一步' })).toHaveCSS(
    'background-color',
    'rgba(53, 140, 253, 0.6)'
  );
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page).toHaveURL(/\/account\/invite$/);
  await expect(page.getByRole('heading', { name: '邀请页面待接入' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '邀请页面待接入' })).toBeVisible();
  await page.goto('/account/login?returnUrl=https://outside.test');
  await fill(page, name);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  await expect(page.getByText('Load files', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Load files', { exact: true })).toBeVisible();
  await page.goBack();
  await page.goForward();
  await expect(page.getByText('Load files', { exact: true })).toBeVisible();
  const token = await storedToken(page);
  expect(
    (
      await request.delete('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status()
  ).toBe(204);
  await page.reload();
  await expect(page).toHaveURL(/\/account\/login$/);
  expect(await page.evaluate(storageKey => sessionStorage.getItem(storageKey) === null, key)).toBe(
    true
  );
});

test('匿名直达mask和本地segmentation被拒绝，原生Local不触发业务鉴权', async ({ page }) => {
  for (const path of [
    '/local-mask',
    '/segmentation/dicomlocal',
    '/segmentation',
    '/account/invite',
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/account\/login$/);
    await expect(page.getByLabel('用户名')).toBeVisible();
  }
  let currents = 0;
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/v1/auth/sessions/current') {
      currents++;
    }
  });
  await page.goto('/local');
  await expect(page.getByText('Load files', { exact: true })).toBeVisible();
  expect(currents).toBe(0);
});

test('独立浏览器上下文共享同实例账号团队但不共享标签页Token，异账号身份不能伪造', async ({
  browser,
  request,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const name = username(),
      pageA = await a.newPage(),
      pageB = await b.newPage();
    await pageA.goto('http://localhost:3336/account/register');
    await fill(pageA, name);
    await pageA.getByRole('button', { name: '下一步' }).click();
    await expect(pageA.getByRole('heading', { name: '邀请页面待接入' })).toBeVisible();
    const tokenA = await storedToken(pageA);
    await pageB.goto('http://localhost:3336/account/login');
    expect(
      await pageB.evaluate(storageKey => sessionStorage.getItem(storageKey) === null, key)
    ).toBe(true);
    await fill(pageB, name);
    await pageB.getByRole('button', { name: '登录', exact: true }).click();
    await expect(pageB.getByText('Load files', { exact: true })).toBeVisible();
    const tokenB = await storedToken(pageB);
    expect(tokenA === tokenB).toBe(false);
    const current = async (token: string, uid?: string) =>
      (
        await (
          await request.get('/api/v1/auth/sessions/current', {
            headers: { Authorization: `Bearer ${token}` },
            params: uid ? { uid } : undefined,
          })
        ).json()
      ).data;
    const first = await current(tokenA),
      second = await current(tokenB);
    expect(first.default_team_id).toBe(second.default_team_id);
    expect(first.user.uid).toBe(second.user.uid);
    const other = (
      await (
        await request.post('/api/v1/users', { data: { username: username(), password } })
      ).json()
    ).data;
    const isolated = await current(other.token, first.user.uid);
    expect(isolated.user.uid).not.toBe(first.user.uid);
    expect(isolated.memberships.length).toBe(1);
    expect(isolated.default_team_id).not.toBe(first.default_team_id);
  } finally {
    await a.close();
    await b.close();
  }
});

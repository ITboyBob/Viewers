import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const password = 'member-entry-test';
test('侧栏真实切队、普通成员独立邀请与名单、关重开刷新冷却及接受联动', async ({
  page,
  request,
}) => {
  const register = async () => {
    const r = await request.post('/api/v1/users', {
      data: { username: '成员-' + randomUUID().slice(0, 8), password },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).data;
  };
  const a = await register(),
    c = await register(),
    b = await register();
  const headers = (u: any) => ({ Authorization: `Bearer ${u.token}` });
  const invite = async (u: any, target: any) => {
    const r = await request.post(`/api/v1/teams/${a.default_team_id}/invitations`, {
      headers: headers(u),
      data: { username: target.user.username },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).data;
  };
  const joined = await invite(a, c);
  expect(
    (
      await request.post(`/api/v1/invitations/${joined.invitation_id}/accept`, {
        headers: headers(c),
      })
    ).status()
  ).toBe(200);
  await page.goto('/account/login');
  await page.getByLabel('用户名', { exact: true }).fill(c.user.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: /切换团队：/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(a.user.username) }).click();
  await expect(
    page.getByRole('heading', { name: a.user.username + '的团队', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: '查看团队成员', exact: true }).click();
  const members = page.getByRole('list', { name: '完整团队成员' });
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(members).toContainText(c.user.username);
  await expect(members.getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭成员弹窗' }).click();
  await expect(page.getByRole('button', { name: '查看团队成员', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '新增团队成员' }).click();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-labelledby', /.+/);
  await page.getByLabel('输入他的用户名').fill(b.user.username);
  const sent = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().endsWith('/invitations')
  );
  await page.getByRole('button', { name: '邀请', exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(201);
  const mine = (await response.json()).data;
  await expect(page.getByRole('button', { name: '已邀请' })).toBeDisabled();
  await page.getByRole('button', { name: '关闭邀请弹窗' }).click();
  await page.reload();
  await page.getByRole('button', { name: '新增团队成员' }).click();
  await page.getByLabel('输入他的用户名').fill(b.user.username);
  await expect(page.getByRole('button', { name: '已邀请' })).toBeDisabled();
  const other = await invite(a, b);
  expect(
    (
      await request.post(`/api/v1/invitations/${mine.invitation_id}/accept`, {
        headers: headers(b),
      })
    ).status()
  ).toBe(200);
  for (const decision of ['accept', 'reject']) {
    const r = await request.post(`/api/v1/invitations/${other.invitation_id}/${decision}`, {
      headers: headers(b),
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).error.details.reason).toBe('INVITATION_EXPIRED');
  }
  await page.getByRole('button', { name: '关闭邀请弹窗' }).click();
  await page.getByRole('button', { name: '查看团队成员', exact: true }).click();
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 720 });
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const recovery = await request.get(`/api/v1/teams/${a.default_team_id}/invitations/sent`, {
    headers: headers(c),
  });
  expect((await recovery.json()).data[0].expires_at).toBe(mine.expires_at);
});

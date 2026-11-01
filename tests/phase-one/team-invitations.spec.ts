import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  IssuedBusinessSession,
  InvitationView,
  MemberView,
} from '../../platform/core/src/types/BusinessContracts';

const password = 'phase-one-synthetic-test';
const username = () => 'invite_' + randomUUID();
const key = 'colla.phaseOne.session';
async function fill(page: Page, name: string) {
  await page.getByLabel('用户名', { exact: true }).fill(name);
  await page.getByLabel('密码', { exact: true }).fill(password);
}
async function ownerSession(page: Page): Promise<IssuedBusinessSession> {
  const token: string = await page.evaluate(
    storageKey => JSON.parse(sessionStorage.getItem(storageKey)!).token,
    key
  );
  const current = await page.request.get(
    new URL('/api/v1/auth/sessions/current', page.url()).href,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  expect(current.status()).toBe(200);
  return { ...(await current.json()).data, token };
}

for (const decision of ['accepted', 'rejected'] as const) {
  test(`真实注册邀请→独立接收者通知→${decision}，成员证据与第三人隔离`, async ({
    page,
    browser,
    request,
  }) => {
    const recipientName = username();
    const recipientResponse = await request.post('/api/v1/users', {
      data: { username: recipientName, password },
    });
    expect(recipientResponse.status()).toBe(201);
    const recipient: IssuedBusinessSession = (await recipientResponse.json()).data;
    const thirdResponse = await request.post('/api/v1/users', {
      data: { username: username(), password },
    });
    expect(thirdResponse.status()).toBe(201);
    const third: IssuedBusinessSession = (await thirdResponse.json()).data;
    const receiver = await browser.newContext();
    try {
      await page.goto('/account/register');
      await fill(page, username());
      await page.getByRole('button', { name: '下一步' }).click();
      await expect(page).toHaveURL(/\/account\/invite$/);
      await expect(page.getByText(/邀请入队：/)).toBeVisible();
      const owner = await ownerSession(page);
      const members = async (): Promise<MemberView[]> => {
        const result = await request.get(`/api/v1/teams/${owner.default_team_id}/members`, {
          headers: { Authorization: `Bearer ${owner.token}` },
          params: { page: 1, page_size: 100 },
        });
        expect(result.status()).toBe(200);
        return (await result.json()).data;
      };
      await page.getByLabel('输入他的用户名').fill(recipientName);
      const sent = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/invitations')
      );
      await page.getByRole('button', { name: '完成', exact: true }).click();
      const sendResponse = await sent;
      expect(sendResponse.status()).toBe(201);
      const invitation: InvitationView = (await sendResponse.json()).data;
      await expect(page).toHaveURL(/\/local-mask$/);
      expect((await members()).some(item => item.uid === recipient.user.uid)).toBe(false);
      expect(
        (
          await request.post(`/api/v1/invitations/${invitation.invitation_id}/accept`, {
            headers: { Authorization: `Bearer ${third.token}` },
          })
        ).status()
      ).toBe(404);
      const isolated = await request.get('/api/v1/notifications/team-invitations', {
        headers: { Authorization: `Bearer ${third.token}` },
      });
      expect(isolated.status()).toBe(200);
      expect(
        (await isolated.json()).data.some(
          (item: InvitationView) => item.invitation_id === invitation.invitation_id
        )
      ).toBe(false);

      const receiverPage = await receiver.newPage();
      await receiverPage.goto('http://localhost:3336/account/login');
      await fill(receiverPage, recipientName);
      await receiverPage.getByRole('button', { name: '登录', exact: true }).click();
      await expect(receiverPage).toHaveURL(/\/local-mask$/);
      await receiverPage.getByRole('button', { name: '通知', exact: true }).click();
      const row = receiverPage.getByRole('article', { name: `入队邀请 ${invitation.team_name}` });
      await expect(row).toContainText(owner.user.username);
      await expect(row).toContainText(invitation.team_name);
      await row
        .getByRole('button', { name: decision === 'accepted' ? '接受' : '拒绝', exact: true })
        .click();
      await expect(row).toContainText(decision === 'accepted' ? '已接受' : '已拒绝');
      await receiverPage.getByRole('button', { name: '关闭通知弹窗' }).click();
      await receiverPage.getByRole('button', { name: '通知', exact: true }).click();
      await expect(row).toContainText(decision === 'accepted' ? '已接受' : '已拒绝');
      const joined = (await members()).filter(item => item.uid === recipient.user.uid);
      expect(joined).toHaveLength(decision === 'accepted' ? 1 : 0);
      if (decision === 'accepted') {
        expect(joined[0].role).toBe('annotator');
      }
      const current = await request.get('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${recipient.token}` },
      });
      expect(
        (await current.json()).data.memberships.some(item => item.team_id === owner.default_team_id)
      ).toBe(decision === 'accepted');
    } finally {
      await receiver.close();
    }
  });
}

test('真实失败留在邀请页，自己不发送；跳过不额外发送且经会话守卫进入导入', async ({ page }) => {
  const name = username();
  let invitations = 0;
  let validations = 0;
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname.endsWith('/invitations')) {
      invitations++;
    }
    if (pathname === '/api/v1/auth/sessions/current') {
      validations++;
    }
  });
  await page.goto('/account/register');
  await fill(page, name);
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText(/邀请入队：/)).toBeVisible();
  await page.getByLabel('输入他的用户名').fill(name);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能邀请自己');
  expect(invitations).toBe(0);
  await page.getByLabel('输入他的用户名').fill(username());
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/account\/invite$/);
  expect(invitations).toBe(1);
  const before = validations;
  await page.getByRole('button', { name: '跳过' }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  await expect(page.getByRole('button', { name: '成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '邀请', exact: true })).toHaveCount(0);
  await expect(page.getByText('Load files', { exact: true })).toBeVisible();
  expect(validations).toBeGreaterThan(before);
  expect(invitations).toBe(1);
});

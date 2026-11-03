import { test, expect } from '@playwright/test';

const storageKey = 'colla.phaseOne.session';

test.beforeEach(async ({ page }) => {
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await page.addInitScript(
    ({ key, expires_at }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          token: 'team-list-preview-token',
          expires_at,
          current_team_id: 'preview-team',
        })
      );
    },
    { key: storageKey, expires_at: expiresAt }
  );
  // 合成会话只用于 UI 验证，不访问或修改运行中的后端数据。
  await page.route('**/api/v1/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/v1/auth/sessions/current') {
      await route.fulfill({
        json: {
          data: {
            user: { uid: 'preview-user', username: '界面预览用户', avatar_url: null },
            expires_at: expiresAt,
            default_team_id: 'preview-team',
            memberships: [
              {
                team_id: 'preview-team',
                name: '预览团队',
                owner_uid: 'preview-user',
                role: 'owner',
              },
            ],
          },
        },
      });
    } else {
      await route.fulfill({ status: 403, json: { error: { code: 'PREVIEW_ONLY' } } });
    }
  });
});

test('占位团队二级菜单在原面板旁展开，键盘分层关闭且不查询、切换或导航', async ({
  page,
}, testInfo) => {
  await page.goto('/local-mask');
  const member = page.getByRole('button', { name: '成员', exact: true });
  await expect(member).toBeVisible();
  const saved = await page.evaluate(key => sessionStorage.getItem(key), storageKey);
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/')) requests.push(request.url());
  });
  const trigger = page.getByRole('menuitem', { name: '查看你的团队' });
  const menu = page.getByRole('menu', { name: '团队列表（占位）' });
  await member.click();
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '个人信息' })).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-side', 'right');
  const parentBounds = await page.getByRole('dialog', { name: '个人信息' }).boundingBox();
  const childBounds = await menu.boundingBox();
  expect(childBounds!.x).toBeGreaterThanOrEqual(parentBounds!.x + parentBounds!.width);
  await expect(menu.getByRole('menuitem', { name: '团队 A' })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: '团队 B' })).toBeDisabled();
  await expect(menu).toHaveCSS('background-color', 'rgb(9, 12, 42)');
  await menu.click({ position: { x: 12, y: 12 } });
  await expect(page.getByRole('dialog', { name: '个人信息' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('团队列表-桌面.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowRight');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Escape');
  await expect(page.getByRole('dialog', { name: '个人信息' })).toBeHidden();
  await expect(member).toBeFocused();
  await member.click();
  await trigger.click();
  await page.getByText('Load files', { exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('dialog', { name: '个人信息' })).toBeHidden();
  await member.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page).toHaveURL(/\/local-mask$/);
  expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(saved);
  expect(requests).toEqual([]);
});

test('窄屏展开的团队菜单保持在视口内', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/local-mask');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await page.getByRole('menuitem', { name: '查看你的团队' }).click();
  const menu = page.getByRole('menu', { name: '团队列表（占位）' });
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(8);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(352);
  await page.screenshot({ path: testInfo.outputPath('团队列表-窄屏.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).toHaveAttribute('data-side', 'right');
});

test('完整字符按键不触发底层快捷键，外部点击关闭后保留输入焦点', async ({ page }) => {
  await page.goto('/local-mask');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await page.evaluate(() => {
    const events: string[] = [];
    document.documentElement.dataset.teamMenuKeys = '';
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(type, event => {
        if ((event as KeyboardEvent).key === 'i') {
          events.push(type);
          document.documentElement.dataset.teamMenuKeys = events.join(',');
        }
      });
    }
    const input = document.createElement('input');
    input.setAttribute('aria-label', '外部预览输入');
    Object.assign(input.style, { position: 'fixed', left: '1050px', top: '100px' });
    document.body.append(input);
  });
  await page.keyboard.press('i');
  await page.getByRole('menuitem', { name: '查看你的团队' }).click();
  await page.keyboard.press('i');
  await expect(page.locator('html')).toHaveAttribute('data-team-menu-keys', '');
  await page.getByRole('menu', { name: '团队列表（占位）' }).click({ position: { x: 12, y: 12 } });
  const input = page.getByRole('textbox', { name: '外部预览输入' });
  await input.click();
  await expect(page.getByRole('dialog', { name: '个人信息' })).toBeHidden();
  // 等待卸载后的异步还焦点周期，不能只断言 click 当下的瞬时焦点。
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(input).toBeFocused();
  await page.keyboard.type('abc');
  await expect(input).toHaveValue('abc');
});

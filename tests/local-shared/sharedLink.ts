import { expect, type Page } from '@playwright/test';

/** 在独立测试个人资料内验证真实剪贴板，不通过组件内部属性获取分享地址。 */
export async function copySharedLink(page: Page): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.bringToFront();
  const before = page.url();
  const count = page.context().pages().length;
  await page.getByRole('button', { name: '共享链接', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已复制' })).toBeVisible();
  const address = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(address).origin).toBe(new URL(before).origin);
  expect(new URL(address).pathname).toMatch(/\/local-shared$/);
  expect(page.url()).toBe(before);
  expect(page.context().pages()).toHaveLength(count);
  return address;
}

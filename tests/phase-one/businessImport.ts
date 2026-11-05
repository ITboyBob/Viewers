import { expect, type Page } from '@playwright/test';
/** 真实UI导入的完成边界；与仍保留的独立旧登记HTTP契约分开。 */
export const isImportComplete = (url: string) =>
  /^\/api\/v1\/task-imports\/[^/]+\/complete$/.test(new URL(url).pathname);
export async function workspaceReady(page: Page) {
  await expect(
    page.getByRole('status').filter({ hasText: /^(成果已同步|成果已保存|当前任务只读)$/ })
  ).toBeVisible();
}

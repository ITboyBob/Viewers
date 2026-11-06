import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { BusinessServices } from '../../platform/core/src/types/BusinessContracts';
import { isImportComplete, workspaceReady } from '../phase-one/businessImport';
import { syntheticSeries } from '../phase-one/syntheticDicom';
import { openChromeWindows } from './chromeWindows';
import { copySharedLink } from './sharedLink';

async function register(page: Page) {
  await page.goto('/account/register');
  await page.getByLabel('用户名', { exact: true }).fill(`共享首入-${randomUUID().slice(0, 8)}`);
  await page.getByLabel('密码', { exact: true }).fill('sharing-first-entry-synthetic');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page).toHaveURL(/\/account\/invite$/);
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await expect(page.getByRole('button', { name: '创建新任务', exact: true })).toBeEnabled();
}

test('新账号从团队创建任务首次进入即可复制共享链接，独立普通窗口进入同任务', async ({}, testInfo) => {
  const windows = await openChromeWindows();
  const { a, b } = windows;
  try {
    await register(a);
    let sourceCreates = 0;
    a.on('request', request => {
      if (request.method() === 'POST' && isImportComplete(request.url())) sourceCreates++;
    });
    const imported = a.waitForResponse(
      response => response.request().method() === 'POST' && isImportComplete(response.url())
    );
    const chooser = a.waitForEvent('filechooser');
    await a.getByRole('button', { name: '创建新任务', exact: true }).click();
    await (await chooser).setFiles(syntheticSeries(2).files);
    const response = await imported;
    expect(response.status()).toBe(200);
    const task = (await response.json()).data;
    await expect(a).toHaveURL(new RegExp(`task_id=${task.task_id}`));
    await workspaceReady(a);
    await expect(a.getByRole('button', { name: '共享链接', exact: true })).toBeVisible();
    const href = await copySharedLink(a);
    expect(new URL(href).searchParams.get('task_id')).toBe(task.task_id);
    expect(sourceCreates).toBe(1);
    await a.screenshot({ path: testInfo.outputPath('新任务首次共享入口.png') });

    await register(b);
    const viewerWrites: string[] = [];
    b.on('request', request => {
      if (
        request.method() === 'POST' &&
        (isImportComplete(request.url()) || /\/tasks$/.test(new URL(request.url()).pathname))
      ) {
        viewerWrites.push(request.url());
      }
    });
    await b.goto(href);
    await expect(b.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
    await expect
      .poll(() =>
        b.evaluate(() => {
          const business = (
            window as unknown as { services: { businessServices: BusinessServices } }
          ).services.businessServices;
          const view = business.localCollaboration!.sharedView!.getSnapshot();
          return {
            task: view?.task_id,
            ready: view?.view_ready,
            files: view?.local_files.length,
            importerProject: business.projectRuntime!.getCurrent(),
          };
        })
      )
      .toEqual({ task: task.task_id, ready: true, files: 2, importerProject: null });
    expect(viewerWrites).toEqual([]);
    expect(sourceCreates).toBe(1);
    await b.screenshot({ path: testInfo.outputPath('独立窗口共享成功.png') });
  } finally {
    await windows.close();
  }
});

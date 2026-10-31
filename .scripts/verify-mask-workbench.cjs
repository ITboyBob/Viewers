const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function values(page) {
  return page.evaluate(() => {
    const s = window.services;
    const id = s.viewportGridService.getActiveViewportId();
    const active = s.segmentationService.getActiveSegmentation(id);
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId).map(id => {
      let count = 0;
      for (const value of cornerstone.cache.getImage(id).getPixelData()) if (value === 1) count++;
      return count;
    });
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    async locator => locator.click(),
    { times: 1 }
  );
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const checks = [];
  try {
    await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
    const files = fs
      .readdirSync(path.resolve(__dirname, '../demo-data'))
      .filter(file => file.endsWith('.dcm'))
      .map(file => path.resolve(__dirname, '../demo-data', file));
    await page.locator('input[type=file]').first().setInputFiles(files);
    await page.waitForURL(/segmentation\/dicomlocal/);
    await expect(page.locator('.mask-manager')).toBeVisible();
    await expect(page.getByRole('tablist', { name: '标注工作流' }).getByRole('tab')).toHaveCount(4);
    await page.locator('[data-cy="addSegmentation"]').click();
    const panel = page.locator('section[aria-label="Mask 编辑"]');
    const row = page.locator('[data-cy="data-row"]').first();
    await row.getByRole('button', { name: /Actions|操作/ }).click();
    await page.locator('[data-cy="Rename"]').click();
    await page.getByRole('dialog').locator('input').first().fill('骨组织');
    await page.locator('[data-cy="input-dialog-save-button"]').click();
    await expect(row).toContainText('骨组织');
    await expect(panel).toContainText('骨组织');
    checks.push('left-side mask management and renaming stay synchronized with the workbench');
    await page.getByLabel('阈值预设').selectOption('bone');
    await expect(page.getByLabel('阈值下限', { exact: true })).toHaveValue('150');
    await expect(page.getByLabel('阈值上限', { exact: true })).toHaveValue('3071');
    await page.getByRole('slider', { name: '阈值下限滑块', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByLabel('阈值下限', { exact: true })).toHaveValue('151');
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('阈值选区完成');
    assert.deepEqual(await values(page), Array(8).fill(1679));
    await page.screenshot({ path: path.join(output, 'workbench-threshold.png'), fullPage: true });
    checks.push('reference presets and HU sliders apply the expected range to every slice');

    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await panel.getByRole('button', { name: '画笔', exact: true }).click();
    await page.getByLabel('笔刷半径', { exact: true }).fill('4');
    await page.getByRole('tab', { name: 'Sphere', exact: true }).click();
    const activeTool = () =>
      page.evaluate(() => {
        const s = window.services;
        return s.toolGroupService
          .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
          .getActivePrimaryMouseButtonTool();
      });
    assert.equal(await activeTool(), 'SphereBrush');
    await expect(page.getByLabel('笔刷半径', { exact: true })).toHaveValue('4');
    await panel.getByRole('button', { name: '橡皮擦', exact: true }).click();
    assert.equal(await activeTool(), 'SphereEraser');
    await page.getByRole('tab', { name: 'Circle', exact: true }).click();
    assert.equal(await activeTool(), 'CircularEraser');
    checks.push(
      'visible brush controls select real circular and spherical tools with synchronized radius'
    );

    await page.getByLabel('填洞处理范围').selectOption('series');
    await panel.getByRole('button', { name: 'Fill Holes 逐片填洞（整组）', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('逐片填洞完成');
    assert.deepEqual(await values(page), Array(8).fill(1928));
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await values(page), Array(8).fill(1679));
    await panel.getByRole('button', { name: '重做', exact: true }).click();
    assert.deepEqual(await values(page), Array(8).fill(1928));
    checks.push('whole-series per-slice hole filling is one undoable operation');

    await row.getByRole('button', { name: /Hide|隐藏/, exact: true }).click();
    await expect(row.getByRole('button', { name: /Show|显示/, exact: true })).toBeVisible();
    await row.getByRole('button', { name: /Show|显示/, exact: true }).click();
    await row.getByRole('button', { name: /Actions|操作/ }).click();
    await page.locator('[data-cy="LockToggle"]').click();
    await expect(panel.getByRole('button', { name: '画笔', exact: true })).toBeDisabled();
    await row.getByRole('button', { name: /Actions|操作/ }).click();
    await page.locator('[data-cy="LockToggle"]').click();
    await expect(panel.getByRole('button', { name: '画笔', exact: true })).toBeEnabled();
    checks.push('mask visibility and locking remain usable from the left project list');

    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            return [...s.viewportGridService.getState().viewports.keys()].map(
              id => s.cornerstoneViewportService.getCornerstoneViewport(id)?.type
            );
          }),
        { timeout: 30000 }
      )
      .toContain('volume3d');
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            const active = s.segmentationService.getActiveSegmentation(
              s.viewportGridService.getActiveViewportId()
            );
            return Boolean(active?.representationData.Surface?.geometryIds?.size);
          }),
        { timeout: 60000 }
      )
      .toBe(true);
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(await values(page), Array(8).fill(1928));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'workbench-four-view.png'), fullPage: true });
    checks.push(
      'MPR and four-view shortcuts generate a real mask surface and preserve mask pixels'
    );
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await panel.getByRole('button', { name: '重做', exact: true }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole('button', { name: '重做', exact: true })).toBeInViewport();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tools = document.querySelector('.mask-workbench');
          const advanced = document.querySelector('.mask-advanced-tools');
          return advanced.getBoundingClientRect().top >= tools.getBoundingClientRect().bottom - 1;
        })
      )
      .toBe(true);
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByLabel('阈值预设').scrollIntoViewIfNeeded();
    await page.locator('.mask-workbench-panel').evaluate(element => {
      element.scrollTop = 0;
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true
    );
    await page.screenshot({ path: path.join(output, 'workbench-laptop.png'), fullPage: true });
    assert.deepEqual(errors, []);
    checks.push(
      '1366 by 768 layout keeps workflow controls reachable without horizontal page overflow'
    );
    fs.writeFileSync(
      path.join(output, 'workbench-report.json'),
      JSON.stringify({ checks, browserErrors: errors }, null, 2)
    );
    console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'workbench-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'workbench-failure.json'),
      JSON.stringify({ error: error.stack, browserErrors: errors }, null, 2)
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function activeIndex(page) {
  return page.evaluate(() => {
    const s = window.services;
    return s.segmentationService.getActiveSegment(s.viewportGridService.getActiveViewportId())
      ?.segmentIndex;
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
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
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByLabel('阈值处理范围').selectOption('slice');
    const threshold = page.getByRole('button', { name: '应用阈值到当前切片', exact: true });
    await expect(threshold).toBeEnabled();
    await threshold.click();
    await page.getByRole('tab', { name: '拆分', exact: true }).click();
    await page.getByLabel('拆分处理范围').selectOption('slice');
    await page.getByRole('button', { name: 'Split Mask 拆分（单片）', exact: true }).click();
    await expect(page.locator('[data-cy="data-row"]')).toHaveCount(2);
    const confirm = page.getByRole('button', { name: 'Confirm and hide', exact: true });
    if (await confirm.isVisible()) await confirm.click();

    // Reproduce the viewport lifecycle gap using the SDK's public tool-group API.
    // The image and segmentation remain visible while the editing group is detached.
    const detached = await page.evaluate(() => {
      const s = window.services;
      const viewportId = s.viewportGridService.getActiveViewportId();
      const v = s.cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const { cornerstoneTools } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const group = cornerstoneTools.ToolGroupManager.getToolGroupForViewport(viewportId);
      const info = group.getViewportsInfo().find(info => info.viewportId === viewportId);
      const saved = { groupId: group.id, ...info };
      group.removeViewports(info.renderingEngineId, viewportId);
      return saved;
    });
    await page.locator('[data-cy="data-row"]').nth(1).click();
    assert.equal(await activeIndex(page), 2);
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    checks.push('segment row click with a temporarily detached tool group');
    await page.evaluate(saved => {
      const { cornerstoneTools } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      cornerstoneTools.ToolGroupManager.getToolGroup(saved.groupId).addViewport(
        saved.viewportId,
        saved.renderingEngineId
      );
    }, detached);
    await page.locator('[data-cy="data-row"]').nth(0).click();
    assert.equal(await activeIndex(page), 1);
    checks.push('segment row click after the tool group is reattached');

    await page.evaluate(() =>
      window.commandsManager.run('setHangingProtocol', { protocolId: 'mpr', reset: true })
    );
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            const v = s.cornerstoneViewportService.getCornerstoneViewport(
              s.viewportGridService.getActiveViewportId()
            );
            return v?.type === 'orthographic' && Boolean(v.getImageData()?.imageData);
          }),
        { timeout: 30000 }
      )
      .toBe(true);
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await expect(threshold).toBeEnabled({ timeout: 30000 });
    await page.locator('[data-cy="data-row"]').nth(1).click();
    assert.equal(await activeIndex(page), 2);
    await threshold.click();
    await expect(page.getByRole('status')).toContainText('阈值选区完成');
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    checks.push('orthographic MPR slice accepts mask editing and segment selection');

    await page.evaluate(() =>
      window.commandsManager.run('setHangingProtocol', { protocolId: 'only3D', reset: true })
    );
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            const v = s.cornerstoneViewportService.getCornerstoneViewport(
              s.viewportGridService.getActiveViewportId()
            );
            return v?.type;
          }),
        { timeout: 30000 }
      )
      .toBe('volume3d');
    await expect(threshold).toBeDisabled();
    await expect(page.locator('section[aria-label="Mask 编辑"]')).toContainText('三维模型预览');
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    checks.push(
      'three-dimensional preview disables two-dimensional mask actions with an explanation'
    );
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'segment-selection-report.json'),
      JSON.stringify({ checks, browserErrors: errors }, null, 2)
    );
    console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } catch (error) {
    await page.screenshot({
      path: path.join(output, 'segment-selection-failure.png'),
      fullPage: true,
    });
    fs.writeFileSync(
      path.join(output, 'segment-selection-failure.json'),
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

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function activeTool(page) {
  return page.evaluate(() => {
    const s = window.services;
    return s.toolGroupService
      .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
      .getActivePrimaryMouseButtonTool();
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const results = [];
  try {
    for (const count of [8, 1]) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      await page.addLocatorHandler(
        page.getByRole('button', { name: 'Confirm and hide', exact: true }),
        async locator => locator.click(),
        { times: 1 }
      );
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
        const files = fs
          .readdirSync(path.resolve(__dirname, '../demo-data'))
          .filter(file => file.endsWith('.dcm'))
          .slice(0, count)
          .map(file => path.resolve(__dirname, '../demo-data', file));
        await page.locator('input[type=file]').first().setInputFiles(files);
        await page.waitForURL(/segmentation\/dicomlocal/);
        await page.locator('[data-cy="addSegmentation"]').click();
        await page.getByLabel('阈值处理范围').selectOption('slice');
        await expect(
          page.getByRole('button', { name: '应用阈值到当前切片', exact: true })
        ).toBeEnabled();
        await page.evaluate(() => {
          window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
          window.commandsManager.run('setBrushSize', {
            value: 3,
            toolNames: ['CircularBrush', 'SphereBrush'],
          });
        });
        // Use the visible shape selector, including its UI state update path.
        await page.getByRole('tab', { name: 'Sphere', exact: true }).click();
        assert.equal(await activeTool(page), count === 8 ? 'SphereBrush' : 'CircularBrush');
        await expect(
          page.getByRole('tab', { name: count === 8 ? 'Sphere' : 'Circle', exact: true })
        ).toHaveAttribute('aria-selected', 'true');
        const point = await page.evaluate(() => {
          const s = window.services;
          const v = s.cornerstoneViewportService.getCornerstoneViewport(
            s.viewportGridService.getActiveViewportId()
          );
          const rect = v.element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await page.mouse.move(point.x - 6, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 6, point.y, { steps: 6 });
        await page.mouse.up();
        const paintedFrames = await page.evaluate(() => {
          const s = window.services;
          const active = s.segmentationService.getActiveSegmentation(
            s.viewportGridService.getActiveViewportId()
          );
          const { cornerstone } = window.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
            .exports.getCornerstoneLibraries();
          return active.representationData.Labelmap.imageIds.map(id => {
            const values = cornerstone.cache.getImage(id).getPixelData();
            return Array.from(values).filter(value => value !== 0).length;
          });
        });
        assert.ok(
          paintedFrames.some(pixels => pixels > 0),
          'Drawing remains functional'
        );
        if (count === 8) {
          assert.ok(
            paintedFrames.filter(pixels => pixels > 0).length > 1,
            'A valid sphere edits adjacent slices'
          );
        } else {
          const fallbackCases = {
            SphereEraser: 'CircularEraser',
            ThresholdSphereBrush: 'ThresholdCircularBrush',
            ThresholdSphereBrushDynamic: 'ThresholdCircularBrushDynamic',
            SphereScissor: 'CircleScissor',
          };
          for (const [sphere, circle] of Object.entries(fallbackCases)) {
            await page.evaluate(
              toolName => window.commandsManager.run('setToolActiveToolbar', { toolName }),
              sphere
            );
            assert.equal(await activeTool(page), circle);
            await page.mouse.move(point.x, point.y);
            await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
          }
          await page.evaluate(() =>
            window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' })
          );
          await page.getByRole('tab', { name: '阈值', exact: true }).click();
          await page.getByRole('button', { name: '应用阈值到当前切片', exact: true }).click();
          await expect(page.getByRole('status')).toContainText('阈值选区完成');
        }
        assert.deepEqual(errors, [], 'No uncaught sphere or preview cleanup error');
        results.push({
          importedSlices: count,
          paintedFrames,
          behavior: count === 8 ? 'sphere supported' : 'circle fallback',
          browserErrors: errors,
        });
      } catch (error) {
        await page.screenshot({ path: path.join(output, 'sphere-failure.png'), fullPage: true });
        fs.writeFileSync(
          path.join(output, 'sphere-failure.json'),
          JSON.stringify({ error: error.stack, browserErrors: errors }, null, 2)
        );
        throw error;
      } finally {
        await page.close();
      }
    }
    fs.writeFileSync(path.join(output, 'sphere-report.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.log('Sphere support and single-slice fallback verified');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function frameMasks(page) {
  return page.evaluate(() => {
    const s = window.services;
    const active = s.segmentationService.getActiveSegmentation(
      s.viewportGridService.getActiveViewportId()
    );
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId).map(id => {
      const values = cornerstone.cache.getImage(id).getPixelData();
      const counts = {};
      let hash = 2166136261;
      for (const value of values) {
        counts[value] = (counts[value] || 0) + 1;
        hash = Math.imul(hash ^ value, 16777619) >>> 0;
      }
      return { counts, hash };
    });
  });
}

async function imagePoint(page, x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const s = window.services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport(
        s.viewportGridService.getActiveViewportId()
      );
      const { cornerstone } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const world = cornerstone.utilities.transformIndexToWorld(v.getImageData().imageData, [
        x,
        y,
        0,
      ]);
      const canvas = v.worldToCanvas(world);
      const rect = v.element.getBoundingClientRect();
      return { x: rect.left + canvas[0], y: rect.top + canvas[1] };
    },
    { x, y }
  );
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const reports = [];
  try {
    for (const count of [8, 1]) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
      await page.addLocatorHandler(
        page.getByRole('button', { name: 'Confirm and hide', exact: true }),
        async locator => locator.click(),
        { times: 1 }
      );
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const panel = page.locator('section[aria-label="Mask 编辑"]');
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
        await expect(page.getByLabel('阈值处理范围')).toHaveValue('series');
        const threshold = page.getByRole('button', { name: '应用阈值到整组切片', exact: true });
        await expect(threshold).toBeEnabled();
        const confirm = page.getByRole('button', { name: 'Confirm and hide', exact: true });
        if (await confirm.isVisible()) await confirm.click();
        await threshold.click();
        await expect(panel.getByRole('status')).toContainText(`整组 ${count} 张切片阈值选区完成`);
        const allSelected = await frameMasks(page);
        assert.equal(allSelected.length, count);
        assert.ok(
          allSelected.every(frame => frame.counts[1] === 1679),
          'Every slice is selected in one operation'
        );
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.ok(
          (await frameMasks(page)).every(frame => !frame.counts[1]),
          'One undo restores the entire series'
        );
        await panel.getByRole('button', { name: '重做', exact: true }).click();
        assert.deepEqual(await frameMasks(page), allSelected);

        if (count > 1) {
          const oldId = await page.evaluate(() => {
            const s = window.services;
            return s.cornerstoneViewportService
              .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
              .getCurrentImageId();
          });
          const point = await imagePoint(page, 64, 64);
          await page.mouse.move(point.x, point.y);
          await page.mouse.wheel(0, 150);
          await expect
            .poll(() =>
              page.evaluate(() => {
                const s = window.services;
                return s.cornerstoneViewportService
                  .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
                  .getCurrentImageId();
              })
            )
            .not.toBe(oldId);
          assert.ok((await frameMasks(page)).every(frame => frame.counts[1] === 1679));
        }

        // Protect a real second label while reducing the seed's current mask.
        await page.evaluate(() => {
          const s = window.services;
          const id = s.viewportGridService.getActiveViewportId();
          const active = s.segmentationService.getActiveSegmentation(id);
          s.segmentationService.addSegment(active.segmentationId, {
            segmentIndex: 2,
            label: 'Protected',
          });
          s.segmentationService.setActiveSegment(active.segmentationId, 1);
          const { cornerstone, cornerstoneTools } = window.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
            .exports.getCornerstoneLibraries();
          const ids = cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId);
          cornerstone.cache.getImage(ids[0]).voxelManager.setAtIndex(0, 2);
          cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
            active.segmentationId
          );
        });
        const beforeGrow = await frameMasks(page);
        await page.getByRole('tab', { name: '区域生长', exact: true }).click();
        await panel
          .getByRole('button', { name: 'Region Grow 区域生长 · 点选保留', exact: true })
          .click();
        const outside = await imagePoint(page, 10, 110);
        await page.mouse.click(outside.x, outside.y, { delay: 50 });
        await expect(panel.getByRole('alert')).toContainText('已着色区域');
        assert.deepEqual(
          await frameMasks(page),
          beforeGrow,
          'Invalid seeds leave all masks unchanged'
        );
        const seed = await imagePoint(page, 40, 48);
        await page.mouse.click(seed.x, seed.y, { delay: 50 });
        await expect(panel.getByRole('status')).toContainText('区域生长完成');
        const grown = await frameMasks(page);
        assert.ok(
          grown.every(frame => frame.counts[1] === 1008),
          'Only the seeded left ring survives across slices'
        );
        assert.equal(
          grown.reduce((sum, frame) => sum + (frame.counts[2] || 0), 0),
          1,
          'The other mask is protected'
        );
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.deepEqual(await frameMasks(page), beforeGrow);
        await panel.getByRole('button', { name: '重做', exact: true }).click();
        assert.deepEqual(await frameMasks(page), grown);

        await page.getByRole('tab', { name: '阈值', exact: true }).click();
        await page.getByLabel('阈值下限', { exact: true }).fill('700');
        await threshold.click();
        await expect(panel.getByRole('status')).toContainText('阈值选区完成');
        assert.ok((await frameMasks(page)).every(frame => !frame.counts[1]));
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.deepEqual(await frameMasks(page), grown);
        if (count === 8) {
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
          await expect(threshold).toBeEnabled();
          await page.getByLabel('阈值下限', { exact: true }).fill('150');
          await threshold.click();
          await expect(panel.getByRole('status')).toContainText('整组 8 张切片阈值选区完成');
          assert.ok((await frameMasks(page)).every(frame => frame.counts[1] === 1679));
          await page.getByRole('tab', { name: '区域生长', exact: true }).click();
          await panel
            .getByRole('button', { name: 'Region Grow 区域生长 · 点选保留', exact: true })
            .click();
          const mprSeed = await imagePoint(page, 40, 48);
          await page.mouse.click(mprSeed.x, mprSeed.y, { delay: 50 });
          await expect(panel.getByRole('status')).toContainText('区域生长完成');
          assert.ok((await frameMasks(page)).every(frame => frame.counts[1] === 1008));
        }
        await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
        assert.deepEqual(errors, []);
        reports.push({
          slices: count,
          thresholdSelected: 1679 * count,
          regionKept: 1008 * count,
          regionRemoved: 671 * count,
          otherMaskPreserved: true,
          wholeSeriesUndoRedo: true,
          scrollVerified: count > 1,
          mprVerified: count > 1,
          browserErrors: errors,
        });
        if (count === 8)
          await page.screenshot({ path: path.join(output, 'volume-mask.png'), fullPage: true });
      } catch (error) {
        await page.screenshot({
          path: path.join(output, 'volume-mask-failure.png'),
          fullPage: true,
        });
        fs.writeFileSync(
          path.join(output, 'volume-mask-failure.json'),
          JSON.stringify({ error: error.stack, browserErrors: errors }, null, 2)
        );
        throw error;
      } finally {
        await page.close();
      }
    }
    fs.writeFileSync(
      path.join(output, 'volume-mask-report.json'),
      JSON.stringify(reports, null, 2)
    );
    console.log(JSON.stringify(reports, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

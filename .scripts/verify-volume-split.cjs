const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function snapshot(page) {
  return page.evaluate(() => {
    const s = window.services;
    const active = s.segmentationService.getActiveSegmentation(
      s.viewportGridService.getActiveViewportId()
    );
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const frames = cornerstoneTools.segmentation
      .getLabelmapImageIds(active.segmentationId)
      .map(id => {
        const counts = {};
        let hash = 2166136261;
        for (const value of cornerstone.cache.getImage(id).getPixelData()) {
          counts[value] = (counts[value] || 0) + 1;
          hash = Math.imul(hash ^ value, 16777619) >>> 0;
        }
        return { counts, hash };
      });
    return { frames, segments: Object.keys(active.segments).map(Number) };
  });
}

async function editFixture(page, action) {
  return page.evaluate(action => {
    const s = window.services;
    const id = s.viewportGridService.getActiveViewportId();
    const active = s.segmentationService.getActiveSegmentation(id);
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const ids = cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId);
    const vm = cornerstone.cache.getImage(ids[0]).voxelManager;
    if (action === 'protect') {
      s.segmentationService.addSegment(active.segmentationId, {
        segmentIndex: 2,
        label: 'Protected',
      });
      s.segmentationService.setActiveSegment(active.segmentationId, 1);
      vm.setAtIndex(0, 2);
    } else if (action === 'orphan') {
      vm.setAtIndex(1, 1);
    } else if (action === 'cut-one-slice') {
      for (let y = 60; y <= 68; y++) for (let x = 87; x <= 89; x++) vm.setAtIndex(y * 128 + x, 0);
    }
    cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      active.segmentationId
    );
  }, action);
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
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
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    const panel = page.locator('section[aria-label="Mask 编辑"]');
    await expect(panel.getByRole('status')).toContainText('阈值选区完成');
    await editFixture(page, 'protect');
    const original = await snapshot(page);
    const analyze = panel.getByRole('button', { name: 'Split Mask 三维预览', exact: true });
    const preview = panel.getByRole('region', { name: '三维拆分预览', exact: true });
    await expect(page.getByLabel('拆分处理范围')).toHaveValue('series');
    const hover = await page.evaluate(() => {
      const s = window.services;
      const id = s.viewportGridService.getActiveViewportId();
      const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
      const group = s.toolGroupService.getToolGroupForViewport(id);
      group.setToolConfiguration('CircularBrush', { brushSize: 4, preview: { enabled: true } });
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
      const { cornerstone } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const world = cornerstone.utilities.transformIndexToWorld(
        v.getImageData().imageData,
        [62, 64, 0]
      );
      const [x, y] = v.worldToCanvas(world);
      const rect = v.element.getBoundingClientRect();
      return { x: rect.left + x, y: rect.top + y };
    });
    await page.mouse.move(hover.x, hover.y);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.services;
          return s.toolGroupService
            .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
            .getToolInstance('CircularBrush')
            .hasPreviewData();
        })
      )
      .toBe(true);
    await analyze.click();
    await expect(preview).toContainText('2 个可拆分区域');
    await expect(preview.getByRole('row')).toHaveCount(3);
    await expect(preview).toContainText('16,128');
    assert.deepEqual(await snapshot(page), original);
    await page.evaluate(() => {
      const s = window.services;
      s.toolGroupService
        .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
        .setToolConfiguration('CircularBrush', { preview: { enabled: false } });
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'WindowLevel' });
    });
    checks.push(
      'uncommitted brush previews are rejected before analysis without changing accepted annotations'
    );
    await preview.getByRole('button', { name: '定位', exact: true }).nth(1).click();
    assert.deepEqual(await snapshot(page), original);
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'volume-split-preview.png'), fullPage: true });
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(preview).toHaveCount(0);
    assert.deepEqual(await snapshot(page), original);
    checks.push(
      'analysis, physical-volume statistics, locating and closing preview do not change the mask'
    );

    await analyze.click();
    await expect(preview).toContainText('2 个可拆分区域');
    await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('三维拆分完成');
    const split = await snapshot(page);
    assert.deepEqual(split.segments, [1, 2, 3]);
    assert.ok(split.frames.every(frame => frame.counts[1] === 1008 && frame.counts[3] === 671));
    assert.equal(
      split.frames.reduce((sum, frame) => sum + (frame.counts[2] || 0), 0),
      1
    );
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), original);
    await panel.getByRole('button', { name: '重做', exact: true }).click();
    assert.deepEqual(await snapshot(page), split);
    checks.push('one three-dimensional split updates all eight slices and preserves other masks');
    checks.push('one undo and redo restore both complete pixel data and segment metadata');

    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    await analyze.click();
    await expect(preview).toContainText('2 个可拆分区域');
    await editFixture(page, 'orphan');
    const edited = await snapshot(page);
    await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('重新分析');
    assert.deepEqual(await snapshot(page), edited);
    checks.push('editing the mask invalidates the analysis before any new segment is created');

    await page.getByLabel('拆分最小区域体素数').fill('2');
    await analyze.click();
    await expect(preview).toContainText('2 个可拆分区域');
    await expect(preview).toContainText('1 个小区域');
    await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('三维拆分完成');
    const smallKept = await snapshot(page);
    assert.equal(smallKept.frames[0].counts[1], 1009);
    assert.ok(smallKept.frames.every(frame => frame.counts[3] === 671));
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), edited);
    checks.push('small regions remain in the original mask instead of being discarded');

    await editFixture(page, 'cut-one-slice');
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
    await page.getByLabel('拆分最小区域体素数').fill('2');
    await analyze.click();
    await expect(preview).toContainText('2 个可拆分区域');
    await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('三维拆分完成');
    const mprSplit = await snapshot(page);
    assert.deepEqual(mprSplit.segments, [1, 2, 3]);
    checks.push(
      'MPR uses three-dimensional connectivity even when a bridge is cut on only one slice'
    );
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'volume-split.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'volume-split-report.json'),
      JSON.stringify({ checks, browserErrors: errors }, null, 2)
    );
    console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'volume-split-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'volume-split-failure.json'),
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

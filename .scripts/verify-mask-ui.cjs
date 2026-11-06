const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function snapshot(page) {
  return page.evaluate(() => {
    const { segmentationService, viewportGridService, cornerstoneViewportService } =
      window.services;
    const viewportId = viewportGridService.getActiveViewportId();
    const active = segmentationService.getActiveSegmentation(viewportId);
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const { cornerstone } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const labelmap = active.representationData.Labelmap;
    const volume = labelmap.volumeId ? cornerstone.cache.getVolume(labelmap.volumeId) : undefined;
    const point = volume
      ? cornerstone.utilities.transformWorldToIndex(
          volume.imageData,
          viewport.getCamera().focalPoint
        )
      : null;
    const z = volume
      ? Math.round(point[2])
      : labelmap.referencedImageIds.indexOf(viewport.getCurrentImageId());
    const counts = {};
    const wholeCounts = {};
    const labelImage = volume ? null : cornerstone.cache.getImage(labelmap.imageIds[z]);
    const [width, height, depth] = volume
      ? volume.dimensions
      : [labelImage.columns, labelImage.rows, labelmap.imageIds.length];
    const values = [];
    for (let k = 0; k < depth; k++)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const value = volume
            ? volume.voxelManager.getAtIJK(x, y, k)
            : cornerstone.cache
                .getImage(labelmap.imageIds[k])
                .voxelManager.getAtIndex(x + y * width);
          wholeCounts[value] = (wholeCounts[value] || 0) + 1;
          if (k === z) {
            counts[value] = (counts[value] || 0) + 1;
            values.push(value);
          }
        }
    return {
      counts,
      wholeCounts,
      values,
      z,
      segments: Object.keys(active.segments).map(Number),
      active: segmentationService.getActiveSegment(viewportId).segmentIndex,
    };
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    async locator => locator.click(),
    { times: 1 }
  );
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.setDefaultTimeout(30000);
  try {
    await page.goto('http://localhost:3000/local-mask', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    const files = fs
      .readdirSync(path.resolve(__dirname, '../demo-data'))
      .filter(file => file.endsWith('.dcm'))
      .map(file => path.resolve(__dirname, '../demo-data', file));
    await page.locator('input[type=file]').first().setInputFiles(files);
    await page.waitForURL(/segmentation\/dicomlocal/, { timeout: 60000 });
    const confirm = page.getByRole('button', { name: 'Confirm and hide', exact: true });
    if (await confirm.isVisible()) await confirm.click();
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByLabel('阈值处理范围').selectOption('slice');
    const thresholdButton = page.getByRole('button', { name: '应用阈值到当前切片', exact: true });
    await expect(thresholdButton).toBeEnabled({ timeout: 60000 });
    await page.getByLabel('阈值下限', { exact: true }).fill('150');
    await page.getByLabel('阈值上限', { exact: true }).fill('2000');
    await thresholdButton.click();
    await expect(page.getByRole('status')).toContainText('阈值选区完成');
    const threshold = await snapshot(page);
    assert.ok(threshold.counts[1] > 1000);
    assert.equal(
      threshold.counts[1],
      threshold.wholeCounts[1],
      'Only the current plane is modified'
    );
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: 'Fill Holes 填洞（单片）', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已填充');
    const filled = await snapshot(page);
    assert.ok(filled.counts[1] > threshold.counts[1]);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual((await snapshot(page)).values, threshold.values);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.deepEqual((await snapshot(page)).values, filled.values);
    await page.getByRole('tab', { name: '拆分', exact: true }).click();
    await page.getByLabel('拆分处理范围').selectOption('slice');
    await page.getByRole('button', { name: 'Split Mask 拆分（单片）', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已拆为 2 个 Mask');
    const split = await snapshot(page);
    assert.equal(split.segments.length, 2);
    assert.ok(split.counts[2] > 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    const unsplit = await snapshot(page);
    assert.deepEqual(unsplit.values, filled.values);
    assert.equal(unsplit.segments.length, 1);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.deepEqual((await snapshot(page)).values, split.values);

    // Use the real native eraser through pointer input to cut the synthetic bridge.
    const point = await page.evaluate(() => {
      const { segmentationService, viewportGridService, cornerstoneViewportService } =
        window.services;
      const viewportId = viewportGridService.getActiveViewportId();
      const active = segmentationService.getActiveSegmentation(viewportId);
      segmentationService.setActiveSegment(active.segmentationId, 2);
      window.commandsManager.run('setBrushSize', { value: 3, toolNames: ['CircularEraser'] });
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularEraser' });
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const { cornerstone } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volumeId = active.representationData.Labelmap.volumeId;
      const volume = volumeId ? cornerstone.cache.getVolume(volumeId) : undefined;
      const imageData = volume ? volume.imageData : viewport.getImageData().imageData;
      const focal = volume
        ? cornerstone.utilities.transformWorldToIndex(imageData, viewport.getCamera().focalPoint)
        : [0, 0, 0];
      const world = cornerstone.utilities.transformIndexToWorld(imageData, [
        88,
        64,
        Math.round(focal[2]),
      ]);
      const [x, y] = viewport.worldToCanvas(world);
      const rect = viewport.element.getBoundingClientRect();
      return { x: rect.left + x, y: rect.top + y };
    });
    await page.mouse.move(point.x - 24, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 24, point.y, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await snapshot(page)).counts[2], { timeout: 10000 })
      .toBeLessThan(split.counts[2]);
    await page.getByRole('tab', { name: '拆分', exact: true }).click();
    await page.getByRole('button', { name: 'Split Mask 拆分（单片）', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已拆为 2 个 Mask');
    const cut = await snapshot(page);
    assert.equal(cut.segments.length, 3);
    assert.ok(cut.counts[3] > 0);
    if (await confirm.isVisible()) await confirm.click();
    await page.screenshot({ path: path.join(output, 'mask-demo.png'), fullPage: true });
    const report = {
      threshold: threshold.counts,
      filled: filled.counts,
      split: split.counts,
      afterNativeEraserAndSplit: cut.counts,
      browserErrors: errors,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    assert.equal(errors.length, 0, errors.join('\n'));
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    console.log(JSON.stringify(report, null, 2));
    console.log('OHIF browser verification passed');
  } catch (error) {
    await page
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {});
    fs.writeFileSync(
      path.join(output, 'failure.json'),
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

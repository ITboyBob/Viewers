const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function context(page) {
  return page.evaluate(() => {
    const s = window.services;
    const viewportId = s.viewportGridService.getActiveViewportId();
    const v = s.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const active = s.segmentationService.getActiveSegmentation(viewportId);
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    let count = 0;
    let hash = 2166136261;
    for (const id of cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId)) {
      for (const value of cornerstone.cache.getImage(id).getPixelData()) {
        if (value === 1) count++;
        hash = Math.imul(hash ^ value, 16777619) >>> 0;
      }
    }
    const rect = v.element.getBoundingClientRect();
    return {
      count,
      hash,
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      viewportType: v.type,
      maskVolumeId: active.representationData.Labelmap.volumeId,
      actors: v.getActors().map(actor => ({ uid: actor.uid, referencedId: actor.referencedId })),
    };
  });
}

async function draw(page, point) {
  await page.mouse.move(point.x - 6, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 6, point.y, { steps: 6 });
  await page.mouse.up();
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
    await expect(page.locator('section[aria-label="Mask 编辑"]').getByRole('status')).toContainText(
      '阈值选区完成'
    );
    await page.evaluate(() => {
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
      window.commandsManager.run('setBrushSize', {
        value: 3,
        toolNames: ['CircularBrush', 'CircularEraser'],
      });
    });
    await draw(page, (await context(page)).point);
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
    // A viewport may also contain overlay actors without a volume reference.
    // Register one through the real viewport API to reproduce the reported path.
    await page.evaluate(() => {
      const s = window.services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport(
        s.viewportGridService.getActiveViewportId()
      );
      v.addActor({ uid: 'mask-qa-overlay-without-volume', actor: v.getActors()[0].actor });
    });
    const mpr = await context(page);
    assert.ok(
      mpr.actors.some(actor => !actor.referencedId),
      'The regression includes an actor without a volume reference'
    );
    await page.evaluate(() =>
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularEraser' })
    );
    await draw(page, mpr.point);
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    checks.push('stack painting followed by MPR and an eraser switch');

    for (const toolName of [
      'CircularBrush',
      'CircularEraser',
      'ThresholdCircularBrushDynamic',
      'SphereBrush',
      'SphereEraser',
    ]) {
      const before = await context(page);
      await page.evaluate(name => {
        window.commandsManager.run('setToolActiveToolbar', { toolName: name });
        window.commandsManager.run('setBrushSize', { value: 3, toolNames: [name] });
      }, toolName);
      await draw(page, before.point);
      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      const after = await context(page);
      if (toolName === 'CircularBrush' || toolName === 'SphereBrush')
        assert.ok(after.count > before.count, `${toolName} paints in MPR`);
      if (toolName === 'CircularEraser' || toolName === 'SphereEraser')
        assert.ok(after.count < before.count, `${toolName} erases in MPR`);
      checks.push(`MPR ${toolName} editing and preview cleanup`);
    }

    // The edit-data adapter must also resolve an image-backed mask in a volume viewport.
    const editData = await page.evaluate(() => {
      const s = window.services;
      const id = s.viewportGridService.getActiveViewportId();
      const v = s.cornerstoneViewportService.getCornerstoneViewport(id);
      const active = s.segmentationService.getActiveSegmentation(id);
      const group = s.toolGroupService.getToolGroupForViewport(id);
      const { cornerstone } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = cornerstone.cache.getVolume(active.representationData.Labelmap.volumeId);
      return group.getToolInstance('CircularBrush').getEditData({
        viewport: v,
        segmentationId: active.segmentationId,
        segmentsLocked: [],
        representationData: { Labelmap: { imageIds: volume.imageIds } },
      });
    });
    assert.ok(editData.volumeId && editData.referencedVolumeId);
    assert.notEqual(editData.volumeId, editData.referencedVolumeId);
    checks.push('image-backed mask resolves to the correct source and segmentation volumes');

    const beforePreview = await context(page);
    await page.evaluate(() => {
      const s = window.services;
      const id = s.viewportGridService.getActiveViewportId();
      const group = s.toolGroupService.getToolGroupForViewport(id);
      group.setToolConfiguration('CircularBrush', { preview: { enabled: true } });
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
    });
    await page.mouse.move(beforePreview.point.x, beforePreview.point.y);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            const id = s.viewportGridService.getActiveViewportId();
            return s.toolGroupService
              .getToolGroupForViewport(id)
              .getToolInstance('CircularBrush')
              .hasPreviewData();
          }),
        { timeout: 10000 }
      )
      .toBe(true);
    await page.evaluate(() =>
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularEraser' })
    );
    assert.equal(
      (await context(page)).hash,
      beforePreview.hash,
      'Rejecting a live preview restores all mask pixels'
    );
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    checks.push('rejecting a live MPR preview preserves the complete mask');
    await page.evaluate(() =>
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'WindowLevel' })
    );
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, 'mpr-brush-report.json'),
      JSON.stringify({ checks, browserErrors: errors }, null, 2)
    );
    console.log(JSON.stringify({ checks, browserErrors: errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'mpr-brush-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'mpr-brush-failure.json'),
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

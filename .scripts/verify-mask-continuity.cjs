const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });

async function masks(page) {
  return page.evaluate(() => {
    const s = window.services;
    const active = s.segmentationService.getActiveSegmentation(
      s.viewportGridService.getActiveViewportId()
    );
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId).map(id => {
      const counts = {};
      for (const value of cornerstone.cache.getImage(id).getPixelData())
        counts[value] = (counts[value] || 0) + 1;
      return counts;
    });
  });
}

async function surfaces(page) {
  return page.evaluate(() => {
    const s = window.services;
    const { cornerstone } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const segmentation = s.segmentationService.getActiveSegmentation(
      s.viewportGridService.getActiveViewportId()
    );
    const hash = values => {
      let result = 2166136261;
      for (const value of values)
        result = Math.imul(result ^ Math.round(value * 1000), 16777619) >>> 0;
      return result;
    };
    return s.cornerstoneViewportService
      .getRenderingEngine()
      .getViewports()
      .filter(v => v.type === 'volume3d')
      .flatMap(v =>
        v
          .getActors()
          .filter(a => a.representationUID?.startsWith(`${segmentation.segmentationId}-Surface-`))
          .map(a => {
            const index = Number(a.representationUID.split('-').pop());
            const actorData = a.actor.getMapper().getInputData();
            const points = actorData.getPoints().getData();
            const cached = cornerstone.cache.getGeometry(
              segmentation.representationData.Surface.geometryIds.get(index)
            )?.data;
            return {
              index,
              color: a.actor.getProperty().getColor(),
              visible: Boolean(a.actor.getVisibility()),
              pointCount: points.length,
              pointHash: hash(points),
              geometryPointHash: cached ? hash(cached.points) : null,
            };
          })
      )
      .sort((a, b) => a.index - b.index);
  });
}

async function activeTool(page) {
  return page.evaluate(() => {
    const s = window.services;
    const group = s.toolGroupService.getToolGroupForViewport(
      s.viewportGridService.getActiveViewportId()
    );
    const name = group.getActivePrimaryMouseButtonTool();
    return { name, radius: group.getToolConfiguration(name)?.brushSize };
  });
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click(),
    { times: 1 }
  );
  try {
    await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles(
        fs
          .readdirSync(path.resolve(__dirname, '../demo-data'))
          .filter(file => file.endsWith('.dcm'))
          .map(file => path.resolve(__dirname, '../demo-data', file))
      );
    await page.waitForURL(/segmentation\/dicomlocal/);
    await page.locator('[data-cy="addSegmentation"]').click();
    const initializationGuard = await page.evaluate(async () => {
      const s = window.services;
      const viewportId = s.viewportGridService.getActiveViewportId();
      const id = s.viewportGridService.getDisplaySetsUIDsForViewport(viewportId)[0];
      const displaySet = s.displaySetService.getDisplaySetByUID(id);
      const imageIds = displaySet.imageIds;
      const before = s.segmentationService.getSegmentations().length;
      try {
        displaySet.imageIds = undefined;
        const result = await window.commandsManager.run('createLabelmapForViewport', {
          viewportId,
        });
        return { result, unchanged: before === s.segmentationService.getSegmentations().length };
      } finally {
        displaySet.imageIds = imageIds;
      }
    });
    assert.deepEqual(initializationGuard, { result: false, unchanged: true });
    checks.push(
      'creation before image references are ready returns safely without registering an invalid Mask'
    );
    const panel = page.locator('section[aria-label="Mask 编辑"]');
    const tab = name => page.getByRole('tab', { name, exact: true });
    const lower = page.getByLabel('阈值下限', { exact: true });
    const upper = page.getByLabel('阈值上限', { exact: true });
    const apply = panel.getByRole('button', { name: '应用阈值到整组切片', exact: true });
    const original = await masks(page);
    await lower.fill('');
    await apply.click();
    await expect(panel.getByRole('alert')).toContainText('请填写阈值上下限');
    await lower.fill('2000');
    await upper.fill('150');
    await apply.click();
    await expect(panel.getByRole('alert')).toContainText('阈值下限不能大于上限');
    await tab('编辑').click();
    const previousTool = await activeTool(page);
    await panel.getByRole('button', { name: '阈值笔刷', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('阈值下限不能大于上限');
    assert.deepEqual(await activeTool(page), previousTool);
    assert.deepEqual(await masks(page), original);
    checks.push('empty and reversed thresholds cannot alter pixels or activate a threshold brush');

    await panel.getByRole('button', { name: '画笔', exact: true }).click();
    const radius = page.getByLabel('笔刷半径', { exact: true });
    const command = name => page.evaluate(name => window.commandsManager.run(name), name);
    await radius.fill('4');
    await command('increaseBrushSize');
    await expect(radius).toHaveValue('7');
    assert.equal((await activeTool(page)).radius, 7);
    await radius.fill('0.5');
    await command('decreaseBrushSize');
    await expect(radius).toHaveValue('0.5');
    assert.equal((await activeTool(page)).radius, 0.5);
    await radius.fill('99.5');
    await command('increaseBrushSize');
    await expect(radius).toHaveValue('99.5');
    await expect(page.getByLabel('笔刷半径滑块')).toHaveValue('99.5');
    assert.equal((await activeTool(page)).radius, 99.5);
    await radius.fill('4');
    await panel.getByRole('button', { name: '橡皮擦', exact: true }).click();
    await page.evaluate(() =>
      window.commandsManager.run('setBrushSize', { value: 10, toolNames: ['CircularBrush'] })
    );
    await expect(radius).toHaveValue('4');
    assert.equal((await activeTool(page)).radius, 4);
    await command('increaseBrushSize');
    await expect(radius).toHaveValue('7');
    assert.equal((await activeTool(page)).radius, 7);
    checks.push(
      'brush shortcuts clamp the actual active radius and keep fields and sliders synchronized'
    );

    await tab('阈值').click();
    await lower.fill('150');
    await upper.fill('2000');
    await apply.click();
    await expect(panel.getByRole('status')).toContainText('阈值选区完成');
    await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
    await expect.poll(() => surfaces(page), { timeout: 60000 }).toHaveLength(1);
    const initialSurface = (await surfaces(page))[0];
    assert.equal(initialSurface.pointHash, initialSurface.geometryPointHash);

    const row = page.locator('[data-cy="data-row"]').first();
    await row.getByRole('button', { name: '操作', exact: true }).click();
    await page.locator('[data-cy="Change Color"]').click();
    const picker = page.locator('.chrome-picker');
    await expect(picker).toBeVisible();
    await picker.getByLabel('hex', { exact: true }).fill('#00ff00');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await surfaces(page))[0]?.color).toEqual([0, 1, 0]);
    assert.equal((await surfaces(page))[0].pointHash, initialSurface.pointHash);
    checks.push('changing Mask color through the native dialog updates the existing 3D actor');

    const visibility = () =>
      page.evaluate(() => {
        const s = window.services;
        const active = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
        const { cornerstoneTools } = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries();
        return s.segmentationService
          .getViewportIdsWithSegmentation(active.segmentationId)
          .flatMap(id =>
            s.segmentationService
              .getSegmentationRepresentations(id)
              .filter(rep => rep.segmentationId === active.segmentationId)
              .map(rep =>
                cornerstoneTools.segmentation.config.visibility.getSegmentIndexVisibility(
                  id,
                  { segmentationId: active.segmentationId, type: rep.type },
                  1
                )
              )
          );
      });
    await row.getByRole('button', { name: '隐藏', exact: true }).click();
    await expect.poll(async () => (await surfaces(page))[0]?.visible).toBe(false);
    assert.ok((await visibility()).every(value => !value));
    await row.getByRole('button', { name: '显示', exact: true }).click();
    await expect.poll(async () => (await surfaces(page))[0]?.visible).toBe(true);
    assert.ok((await visibility()).every(Boolean));
    assert.deepEqual(await masks(page), Array(8).fill({ 0: 14705, 1: 1679 }));
    checks.push(
      'project Mask visibility switches every slice representation and the 3D actor together without changing pixels'
    );

    await row.getByRole('button', { name: '隐藏', exact: true }).click();
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
    await expect
      .poll(async () => (await surfaces(page))[0]?.color, { timeout: 20000 })
      .toEqual([0, 1, 0]);
    await expect.poll(async () => (await surfaces(page))[0]?.visible).toBe(false);
    assert.ok((await visibility()).every(value => !value));
    await row.getByRole('button', { name: '显示', exact: true }).click();
    await expect.poll(async () => (await surfaces(page))[0]?.visible).toBe(true);
    checks.push(
      'Mask colors and hidden state persist when switching away from and back to the four-view layout'
    );

    // Translate the labelmap without changing topology: point counts alone must not suppress updates.
    await page.evaluate(() => {
      const s = window.services;
      const active = s.segmentationService.getActiveSegmentation(
        s.viewportGridService.getActiveViewportId()
      );
      const { cornerstone, cornerstoneTools } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      for (const id of cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId)) {
        const image = cornerstone.cache.getImage(id);
        const vm = image.voxelManager;
        const before = Uint8Array.from(vm.getScalarData());
        for (let y = 0; y < image.rows; y++)
          for (let x = 0; x < image.columns; x++)
            vm.setAtIndex(y * image.columns + x, x >= 3 ? before[y * image.columns + x - 3] : 0);
      }
      cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
        active.segmentationId
      );
    });
    await expect
      .poll(async () => (await surfaces(page))[0]?.pointHash, { timeout: 20000 })
      .not.toBe(initialSurface.pointHash);
    const translated = (await surfaces(page))[0];
    assert.equal(translated.pointCount, initialSurface.pointCount);
    assert.equal(translated.pointHash, translated.geometryPointHash);
    checks.push('edits with unchanged mesh point counts update the actual rendered geometry');

    await tab('编辑').click();
    await page.getByLabel('填洞处理范围').selectOption('series');
    await panel.getByRole('button', { name: 'Fill Holes 逐片填洞（整组）', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('逐片填洞完成');
    await expect
      .poll(async () => (await surfaces(page))[0]?.pointHash)
      .not.toBe(translated.pointHash);
    const filled = await masks(page);
    const filledSurface = (await surfaces(page))[0];
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await surfaces(page))[0]?.pointHash).toBe(translated.pointHash);
    await panel.getByRole('button', { name: '重做', exact: true }).click();
    await expect
      .poll(async () => (await surfaces(page))[0]?.pointHash)
      .toBe(filledSurface.pointHash);
    assert.deepEqual(await masks(page), filled);
    checks.push(
      'whole-series fill undo and redo restore the rendered surface as well as all mask pixels'
    );

    await tab('拆分').click();
    await panel.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
    const preview = panel.getByRole('region', { name: '三维拆分预览', exact: true });
    await expect(preview).toContainText('2 个可拆分区域');
    await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('三维拆分完成');
    await expect.poll(() => surfaces(page), { timeout: 20000 }).toHaveLength(2);
    const split = await masks(page);
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(() => surfaces(page)).toHaveLength(1);
    assert.deepEqual(await masks(page), filled);
    await panel.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(() => surfaces(page)).toHaveLength(2);
    assert.deepEqual(await masks(page), split);
    checks.push('split undo removes the extra 3D actor and redo restores both masks and surfaces');

    await page.locator('[data-cy="data-row"]').nth(1).click();
    await tab('阈值').click();
    await lower.fill('3000');
    await upper.fill('3071');
    await apply.click();
    await expect(panel.getByRole('status')).toContainText('阈值选区完成');
    const removed = await masks(page);
    removed.forEach((counts, index) => {
      assert.equal(counts[1], split[index][1]);
      assert.equal(counts[2], undefined);
    });
    await expect.poll(async () => (await surfaces(page)).map(s => s.index)).toEqual([1]);
    await panel.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await masks(page), split);
    await expect.poll(() => surfaces(page)).toHaveLength(2);
    checks.push('switching masks changes only the selected mask and undo restores both masks');

    await page.screenshot({ path: path.join(output, 'continuity-final.png'), fullPage: true });
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(errors, []);
    const report = { checks, browserErrors: errors };
    fs.writeFileSync(path.join(output, 'continuity-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'continuity-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'continuity-failure.json'),
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

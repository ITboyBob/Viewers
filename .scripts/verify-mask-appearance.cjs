const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });
async function rendering(page, segmentationId) {
  return page.evaluate(segmentationId => {
    const s = window.services;
    const { cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return s.cornerstoneViewportService
      .getRenderingEngine()
      .getViewports()
      .filter(v => v.type !== 'volume3d')
      .flatMap(v => {
        const id =
          segmentationId || s.segmentationService.getActiveSegmentation(v.id)?.segmentationId;
        const rep = cornerstoneTools.segmentation.state.getSegmentationRepresentations(v.id, {
          segmentationId: id,
          type: 'Labelmap',
        })[0];
        const actor = v
          .getActors()
          .find(a => a.representationUID?.startsWith(id + '-Labelmap'))?.actor;
        if (!rep?.config?.ofun || !actor) return [];
        const widths = actor.getProperty().getLabelOutlineThickness();
        return [
          {
            viewportId: v.id,
            alpha: [1, 2].map(i => rep.config.ofun.getValue(i)),
            widths: [widths[0], widths[1]],
            colors: [1, 2].map(i => {
              const c = [];
              rep.config.cfun.getColor(i, c);
              return c;
            }),
          },
        ];
      });
  }, segmentationId);
}
async function maskHash(page, id) {
  return page.evaluate(id => {
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    let hash = 2166136261;
    for (const imageId of cornerstoneTools.segmentation.getLabelmapImageIds(id))
      for (const v of cornerstone.cache.getImage(imageId).getPixelData())
        hash = Math.imul(hash ^ v, 16777619) >>> 0;
    return hash;
  }, id);
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  const consoleErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('console', message => {
    if (message.type() === 'debug' && message.text().includes('Error Boundary'))
      consoleErrors.push(message.text());
  });
  const errors = [],
    checks = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    l => l.click(),
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
          .filter(f => f.endsWith('.dcm'))
          .map(f => path.resolve(__dirname, '../demo-data', f))
      );
    await page.waitForURL(/segmentation\/dicomlocal/);
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await page.getByRole('tab', { name: '拆分', exact: true }).click();
    await page.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
    await page.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    const id = await page.evaluate(() => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId(),
        a = s.segmentationService.getActiveSegmentation(v);
      s.segmentationService.setSegmentLabel(a.segmentationId, 1, '红色骨组织');
      s.segmentationService.setSegmentLabel(a.segmentationId, 2, '蓝色骨组织');
      s.segmentationService.setSegmentColorForAllViewports(a.segmentationId, 1, [255, 0, 0, 255]);
      s.segmentationService.setSegmentColorForAllViewports(a.segmentationId, 2, [0, 80, 255, 255]);
      // Simulate an independent style retained by the previous highlight implementation.
      s.segmentationService.setStyle(
        { type: 'Labelmap', segmentationId: a.segmentationId, segmentIndex: 1 },
        { fillAlpha: 0.5 }
      );
      return a.segmentationId;
    });
    const before = await maskHash(page, id);
    const rows = page.locator('[data-cy="data-row"]');
    await rows.first().click();
    await page.getByRole('button', { name: 'Mask 外观设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Mask 外观设置', exact: true });
    const opacity = panel.getByLabel('Mask 填充不透明度', { exact: true });
    const width = panel.getByLabel('Mask 轮廓宽度', { exact: true });
    await expect(panel).toContainText('1 · 红色骨组织');
    await expect(panel.locator('span[aria-hidden="true"]').first()).toHaveCSS(
      'background-color',
      'rgb(255, 0, 0)'
    );
    await opacity.fill('0.2');
    await opacity.press('Tab');
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0.5]);
    await width.fill('5.5');
    await width.press('Tab');
    await expect.poll(async () => (await rendering(page, id))[0]?.widths).toEqual([5.5, 3]);
    checks.push(
      'a retained highlight style does not prevent the selected red Mask from changing; the blue Mask stays unchanged'
    );

    await rows.nth(1).click();
    await expect(panel).toContainText('2 · 蓝色骨组织');
    await expect(panel.locator('span[aria-hidden="true"]').first()).toHaveCSS(
      'background-color',
      'rgb(0, 80, 255)'
    );
    await expect(opacity).toHaveValue('0.5');
    await expect(width).toHaveValue('3');
    await panel.getByRole('tab', { name: '仅轮廓', exact: true }).click();
    await expect(opacity).toBeDisabled();
    await expect(panel).toContainText('仅轮廓模式不显示填充');
    await width.fill('7');
    await width.press('Tab');
    await expect.poll(async () => (await rendering(page, id))[0]?.widths).toEqual([5.5, 7]);
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0.01]);
    await panel.getByRole('tab', { name: '仅填充', exact: true }).click();
    await expect(width).toBeDisabled();
    await expect.poll(async () => (await rendering(page, id))[0]?.widths).toEqual([5.5, 0]);
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0.5]);
    await panel.getByRole('tab', { name: '填充+轮廓', exact: true }).click();
    await opacity.fill('0');
    await opacity.press('Tab');
    await expect(opacity).toHaveValue('0');
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0]);
    await panel.getByRole('slider', { name: 'Mask 填充不透明度滑块', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(opacity).toHaveValue('0.1');
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0.1]);
    await page.keyboard.press('ArrowLeft');
    await expect(opacity).toHaveValue('0');
    const colors = (await rendering(page, id))[0].colors;
    assert.deepEqual(colors[0], [1, 0, 0]);
    assert.ok(Math.abs(colors[1][1] - 80 / 255) < 0.0001);
    assert.equal(colors[1][2], 1);
    checks.push(
      'fill/outline modes, zero opacity, and per-Mask border widths reach the actual actor without exchanging colors'
    );

    await rows.first().click();
    await expect(opacity).toHaveValue('0.2');
    await expect(width).toHaveValue('5.5');
    await opacity.fill('1.5');
    await opacity.press('Tab');
    await expect(opacity).toHaveValue('0.2');
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.services,
            v = s.viewportGridService.getActiveViewportId();
          return s.segmentationService.getStyle({ viewportId: v, type: 'Labelmap' }).fillAlpha;
        })
      )
      .toBe(0.5);
    checks.push(
      'selection restores each Mask controls, invalid input preserves the previous value, and global defaults are unchanged'
    );

    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect.poll(async () => (await rendering(page, id)).length, { timeout: 30000 }).toBe(3);
    await expect
      .poll(async () =>
        (await rendering(page, id)).every(
          v =>
            Math.abs(v.alpha[0] - 0.2) < 0.0001 &&
            v.alpha[1] === 0 &&
            v.widths[0] === 5.5 &&
            v.widths[1] === 7
        )
      )
      .toBe(true);
    await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.services.cornerstoneViewportService
              .getRenderingEngine()
              .getViewports()
              .some(
                v =>
                  v.type === 'volume3d' &&
                  v.getActors().some(a => a.representationUID?.includes('-Surface-'))
              )
          ),
        { timeout: 60000 }
      )
      .toBe(true);
    await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService
          .getRenderingEngine()
          .getViewports()
          .find(v => v.type === 'volume3d');
      s.viewportGridService.setActiveViewportId(v.id);
    });
    await expect(opacity).toBeDisabled();
    await expect(width).toBeDisabled();
    await expect(panel).toContainText('请选择二维切片窗口');
    await page.getByRole('button', { name: '轴向优先', exact: true }).click();
    await expect(opacity).toBeEnabled();
    await expect(opacity).toHaveValue('0.2');
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0]);
    checks.push(
      'per-Mask appearance survives MPR and layout changes; the 3D viewport explains the 2D-only controls'
    );

    const second = await page.evaluate(async () => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId();
      const id = await window.commandsManager.run('createLabelmapForViewport', {
        viewportId: v,
        options: { label: '另一份标注集', createInitialSegment: true },
      });
      s.segmentationService.setSegmentLabel(id, 1, '绿色独立标注');
      s.segmentationService.setSegmentColorForAllViewports(id, 1, [0, 255, 0, 255]);
      return id;
    });
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(panel).toContainText('绿色独立标注');
    await opacity.fill('0.7');
    await opacity.press('Tab');
    await expect.poll(async () => (await rendering(page, second))[0]?.alpha[0]).toBe(0.7);
    await expect.poll(async () => (await rendering(page, id))[0]?.alpha).toEqual([0.2, 0]);
    assert.equal(await maskHash(page, id), before);
    checks.push(
      'another annotation set receives its own appearance and leaves previous masks and their voxel data unchanged'
    );
    await page.setViewportSize({ width: 1366, height: 768 });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'appearance-fixed.png'), fullPage: true });
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(errors, []);
    const report = { checks, browserErrors: errors };
    fs.writeFileSync(path.join(output, 'appearance-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    await page.screenshot({ path: path.join(output, 'appearance-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'appearance-failure.json'),
      JSON.stringify(
        {
          error: e.stack,
          browserErrors: errors,
          consoleErrors,
          debug: await page.evaluate(() => ({
            url: location.href,
            body: document.body.innerHTML.slice(-9000),
            services: Boolean(window.services),
            grid: window.services?.viewportGridService.getState(),
          })),
        },
        null,
        2
      )
    );
    throw e;
  } finally {
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});

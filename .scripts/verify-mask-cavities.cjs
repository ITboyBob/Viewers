const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 120000 });
const { refinementReference } = require('./refinement-reference.cjs');
const root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-cavities');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], operations: [], errors: [] };
async function compare(page, expected = false) {
  return page.evaluate(expected => {
    const f = window.__cavities,
      values = expected ? f.expected : f.baseline;
    let mismatches = 0;
    for (let i = 0; i < values.length; i++)
      mismatches += f.volume.voxelManager.getAtIndex(i) !== values[i];
    return mismatches;
  }, expected);
}
async function reference(page, maximumCavityVolumeMm3, roi) {
  return page.evaluate(
    ({ source, maximumCavityVolumeMm3, roi }) => {
      const f = window.__cavities,
        result = new Function('return (' + source + ')')()(
          f.baseline,
          f.volume.dimensions,
          f.volume.spacing,
          { operation: 'fillCavities', maximumCavityVolumeMm3 }
        );
      f.expected = result.output;
      let added = 0,
        outsideChanges = 0;
      const dims = f.volume.dimensions;
      for (let i = 0; i < result.output.length; i++) {
        if (roi && result.output[i] !== f.baseline[i]) {
          const world = f.volume.imageData.indexToWorld([
            i % dims[0],
            Math.floor(i / dims[0]) % dims[1],
            Math.floor(i / (dims[0] * dims[1])),
          ]);
          const inside = roi.axes.every((axis, k) => {
            const dot = axis.reduce((sum, v, j) => sum + v * world[j], 0);
            return dot >= roi.min[k] - 1e-4 && dot <= roi.max[k] + 1e-4;
          });
          if (!inside) {
            result.output[i] = f.baseline[i];
            outsideChanges++;
          }
        }
        added += f.baseline[i] === 0 && result.output[i] === 1;
      }
      return {
        added,
        cavities: result.cavities,
        eligibleCavities: result.eligibleCavities,
        outsideChanges,
      };
    },
    { source: refinementReference.toString(), maximumCavityVolumeMm3, roi }
  );
}
async function preview(page) {
  await page.getByRole('button', { name: '预览三维空腔填充', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览三维空腔填充', exact: true })).toBeEnabled();
  return page.evaluate(() => window.__cavities.preview);
}
async function checkPreview(page, expected) {
  const actual = await preview(page);
  assert.equal(actual.added, expected.added);
  assert.equal(actual.removed, 0);
  assert.equal(actual.cavities, expected.cavities);
  assert.equal(actual.eligibleCavities, expected.eligibleCavities);
  assert.equal(await compare(page), 0, 'preview changed accepted labels');
  if (expected.added) {
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('可整组撤销');
    assert.equal(await compare(page, true), 0, '3D fill differs from independent reference');
    await expect(page.getByTestId('next-undo')).toContainText('三维空腔填充');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await compare(page), 0, 'undo did not restore the entire series');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await compare(page, true), 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await compare(page), 0);
  } else {
    await expect(page.getByRole('button', { name: '应用精修结果', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '关闭精修预览', exact: true }).click();
  }
  return actual;
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'debug' && m.text().includes('Error Boundary')) report.errors.push(m.text());
  });
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    l => l.click(),
    { times: 1 }
  );
  try {
    await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
    await page.locator('input[type=file]').first().setInputFiles(files);
    await page.waitForURL(/segmentation\/dicomlocal/);
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeEnabled();
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '编辑工具组：三维填洞', exact: true }).click();
    report.geometry = await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        total = volume.dimensions.reduce((a, b) => a * b, 1);
      const baseline = Uint8Array.from({ length: total }, (_, i) =>
        volume.voxelManager.getAtIndex(i)
      );
      window.__cavities = { volume, baseline, id: a.segmentationId, tasks: [] };
      c.eventTarget.addEventListener(
        'OHIF_MASK_REFINEMENT_PREVIEW',
        e => (window.__cavities.preview = e.detail.preview)
      );
      c.eventTarget.addEventListener('OHIF_MASK_REFINEMENT_TASK', e => {
        window.__cavities.tasks.push(e.detail);
        if (
          window.__cavities.cancelCompute &&
          e.detail.phase === 'running' &&
          ((e.detail.stage === 'compute' && e.detail.percent > 20) || e.detail.stage === 'validate')
        ) {
          window.__cavities.cancelCompute = false;
          window.__cavities.cancelStage = e.detail.stage;
          window.commandsManager.run('cancelMaskRefinementCalculation', { taskId: e.detail.id });
        }
      });
      return { dimensions: [...volume.dimensions], spacing: [...volume.spacing] };
    });
    // Unmodified threshold result on the actual DICOM, before constructing special topology fixtures.
    const natural = await reference(page, 1000),
      started = Date.now();
    console.log(`[${key}] original threshold reference ready`);
    await checkPreview(page, natural);
    report.operations.push({
      fixture: 'original HU threshold on DICOM',
      maximumVolumeMm3: 1000,
      ...natural,
      workflowMs: Date.now() - started,
    });
    report.checks.push(
      'actual threshold Mask on the loaded DICOM matches an independent 26-connected cavity scan voxel-for-voxel; preview is read-only and applied results undo/redo losslessly'
    );
    const limit = await page.evaluate(() => {
      const f = window.__cavities,
        { volume } = f,
        dims = volume.dimensions;
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      for (let i = 0; i < f.baseline.length; i++)
        if (volume.voxelManager.getAtIndex(i)) volume.voxelManager.setAtIndex(i, 0);
      const box = (from, to, value) => {
        for (let z = from[2]; z <= to[2]; z++)
          for (let y = from[1]; y <= to[1]; y++)
            for (let x = from[0]; x <= to[0]; x++)
              volume.voxelManager.setAtIndex(x + dims[0] * (y + dims[1] * z), value);
      };
      // Two closed cavities (75 and 147 voxels), an axial tube and a diagonal exterior leak.
      box([12, 12, 1], [18, 18, 5], 1);
      box([13, 13, 2], [17, 17, 4], 0);
      box([26, 12, 0], [32, 18, dims[2] - 1], 1);
      box([27, 13, 0], [31, 17, dims[2] - 1], 0);
      box([40, 12, 1], [46, 18, 5], 1);
      box([41, 13, 2], [45, 17, 4], 0);
      box([40, 12, 1], [40, 12, 1], 0);
      box([54, 12, 1], [62, 20, 5], 1);
      box([55, 13, 2], [61, 19, 4], 0);
      const service = window.services.segmentationService;
      service.addSegment(f.id, { segmentIndex: 2, label: '锁定受保护 Mask', isLocked: true });
      service.setActiveSegment(f.id, 1);
      box([15, 15, 3], [15, 15, 3], 2);
      f.baseline = Uint8Array.from({ length: f.baseline.length }, (_, i) =>
        volume.voxelManager.getAtIndex(i)
      );
      c.utilities.HistoryMemo.DefaultHistoryMemo.size =
        c.utilities.HistoryMemo.DefaultHistoryMemo.size;
      c.eventTarget.dispatchEvent(new CustomEvent('OHIF_MASK_HISTORY_CHANGED'));
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(f.id);
      return 75 * volume.spacing.reduce((a, b) => a * b, 1);
    });
    await page.getByLabel('空腔最大体积 mm3', { exact: true }).fill('0');
    await page.getByRole('button', { name: '预览三维空腔填充', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('空腔最大体积');
    assert.equal(await compare(page), 0);
    await page.getByLabel('空腔最大体积 mm3', { exact: true }).fill(String(limit));
    const limited = await reference(page, limit);
    console.log(`[${key}] known topology fixture ready`);
    assert.equal(limited.cavities, 2);
    assert.equal(limited.eligibleCavities, 1);
    assert.equal(limited.added, 74);
    await checkPreview(page, limited);
    report.operations.push({
      fixture: 'known topology in source geometry',
      maximumVolumeMm3: limit,
      ...limited,
    });
    await page.getByLabel('三维填洞不限制体积', { exact: true }).check();
    await expect(page.getByLabel('空腔最大体积 mm3', { exact: true })).toBeDisabled();
    const unlimited = await reference(page);
    assert.equal(unlimited.added, 221);
    await checkPreview(page, unlimited);
    report.checks.push(
      'known topology preserves axial and diagonal exterior channels, fills all enclosed layers, honors an inclusive physical-volume limit, protects the locked Mask and supports explicit unlimited mode'
    );
    await page.evaluate(() => {
      window.__cavities.cancelCompute = true;
    });
    await page.getByRole('button', { name: '预览三维空腔填充', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已取消精修计算');
    assert.equal(await compare(page), 0);
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toHaveCount(0);
    report.cancellationStage = await page.evaluate(() => window.__cavities.cancelStage);
    console.log(`[${key}] cancellation verified`);
    report.checks.push(
      'cancelling during calculation or final validation leaves all labels unchanged and publishes no stale preview'
    );
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByRole('button', { name: '框选三维 ROI', exact: true }).click();
    const corners = await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        rect = v.element.getBoundingClientRect();
      const volume = window.__cavities.volume,
        z = volume.imageData.worldToIndex(v.getCamera().focalPoint)[2];
      return [
        [15.25, 10.25, z],
        [36.25, 22.25, z],
      ].map(p => {
        const canvas = v.worldToCanvas(volume.imageData.indexToWorld(p));
        return [rect.left + canvas[0], rect.top + canvas[1]];
      });
    });
    await page.mouse.move(...corners[0]);
    await page.mouse.down();
    await page.mouse.move(...corners[1], { steps: 10 });
    await page.mouse.up();
    await page.getByLabel('ROI 起始层', { exact: true }).fill('2');
    await page
      .getByLabel('ROI 结束层', { exact: true })
      .fill(String(report.geometry.dimensions[2] - 1));
    const roi = JSON.parse(await page.locator('[data-mask-roi]').getAttribute('data-mask-roi'));
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByLabel('精修仅处理 ROI', { exact: true }).check();
    const roiReference = await reference(page, undefined, roi);
    assert.ok(roiReference.added > 0 && roiReference.added < 74);
    assert.ok(roiReference.outsideChanges > 147);
    await checkPreview(page, roiReference);
    console.log(`[${key}] ROI verified`);
    report.operations.push({ fixture: 'ROI writing with full-volume topology', ...roiReference });
    report.checks.push(
      'ROI clips only writes: a partial closed cavity is filled inside ROI, outside pixels stay intact and an axial channel is not closed by the ROI slice limits'
    );
    await page.getByLabel('精修仅处理 ROI', { exact: true }).uncheck();
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.evaluate(() => {
      const f = window.__cavities,
        { cornerstoneTools: t } = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries();
      f.volume = t.utilities.segmentation.getOrCreateSegmentationVolume(f.id);
      f.baseline = Uint8Array.from({ length: f.baseline.length }, (_, i) =>
        f.volume.voxelManager.getAtIndex(i)
      );
    });
    const mprReference = await reference(page);
    await checkPreview(page, mprReference);
    console.log(`[${key}] MPR verified`);
    await preview(page);
    await expect(page.getByTestId('cavity-counts')).toContainText('全组封闭空腔 2 处');
    await page.screenshot({ path: path.join(output, key + '-mpr-preview.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭精修预览', exact: true }).click();
    report.checks.push(
      'MPR preserves source geometry and cavity results; preview counts, full-series application and undo/redo remain consistent'
    );
    await preview(page);
    const changed = await page.evaluate(() => {
      const f = window.__cavities;
      const { cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      f.volume.voxelManager.setAtIndex(0, 1);
      f.baseline[0] = 1;
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(f.id);
      return 1;
    });
    assert.equal(changed, 1);
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('发生修改');
    assert.equal(await compare(page), 0, 'stale cavity preview overwrote a later edit');
    report.checks.push('applying a stale preview is rejected without overwriting later edits');
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    await page.screenshot({ path: path.join(output, key + '-failure.png'), fullPage: true });
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, key + '-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

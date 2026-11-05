const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect: baseExpect } = require('@playwright/test');
const { unzipSync } = require('fflate');
const { interpolationReference } = require('./interpolation-reference.cjs');
const expect = baseExpect.configure({ timeout: 120000 });
const root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-interpolation');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], operations: [], errors: [] };
async function open(browser, inputs = files) {
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
  await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').first().setInputFiles(inputs);
  await page.waitForURL(/segmentation\/dicomlocal/);
  await expect(page.getByRole('button', { name: '载入标注文件', exact: true })).toBeEnabled();
  return page;
}
async function compare(page, expected = false) {
  return page.evaluate(expected => {
    const f = window.__interpolation,
      values = expected ? f.expected : f.baseline;
    let mismatches = 0;
    for (let i = 0; i < values.length; i++)
      mismatches += f.volume.voxelManager.getAtIndex(i) !== values[i];
    return mismatches;
  }, expected);
}
async function reference(page, replaceIntermediate, roi) {
  return page.evaluate(
    ({ source, replaceIntermediate, roi }) => {
      const f = window.__interpolation,
        dims = f.volume.dimensions;
      const result = new Function('return (' + source + ')')()(f.baseline, dims, f.volume.spacing, {
        keyframes: [2, 4, 6],
        replaceIntermediate,
      });
      f.expected = result.output;
      let added = 0,
        removed = 0,
        outsideChanges = 0;
      for (let i = 0; i < result.output.length; i++) {
        if (roi && result.output[i] !== f.baseline[i]) {
          const world = f.volume.imageData.indexToWorld([
            i % dims[0],
            Math.floor(i / dims[0]) % dims[1],
            Math.floor(i / (dims[0] * dims[1])),
          ]);
          const inside = roi.axes.every((axis, k) => {
            const value = axis.reduce((sum, v, j) => sum + v * world[j], 0);
            return value >= roi.min[k] - 1e-4 && value <= roi.max[k] + 1e-4;
          });
          if (!inside) {
            result.output[i] = f.baseline[i];
            outsideChanges++;
          }
        }
        added += f.baseline[i] === 0 && result.output[i] === 1;
        removed += f.baseline[i] === 1 && result.output[i] === 0;
      }
      return {
        added,
        removed,
        outsideChanges,
        interpolatedSlices: result.interpolatedSlices,
        skippedSlices: result.skippedSlices,
      };
    },
    { source: interpolationReference.toString(), replaceIntermediate, roi }
  );
}
async function preview(page, expected) {
  await page.getByRole('button', { name: '预览关键层插值', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览关键层插值', exact: true })).toBeEnabled();
  const actual = await page.evaluate(() => window.__interpolation.preview);
  assert.deepEqual(actual.keyframes, [2, 4, 6]);
  assert.equal(actual.added, expected.added);
  assert.equal(actual.removed, expected.removed);
  assert.equal(actual.interpolatedSlices, expected.interpolatedSlices);
  assert.equal(actual.skippedSlices, expected.skippedSlices);
  assert.equal(await compare(page), 0, 'preview modified accepted labels');
  await expect(page.getByTestId('interpolation-summary')).toContainText('关键层 3 张');
  return actual;
}
async function apply(page) {
  await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('可整组撤销');
  assert.equal(
    await compare(page, true),
    0,
    'interpolated labels differ from independent nearest-point distances'
  );
  await expect(page.getByTestId('next-undo')).toContainText('关键层插值');
}
async function undo(page) {
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await compare(page), 0, 'undo failed to restore all source layers');
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await open(browser);
  try {
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeEnabled();
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '编辑工具组：插值', exact: true }).click();
    report.geometry = await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        dims = volume.dimensions,
        plane = dims[0] * dims[1],
        total = plane * dims[2];
      for (let i = 0; i < total; i++)
        if (volume.voxelManager.getAtIndex(i)) volume.voxelManager.setAtIndex(i, 0);
      const x = Math.floor(dims[0] / 2),
        y = Math.floor(dims[1] / 2);
      for (const [z, radius] of [
        [1, 1],
        [3, 3],
        [5, 2],
      ])
        for (let b = -radius; b <= radius; b++)
          for (let a = -radius; a <= radius; a++)
            volume.voxelManager.setAtIndex(x + a + dims[0] * (y + b) + plane * z, 1);
      // An existing manual middle layer and a protected locked label in the other gap.
      volume.voxelManager.setAtIndex(x + 10 + dims[0] * y + plane * 2, 1);
      s.segmentationService.addSegment(a.segmentationId, {
        segmentIndex: 2,
        label: '插值保护区域',
        isLocked: true,
      });
      s.segmentationService.setActiveSegment(a.segmentationId, 1);
      volume.voxelManager.setAtIndex(x + dims[0] * y + plane * 4, 2);
      window.__interpolation = {
        id: a.segmentationId,
        volume,
        baseline: Uint8Array.from({ length: total }, (_, i) => volume.voxelManager.getAtIndex(i)),
      };
      c.eventTarget.addEventListener(
        'OHIF_MASK_REFINEMENT_PREVIEW',
        e => (window.__interpolation.preview = e.detail.preview)
      );
      c.utilities.HistoryMemo.DefaultHistoryMemo.size =
        c.utilities.HistoryMemo.DefaultHistoryMemo.size;
      c.eventTarget.dispatchEvent(new CustomEvent('OHIF_MASK_HISTORY_CHANGED'));
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(a.segmentationId);
      return { dimensions: [...dims], spacing: [...volume.spacing] };
    });
    await page.getByLabel('插值关键层方式', { exact: true }).selectOption('multiple');
    await page.getByRole('button', { name: '读取当前 Mask 已标注层', exact: true }).click();
    await expect(page.getByLabel('插值关键层列表', { exact: true })).toHaveValue('2, 3, 4, 6');
    assert.equal(await compare(page), 0);
    await expect(page.getByTestId('next-undo')).toHaveText(/下一步撤销：无/);
    const slice = await page.evaluate(
      () => window.commandsManager.run('getMaskRefinementSliceContext').slice
    );
    await page.getByRole('button', { name: '添加当前层为关键层', exact: true }).click();
    const keys = [...new Set([2, 3, 4, 6, slice])].sort((a, b) => a - b).join(', ');
    await expect(page.getByLabel('插值关键层列表', { exact: true })).toHaveValue(keys);
    await page.getByRole('button', { name: '添加当前层为关键层', exact: true }).click();
    await expect(page.getByLabel('插值关键层列表', { exact: true })).toHaveValue(keys);
    report.checks.push(
      'reading colored layers and appending the current axial layer are read-only, sorted and duplicate-free; other Mask-only layers are excluded'
    );
    console.log(`[${key}] keyframe discovery verified`);
    for (const value of ['2,4,4,6', '6,4,2']) {
      await page.getByLabel('插值关键层列表', { exact: true }).fill(value);
      await page.getByRole('button', { name: '预览关键层插值', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('递增且不能重复');
      assert.equal(await compare(page), 0);
    }
    await page.getByLabel('插值关键层列表', { exact: true }).fill('2,4,7');
    await page.getByRole('button', { name: '预览关键层插值', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('第 7 张关键层没有');
    assert.equal(await compare(page), 0);
    await page.getByLabel('插值关键层列表', { exact: true }).fill('2，4，6');
    const skipped = await reference(page, false);
    assert.equal(skipped.interpolatedSlices, 1);
    assert.equal(skipped.skippedSlices, 1);
    await preview(page, skipped);
    await apply(page);
    await page.getByText(/^操作历史（/).click();
    await expect(page.getByTestId('mask-history-entries')).toContainText('关键层：2, 4, 6');
    await expect(page.getByTestId('mask-history-entries')).toContainText('已有中间层：跳过');
    await undo(page);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await compare(page, true), 0);
    await undo(page);
    report.operations.push({ mode: 'skip accepted middle layers', ...skipped });
    report.checks.push(
      'multiple changing contours match independent nearest-point physical distances, preserve explicit keys and locked labels, skip manual layers, and support one-step undo/redo with actual history parameters'
    );
    await page.getByLabel('替换已有中间层', { exact: true }).check();
    const replaced = await reference(page, true);
    assert.equal(replaced.interpolatedSlices, 2);
    assert.equal(replaced.skippedSlices, 0);
    await preview(page, replaced);
    await apply(page);
    await undo(page);
    report.operations.push({ mode: 'replace accepted middle layers', ...replaced });
    console.log(`[${key}] piecewise interpolation and undo verified`);
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByRole('button', { name: '框选三维 ROI', exact: true }).click();
    const corners = await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        r = v.element.getBoundingClientRect(),
        volume = window.__interpolation.volume,
        d = volume.dimensions;
      const z = volume.imageData.worldToIndex(v.getCamera().focalPoint)[2],
        x = Math.floor(d[0] / 2),
        y = Math.floor(d[1] / 2);
      return [
        [x + 0.25, y - 5 + 0.25, z],
        [x + 5.25, y + 5.25, z],
      ].map(p => {
        const a = v.worldToCanvas(volume.imageData.indexToWorld(p));
        return [r.left + a[0], r.top + a[1]];
      });
    });
    await page.mouse.move(...corners[0]);
    await page.mouse.down();
    await page.mouse.move(...corners[1], { steps: 10 });
    await page.mouse.up();
    const roi = JSON.parse(await page.locator('[data-mask-roi]').getAttribute('data-mask-roi'));
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByLabel('精修仅处理 ROI', { exact: true }).check();
    const limited = await reference(page, true, roi);
    assert.ok(limited.added > 0 && limited.added < replaced.added);
    assert.ok(limited.outsideChanges > 0);
    await preview(page, limited);
    await apply(page);
    await undo(page);
    report.operations.push({ mode: 'ROI writing only', ...limited });
    console.log(`[${key}] ROI verified`);
    report.checks.push(
      'ROI restricts only writes and protects outside manual edits while retaining the full keyframe contours'
    );
    await page.getByLabel('精修仅处理 ROI', { exact: true }).uncheck();
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.evaluate(() => {
      const f = window.__interpolation,
        { cornerstoneTools: t } = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries();
      f.volume = t.utilities.segmentation.getOrCreateSegmentationVolume(f.id);
      f.baseline = Uint8Array.from({ length: f.baseline.length }, (_, i) =>
        f.volume.voxelManager.getAtIndex(i)
      );
    });
    await page.getByLabel('插值关键层列表', { exact: true }).fill('2, 4, 6');
    const mpr = await reference(page, true);
    await preview(page, mpr);
    await page.screenshot({ path: path.join(output, key + '-mpr-preview.png'), fullPage: true });
    await apply(page);
    const expectedFrames = await page.evaluate(() => {
      const f = window.__interpolation,
        volume = f.volume;
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      return t.segmentation.getLabelmapImageIds(f.id).map(imageId => {
        const image = c.cache.getImage(imageId),
          m = c.metaData.get('instance', image.referencedImageId),
          start = m.ImagePositionPatient.map(Number),
          o = m.ImageOrientationPatient.map(Number),
          spacing = m.PixelSpacing.map(Number);
        const origin = volume.imageData.worldToIndex(start),
          dx = volume.imageData
            .worldToIndex(start.map((v, i) => v + o[i] * spacing[1]))
            .map((v, i) => v - origin[i]),
          dy = volume.imageData
            .worldToIndex(start.map((v, i) => v + o[i + 3] * spacing[0]))
            .map((v, i) => v - origin[i]);
        let hash = 2166136261;
        for (let y = 0; y < Number(m.Rows); y++)
          for (let x = 0; x < Number(m.Columns); x++) {
            const p = origin.map((v, i) => Math.round(v + dx[i] * x + dy[i] * y));
            const value =
              f.expected[p[0] + volume.dimensions[0] * (p[1] + volume.dimensions[1] * p[2])];
            hash = Math.imul(hash ^ value, 16777619) >>> 0;
          }
        return [m.SOPInstanceUID || m.SopInstanceUID, hash];
      });
    });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存标注文件', exact: true }).click();
    const filename = path.join(output, key + '-interpolated.ohifmask');
    await (await download).saveAs(filename);
    const archive = unzipSync(fs.readFileSync(filename)),
      manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8')),
      hashes = new Map(expectedFrames);
    let offset = 0;
    for (const frame of manifest.source.frames) {
      let hash = 2166136261;
      for (let i = 0; i < frame.rows * frame.columns; i++)
        hash = Math.imul(hash ^ archive['labels.bin'][offset++], 16777619) >>> 0;
      assert.equal(
        hash,
        hashes.get(frame.sopInstanceUID),
        'saved interpolation has wrong source-layer correspondence'
      );
    }
    const fresh = await open(browser, [...files].reverse());
    await fresh.getByLabel('载入本地标注文件', { exact: true }).setInputFiles(filename);
    await expect(fresh.getByRole('status')).toContainText('已载入');
    const restored = await fresh.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      return t.segmentation.getLabelmapImageIds(a.segmentationId).map(id => {
        const image = c.cache.getImage(id),
          m = c.metaData.get('instance', image.referencedImageId);
        let hash = 2166136261;
        for (const value of image.getPixelData()) hash = Math.imul(hash ^ value, 16777619) >>> 0;
        return [m.SOPInstanceUID || m.SopInstanceUID, hash];
      });
    });
    for (const [uid, hash] of restored) assert.equal(hash, hashes.get(uid));
    await fresh.close();
    await undo(page);
    report.checks.push(
      'MPR output, saved .ohifmask and a fresh browser importing source DICOM in reverse order all preserve every source SOP UID and label-pixel hash'
    );
    await preview(page, mpr);
    await page.evaluate(() => {
      const f = window.__interpolation;
      const { cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      f.volume.voxelManager.setAtIndex(0, 1);
      f.baseline[0] = 1;
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(f.id);
    });
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('发生修改');
    assert.equal(await compare(page), 0);
    report.checks.push('stale previews cannot overwrite a later edit');
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

const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { refinementReference } = require('./refinement-reference.cjs');
const { unzipSync } = require('fflate');
const root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-refinement');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], errors: [], operations: [] };
async function verify(page, expected) {
  return page.evaluate(expected => {
    const { volume, baseline } = window.__refinement;
    const values = expected === 'baseline' ? baseline : window.__refinement.expected;
    let mismatches = 0,
      count = 0,
      protectedCount = 0;
    for (let i = 0; i < values.length; i++) {
      const actual = volume.voxelManager.getAtIndex(i);
      mismatches += actual !== values[i];
      count += actual === 1;
      protectedCount += actual === 2;
    }
    return { mismatches, count, protectedCount };
  }, expected);
}
async function reference(page, options) {
  return page.evaluate(
    ({ source, options }) => {
      const fixture = window.__refinement;
      const result = new Function('return (' + source + ')')()(
        fixture.baseline,
        fixture.volume.dimensions,
        fixture.volume.spacing,
        options
      );
      fixture.expected = result.output;
      let added = 0,
        removed = 0;
      for (let i = 0; i < result.output.length; i++) {
        added += fixture.baseline[i] === 0 && result.output[i] === 1;
        removed += fixture.baseline[i] === 1 && result.output[i] === 0;
      }
      return {
        added,
        removed,
        components: result.components,
        removedComponents: result.removedComponents,
      };
    },
    { source: refinementReference.toString(), options }
  );
}
async function apply(page) {
  await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('可整组撤销', { timeout: 120000 });
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
    await expect(page.getByRole('button', { name: '预览三维形态学', exact: true })).toBeEnabled();
    report.dimensions = await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        dims = volume.dimensions,
        total = dims.reduce((a, b) => a * b, 1),
        plane = dims[0] * dims[1];
      // Put a protected locked Mask immediately beside the target to exercise overwrite protection.
      let at = -1;
      for (let i = 1; i < total - 1; i++)
        if (
          i % dims[0] &&
          volume.voxelManager.getAtIndex(i) === 0 &&
          volume.voxelManager.getAtIndex(i - 1) === 1
        ) {
          at = i;
          break;
        }
      if (at < 0) throw Error('test fixture has no adjacent background');
      s.segmentationService.addSegment(a.segmentationId, {
        segmentIndex: 2,
        label: '受保护区域',
        isLocked: true,
      });
      volume.voxelManager.setAtIndex(at, 2);
      s.segmentationService.setActiveSegment(a.segmentationId, 1);
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(a.segmentationId);
      const baseline = new Uint8Array(total);
      for (let i = 0; i < total; i++) baseline[i] = volume.voxelManager.getAtIndex(i);
      window.__refinement = { volume, baseline, id: a.segmentationId, protectedIndex: at };
      c.eventTarget.addEventListener('OHIF_MASK_REFINEMENT_PREVIEW', event => {
        window.__refinement.preview = event.detail.preview;
      });
      return { dimensions: [...dims], spacing: [...volume.spacing] };
    });
    const kinds =
      key === 'synthetic' ? ['dilate', 'erode', 'open', 'close', 'smooth'] : ['dilate', 'erode'];
    for (const operation of kinds) {
      const radiusMm = key === 'synthetic' ? 2.1 : 1.1,
        options = { operation, radiusMm };
      const expected = await reference(page, options),
        started = Date.now();
      await page.getByLabel('三维形态学操作', { exact: true }).selectOption(operation);
      await page.getByLabel('形态学半径 mm', { exact: true }).fill(String(radiusMm));
      await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '预览三维形态学', exact: true })).toBeEnabled();
      const actual = await page.evaluate(() => window.__refinement.preview);
      assert.equal(actual.added, expected.added);
      assert.equal(actual.removed, expected.removed);
      assert.equal(
        (await verify(page, 'baseline')).mismatches,
        0,
        'preview mutated accepted labels'
      );
      if (expected.added || expected.removed) {
        await expect(page.locator('[data-mask-refinement-preview]')).toBeVisible();
        await apply(page);
        assert.equal(
          (await verify(page, 'expected')).mismatches,
          0,
          'morphology differs from direct spherical reference'
        );
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        assert.equal((await verify(page, 'baseline')).mismatches, 0);
        if (operation === 'dilate') {
          await page.getByRole('button', { name: '重做', exact: true }).click();
          assert.equal((await verify(page, 'expected')).mismatches, 0);
          await page.getByRole('button', { name: '撤销', exact: true }).click();
          assert.equal((await verify(page, 'baseline')).mismatches, 0);
        }
      } else await page.getByRole('button', { name: '关闭精修预览', exact: true }).click();
      report.operations.push({ ...options, ...expected, elapsedMs: Date.now() - started });
    }
    report.checks.push(
      'physical-radius morphology preview counts and every applied voxel match an independent spherical-neighborhood implementation; previews are read-only and undo/redo is lossless'
    );
    for (const operation of ['largest', 'removeSmall']) {
      const options = { operation, minimumVolumeMm3: 1000 },
        expected = await reference(page, options);
      if (operation === 'removeSmall')
        await page.getByLabel('碎片最小体积 mm3', { exact: true }).fill('1000');
      await page
        .getByRole('button', {
          name: operation === 'largest' ? '预览保留最大区域' : '预览删除小碎片',
          exact: true,
        })
        .click();
      await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
      const actual = await page.evaluate(() => window.__refinement.preview);
      assert.equal(actual.removed, expected.removed);
      assert.equal(actual.components, expected.components);
      assert.equal((await verify(page, 'baseline')).mismatches, 0);
      if (expected.removed) {
        await apply(page);
        assert.equal((await verify(page, 'expected')).mismatches, 0);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        assert.equal((await verify(page, 'baseline')).mismatches, 0);
      } else await page.getByRole('button', { name: '关闭精修预览', exact: true }).click();
      report.operations.push({ ...options, ...expected });
    }
    report.checks.push(
      'largest-region retention and physical-volume small-island removal match an independent full component scan, including more than 32 regions on real CT'
    );
    // A genuine image click enters deletion preview without writing accepted labels.
    const seed = await page.evaluate(() => {
      const s = window.services,
        viewport = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone: c } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const { volume, baseline } = window.__refinement,
        dims = volume.dimensions,
        plane = dims[0] * dims[1],
        rect = viewport.element.getBoundingClientRect();
      const z = c.utilities.transformWorldToIndex(
        volume.imageData,
        viewport.getCamera().focalPoint
      )[2];
      for (let y = 2; y < dims[1] - 2; y++)
        for (let x = 2; x < dims[0] - 2; x++) {
          if (baseline[x + dims[0] * (y + dims[1] * z)] !== 1) continue;
          const world = c.utilities.transformIndexToWorld(volume.imageData, [x, y, z]),
            point = viewport.worldToCanvas(world);
          if (
            point[0] > 20 &&
            point[0] < rect.width - 20 &&
            point[1] > 20 &&
            point[1] < rect.height - 20
          )
            return { seed: [x, y, z], canvas: [rect.left + point[0], rect.top + point[1]] };
        }
      throw Error('no visible seed');
    });
    const seedExpected = await reference(page, { operation: 'removeSeed', seed: seed.seed });
    await page.getByRole('button', { name: '点选删除连通区域 · 先预览', exact: true }).click();
    await page.mouse.click(...seed.canvas);
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    assert.equal(
      (await page.evaluate(() => window.__refinement.preview)).removed,
      seedExpected.removed
    );
    assert.equal((await verify(page, 'baseline')).mismatches, 0);
    await apply(page);
    assert.equal((await verify(page, 'expected')).mismatches, 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal((await verify(page, 'baseline')).mismatches, 0);
    report.checks.push(
      'actual point-picking previews deletion of the complete seeded 3D region, preserves other regions and supports whole-series undo'
    );
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              window.services.cornerstoneViewportService.getRenderingEngine().getViewports().length
          ),
        { timeout: 30000 }
      )
      .toBe(3);
    await page.getByLabel('三维形态学操作', { exact: true }).selectOption('dilate');
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    await expect(page.locator('[data-mask-refinement-preview]')).toBeVisible();
    assert.equal((await verify(page, 'baseline')).mismatches, 0);
    await page.screenshot({ path: path.join(output, key + '-mpr-preview.png'), fullPage: true });
    await page.evaluate(() => {
      const f = window.__refinement;
      f.volume.voxelManager.setAtIndex(0, f.baseline[0] === 0 ? 1 : 0);
    });
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('预览后 Mask 已发生修改');
    assert.equal(
      (await verify(page, 'baseline')).mismatches,
      1,
      'stale application changed unrelated accepted voxels'
    );
    await page.evaluate(() => {
      const f = window.__refinement;
      f.volume.voxelManager.setAtIndex(0, f.baseline[0]);
    });
    report.checks.push(
      'MPR has a read-only change overlay; stale snapshots are rejected without overwriting subsequent edits'
    );
    await reference(page, { operation: 'dilate', radiusMm: key === 'synthetic' ? 2.1 : 1.1 });
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    await apply(page);
    assert.equal((await verify(page, 'expected')).mismatches, 0);
    const expectedFrames = await page.evaluate(() => {
      const { volume, expected, id } = window.__refinement;
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      return t.segmentation.getLabelmapImageIds(id).map(imageId => {
        const image = c.cache.getImage(imageId),
          m = c.metaData.get('instance', image.referencedImageId);
        const start = m.ImagePositionPatient.map(Number),
          o = m.ImageOrientationPatient.map(Number),
          spacing = m.PixelSpacing.map(Number);
        const origin = volume.imageData.worldToIndex(start);
        const dx = volume.imageData
          .worldToIndex(start.map((v, i) => v + o[i] * spacing[1]))
          .map((v, i) => v - origin[i]);
        const dy = volume.imageData
          .worldToIndex(start.map((v, i) => v + o[i + 3] * spacing[0]))
          .map((v, i) => v - origin[i]);
        let hash = 2166136261;
        for (let y = 0; y < Number(m.Rows); y++)
          for (let x = 0; x < Number(m.Columns); x++) {
            const p = origin.map((v, i) => Math.round(v + dx[i] * x + dy[i] * y));
            const value =
              expected[p[0] + volume.dimensions[0] * (p[1] + volume.dimensions[1] * p[2])];
            hash = Math.imul(hash ^ value, 16777619) >>> 0;
          }
        return [m.SOPInstanceUID || m.SopInstanceUID, hash];
      });
    });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存标注文件', exact: true }).click();
    const savedFile = path.join(output, key + '-refined.ohifmask');
    await (await download).saveAs(savedFile);
    const archive = unzipSync(fs.readFileSync(savedFile)),
      manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'));
    const hashes = new Map(expectedFrames);
    let offset = 0;
    for (const frame of manifest.source.frames) {
      let hash = 2166136261;
      for (let i = 0; i < frame.rows * frame.columns; i++)
        hash = Math.imul(hash ^ archive['labels.bin'][offset++], 16777619) >>> 0;
      assert.equal(
        hash,
        hashes.get(frame.sopInstanceUID),
        'saved labels are not aligned to their original source slice'
      );
    }
    report.checks.push(
      'the refined MPR mask is saved losslessly to .ohifmask with every source SOP UID and pixel hash verified'
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal((await verify(page, 'baseline')).mismatches, 0);
    report.checks.push(
      'morphology initiated in MPR applies exactly to source-aligned 3D labels and whole-series undo restores them'
    );
    assert.equal((await verify(page, 'baseline')).protectedCount, 1);
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

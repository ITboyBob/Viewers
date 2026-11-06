const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const dcmjs = require('dcmjs');
const { buildReference } = require('./real-dicom-reference.cjs');
const root = path.resolve(__dirname, '../.cache/real-dicom');
const output = path.resolve(__dirname, '../.cache/real-dicom-results');
fs.mkdirSync(output, { recursive: true });
const one = v => (Array.isArray(v) ? v[0] : v);
const list = v => (Array.isArray(v) ? v : [v]);
const testDate =
  process.env.MASK_TEST_DATE ||
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
async function masks(page) {
  return page.evaluate(() => {
    const s = window.services,
      a = s.segmentationService.getActiveSegmentation(s.viewportGridService.getActiveViewportId());
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return cornerstoneTools.segmentation
      .getLabelmapImageIds(a.segmentationId)
      .map(id => {
        const image = cornerstone.cache.getImage(id),
          instance = cornerstone.metaData.get('instance', image.referencedImageId);
        let count = 0,
          hash = 2166136261;
        const counts = {};
        for (const v of image.getPixelData()) {
          count += v === 1;
          hash = Math.imul(hash ^ v, 16777619) >>> 0;
          counts[v] = (counts[v] || 0) + 1;
        }
        return { uid: instance.SOPInstanceUID || instance.SopInstanceUID, count, hash, counts };
      })
      .sort((a, b) => a.uid.localeCompare(b.uid));
  });
}
const pixelsOnly = rows => rows.map(({ uid, count, hash }) => ({ uid, count, hash }));
function inspectExport(file, ref) {
  const bytes = fs.readFileSync(file),
    raw = dcmjs.data.DicomMessage.readFile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
    );
  const d = dcmjs.data.DicomMetaDictionary.naturalizeDataset(raw.dict),
    plane = d.Rows * d.Columns;
  assert.equal(d.Modality, 'SEG');
  assert.equal(d.SegmentationType, 'BINARY');
  assert.equal(list(d.SegmentSequence).length, 1);
  const bits = dcmjs.data.BitArray.unpack(one(d.PixelData)),
    seen = new Set(),
    sourceMap = new Map(ref.frames.map(f => [f.uid, f]));
  const groups = list(d.PerFrameFunctionalGroupsSequence);
  groups.forEach((group, k) => {
    const source = one(one(group.DerivationImageSequence).SourceImageSequence),
      frame = sourceMap.get(source.ReferencedSOPInstanceUID);
    assert.ok(frame, 'SEG source does not belong to the original series');
    assert.equal(Number(one(group.SegmentIdentificationSequence).ReferencedSegmentNumber), 1);
    assert.equal(plane, frame.rows * frame.columns);
    let count = 0,
      hash = 2166136261;
    for (let i = 0; i < plane; i++) {
      const value = Number(bits[k * plane + i] > 0);
      assert.equal(
        value,
        ref.binary[frame.index * plane + i],
        'Exported voxel differs from the independent raw-file reference'
      );
      count += value;
      hash = Math.imul(hash ^ value, 16777619) >>> 0;
    }
    const expected = ref.summary.find(s => s.uid === frame.uid);
    assert.equal(count, expected.count);
    assert.equal(hash, expected.hash);
    const position = one(group.PlanePositionSequence).ImagePositionPatient.map(Number);
    position.forEach((v, i) => assert.ok(Math.abs(v - frame.position[i]) < 0.0001));
    assert.ok(!seen.has(frame.uid));
    seen.add(frame.uid);
  });
  for (const expected of ref.summary)
    if (expected.count)
      assert.ok(seen.has(expected.uid), 'A nonempty source slice is absent from SEG');
  return {
    bytes: bytes.length,
    frames: groups.length,
    nonemptySourceFrames: ref.summary.filter(s => s.count).length,
    allPixelsVerified: true,
  };
}
async function begin(page) {
  return page.evaluate(() => {
    window.__realProbe.maxGap = 0;
    window.__realProbe.last = performance.now();
    window.__realProbe.operations = [];
    return performance.now();
  });
}
async function finish(page, start) {
  return page.evaluate(
    start => ({
      elapsedMs: Math.round(performance.now() - start),
      maxMainThreadGapMs: Math.round(window.__realProbe.maxGap),
    }),
    start
  );
}
async function waitOperation(page, message) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          ['complete', 'error'].includes(window.__realProbe.operations.at(-1)?.phase)
        ),
      { timeout: 120000 }
    )
    .toBe(true);
  const last = await page.evaluate(() => window.__realProbe.operations.at(-1));
  if (last.phase === 'error') throw Error(last.message);
  assert.ok(last.message.includes(message), last.message);
}
(async () => {
  const requested = process.argv.slice(2),
    keys = requested.length ? requested : ['lung-ct', 'abdomen-ct'];
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const reports = [];
  try {
    for (const key of keys) {
      const folder = path.join(root, key),
        provenance = JSON.parse(fs.readFileSync(path.join(folder, 'provenance.json'), 'utf8'));
      console.log(key + ': building independent signed-pixel / rescale reference');
      const ref = buildReference(folder),
        timings = {},
        checks = [],
        errors = [],
        boundaries = [];
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        locale: 'zh-CN',
      });
      page.setDefaultTimeout(120000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => {
        if (m.type() === 'debug' && m.text().includes('Error Boundary')) boundaries.push(m.text());
      });
      await page.addLocatorHandler(
        page.getByRole('button', { name: 'Confirm and hide', exact: true }),
        l => l.click(),
        { times: 1 }
      );
      const report = {
        key,
        testDate,
        source: provenance.metadataUrl,
        transport: provenance.transport,
        frames: ref.frames.length,
        dimensions: [ref.frames[0].columns, ref.frames[0].rows, ref.frames.length],
        downloadBytes: provenance.bytes,
        rawIntensityRange: [ref.min, ref.max],
        threshold: [ref.lower, ref.upper],
        signed: ref.frames[0].signed,
        bitsStored: ref.frames[0].bitsStored,
        rescale: [ref.frames[0].slope, ref.frames[0].intercept],
        independentComponents: ref.regions.sizes.length,
        minimumVoxels: ref.minimumVoxels,
        timings,
        checks,
      };
      try {
        await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
        let start = Date.now();
        await page
          .locator('input[type=file]')
          .first()
          .setInputFiles(ref.frames.map(f => f.file));
        await page.waitForURL(/segmentation\/dicomlocal/);
        await page.locator('[data-cy="addSegmentation"]').click();
        timings.importMs = Date.now() - start;
        const source = await page.evaluate(() => {
          const s = window.services,
            id = s.viewportGridService.getActiveViewportId(),
            ds = s.displaySetService.getDisplaySetByUID(
              s.viewportGridService.getDisplaySetsUIDsForViewport(id)[0]
            );
          return {
            reconstructable: ds.isReconstructable,
            instances: ds.numImageFrames || ds.numInstances || ds.images?.length,
          };
        });
        report.sourceGeometry = source;
        assert.equal(
          source.reconstructable,
          true,
          'Pinned full series is unexpectedly not reconstructable'
        );
        await page.evaluate(() => {
          const { cornerstone } = window.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
            .exports.getCornerstoneLibraries();
          window.__realProbe = { maxGap: 0, last: performance.now(), operations: [] };
          setInterval(() => {
            const now = performance.now();
            window.__realProbe.maxGap = Math.max(
              window.__realProbe.maxGap,
              now - window.__realProbe.last
            );
            window.__realProbe.last = now;
          }, 20);
          cornerstone.eventTarget.addEventListener('OHIF_MASK_VOLUME_OPERATION', e =>
            window.__realProbe.operations.push(e.detail)
          );
        });
        await page.getByLabel('阈值下限', { exact: true }).fill(String(ref.lower));
        await page.getByLabel('阈值上限', { exact: true }).fill(String(ref.upper));
        const panel = page.locator('section[aria-label="Mask 编辑"]');
        start = await begin(page);
        await panel.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
        await expect(panel.getByRole('status')).toContainText('阈值选区完成', { timeout: 120000 });
        timings.threshold = await finish(page, start);
        let original = await masks(page);
        assert.deepEqual(pixelsOnly(original), ref.summary);
        checks.push(
          'every threshold voxel matches an independent interpretation of original signedness, stored bits and rescale'
        );
        report.thresholdSelected = ref.summary.reduce((s, f) => s + f.count, 0);
        await page.screenshot({ path: path.join(output, key + '-threshold.png'), fullPage: true });
        start = await begin(page);
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.ok((await masks(page)).every(f => f.count === 0));
        await panel.getByRole('button', { name: '重做', exact: true }).click();
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        timings.thresholdUndoRedo = await finish(page, start);
        checks.push('threshold undo/redo restores the complete real series');

        await page.getByRole('tab', { name: '编辑', exact: true }).click();
        await page.getByLabel('填洞处理范围').selectOption('series');
        start = await begin(page);
        await panel
          .getByRole('button', { name: 'Fill Holes 逐片填洞（整组）', exact: true })
          .click();
        await expect(panel.getByRole('status')).toContainText('逐片填洞完成', { timeout: 120000 });
        timings.fillSeries = await finish(page, start);
        report.fillAdded =
          (await masks(page)).reduce((s, f) => s + f.count, 0) - report.thresholdSelected;
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        checks.push('whole-series per-slice hole filling is reversible on the real scan');

        await page.getByRole('tab', { name: '拆分', exact: true }).click();
        if (ref.regions.sizes.length > 32) {
          await panel.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
          await expect(panel.getByRole('alert')).toContainText('超过 32', { timeout: 120000 });
          assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
          checks.push('excess real-data fragments are rejected without altering accepted labels');
        }
        if ([1, 100, 1000].includes(ref.minimumVoxels))
          await panel
            .getByRole('button', { name: '最小区域 ' + ref.minimumVoxels + ' 体素', exact: true })
            .click();
        else
          await page
            .getByLabel('拆分最小区域体素数', { exact: true })
            .fill(String(ref.minimumVoxels));
        start = await begin(page);
        await panel.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
        const preview = panel.getByRole('region', { name: '三维拆分预览', exact: true });
        await expect(preview).toBeVisible({ timeout: 120000 });
        timings.splitAnalysis = await finish(page, start);
        // Read the dedicated voxel-count table cell, independent of its volume and row label.
        const cells = await preview.locator('tbody tr td:nth-child(2)').allInnerTexts();
        const observed = cells
          .map(text => Number(text.match(/^\s*([\d,]+)/)[1].replaceAll(',', '')))
          .sort((a, b) => b - a);
        const expected = ref.regions.sizes.filter(n => n >= ref.minimumVoxels);
        assert.deepEqual(observed, expected);
        report.previewComponents = observed;
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        checks.push(
          '3D split preview component sizes match an independent raw-data flood fill and do not alter pixels'
        );
        if (expected.length > 1) {
          start = await begin(page);
          await preview.getByRole('button', { name: '应用三维拆分', exact: true }).click();
          await expect(panel.getByRole('status')).toContainText('三维拆分完成', {
            timeout: 120000,
          });
          timings.splitApply = await finish(page, start);
          const split = await masks(page);
          assert.equal(
            split.reduce(
              (s, f) =>
                s +
                Object.entries(f.counts)
                  .filter(([v]) => Number(v) > 0)
                  .reduce((a, [, n]) => a + n, 0),
              0
            ),
            report.thresholdSelected
          );
          await panel.getByRole('button', { name: '撤销', exact: true }).click();
          assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
          await panel.getByRole('button', { name: '重做', exact: true }).click();
          assert.deepEqual(await masks(page), split);
          await panel.getByRole('button', { name: '撤销', exact: true }).click();
          assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
          checks.push('3D split preserves small regions and supports exact whole-series undo/redo');
        }

        const plane = ref.frames[0].rows * ref.frames[0].columns,
          seed = ref.regions.seedIndex,
          frame = ref.frames[Math.floor(seed / plane)];
        const seedInfo = {
          uid: frame.uid,
          x: seed % ref.frames[0].columns,
          y: Math.floor(seed / ref.frames[0].columns) % ref.frames[0].rows,
        };
        const independentWorld = frame.position.map(
          (v, axis) =>
            v +
            seedInfo.x * frame.spacing[1] * frame.orientation[axis] +
            seedInfo.y * frame.spacing[0] * frame.orientation[axis + 3]
        );
        const world = await page.evaluate(seed => {
          const s = window.services,
            id = s.viewportGridService.getActiveViewportId(),
            a = s.segmentationService.getActiveSegmentation(id),
            v = s.cornerstoneViewportService.getCornerstoneViewport(id);
          const { cornerstone, cornerstoneTools } = window.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
            .exports.getCornerstoneLibraries();
          const volume = cornerstoneTools.utilities.segmentation.getOrCreateSegmentationVolume(
            a.segmentationId
          );
          const k = volume.imageIds.findIndex(id => {
            const image = cornerstone.cache.getImage(id),
              m = cornerstone.metaData.get('instance', image.referencedImageId);
            return (m.SOPInstanceUID || m.SopInstanceUID) === seed.uid;
          });
          if (k < 0) throw Error('Seed source missing');
          const w = cornerstone.utilities.transformIndexToWorld(volume.imageData, [
            seed.x,
            seed.y,
            k,
          ]);
          v.jumpToWorld(w);
          v.render();
          return w;
        }, seedInfo);
        report.seedGeometry = { worldFromDicom: independentWorld, worldFromVolume: world };
        world.forEach((v, i) =>
          assert.ok(
            Math.abs(v - independentWorld[i]) < 0.001,
            'Volume seed differs from independent DICOM patient-space geometry'
          )
        );
        await page.getByRole('tab', { name: '区域生长', exact: true }).click();
        await panel
          .getByRole('button', { name: 'Region Grow 区域生长 · 点选保留', exact: true })
          .click();
        const point = await page.evaluate(w => {
          const s = window.services,
            v = s.cornerstoneViewportService.getCornerstoneViewport(
              s.viewportGridService.getActiveViewportId()
            ),
            p = v.worldToCanvas(w),
            r = v.element.getBoundingClientRect();
          return { x: r.left + p[0], y: r.top + p[1] };
        }, world);
        start = await begin(page);
        await page.mouse.click(point.x, point.y);
        await waitOperation(page, '区域生长完成');
        timings.regionGrow = await finish(page, start);
        assert.deepEqual(pixelsOnly(await masks(page)), ref.largestSummary);
        report.regionKept = ref.regions.sizes[0];
        checks.push(
          'a real image seed keeps exactly the independent largest 3D component across all slices'
        );
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);

        start = await begin(page);
        await page.getByRole('button', { name: '三视图', exact: true }).click();
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const s = window.services;
                return s.cornerstoneViewportService
                  .getRenderingEngine()
                  .getViewports()
                  .filter(
                    v =>
                      v.type === 'orthographic' &&
                      v.getActors().some(a => a.representationUID?.includes('-Labelmap'))
                  ).length;
              }),
            { timeout: 120000 }
          )
          .toBe(3);
        timings.mpr = await finish(page, start);
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        checks.push('MPR reconstructs full source-aligned data without changing accepted labels');
        await page.getByRole('tab', { name: '编辑', exact: true }).click();
        await page.getByLabel('笔刷半径', { exact: true }).fill('8');
        await panel.getByRole('button', { name: '橡皮擦', exact: true }).click();
        await page.getByRole('tab', { name: 'Sphere', exact: true }).click();
        const brushPoint = await page.evaluate(w => {
          const s = window.services,
            v = s.cornerstoneViewportService.getCornerstoneViewport(
              s.viewportGridService.getActiveViewportId()
            );
          v.jumpToWorld(w);
          v.render();
          const p = v.worldToCanvas(w),
            r = v.element.getBoundingClientRect();
          return { x: r.left + p[0], y: r.top + p[1] };
        }, world);
        report.brushDebug = await page.evaluate(w => {
          const s = window.services,
            id = s.viewportGridService.getActiveViewportId(),
            v = s.cornerstoneViewportService.getCornerstoneViewport(id),
            a = s.segmentationService.getActiveSegmentation(id),
            group = s.toolGroupService.getToolGroupForViewport(id);
          const { cornerstone, cornerstoneTools } = window.extensionManager
            .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
            .exports.getCornerstoneLibraries();
          const volume = cornerstoneTools.utilities.segmentation.getOrCreateSegmentationVolume(
              a.segmentationId
            ),
            ijk = cornerstone.utilities.transformWorldToIndex(volume.imageData, w).map(Math.round),
            scalar = volume.voxelManager.getAtIJK(...ijk);
          return {
            activeTool: group.getActivePrimaryMouseButtonTool(),
            strategy: group.getToolConfiguration('SphereEraser').activeStrategy,
            segment: s.segmentationService.getActiveSegment(id).segmentIndex,
            scalar,
            ijk,
            origin: volume.origin,
            spacing: volume.spacing,
            camera: v.getCamera(),
            sourceVolumeId: v.getVolumeId(),
            labelmap: a.representationData.Labelmap.volumeId,
          };
        }, world);
        await page.mouse.move(brushPoint.x, brushPoint.y);
        await page.mouse.down();
        await page.mouse.move(brushPoint.x + 12, brushPoint.y, { steps: 6 });
        await page.mouse.up();
        const edited = await masks(page);
        report.brushChangedFrames = edited.filter((f, i) => f.hash !== original[i].hash).length;
        assert.ok(edited.some((f, i) => f.hash !== original[i].hash));
        await panel.getByRole('button', { name: '撤销', exact: true }).click();
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        checks.push('MPR spherical erasing changes real voxel data and undo restores it exactly');

        start = await begin(page);
        const pending = page.waitForEvent('download', { timeout: 120000 });
        await panel.getByRole('button', { name: '导出 DICOM SEG', exact: true }).click();
        const download = await pending,
          target = path.join(output, key + '-export.dcm');
        await download.saveAs(target);
        await expect(panel.getByRole('status')).toContainText('已生成整个标注集');
        timings.export = await finish(page, start);
        report.export = inspectExport(target, ref);
        checks.push(
          'the downloaded DICOM SEG matches independent raw-file masks, source UIDs and world positions for every exported voxel'
        );
        start = await begin(page);
        await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const s = window.services,
                  a = s.segmentationService.getActiveSegmentation(
                    s.viewportGridService.getActiveViewportId()
                  );
                return Boolean(a?.representationData.Surface?.geometryIds?.size);
              }),
            { timeout: 120000 }
          )
          .toBe(true);
        timings.surface = await finish(page, start);
        await page.screenshot({ path: path.join(output, key + '-four-view.png'), fullPage: true });
        assert.deepEqual(pixelsOnly(await masks(page)), ref.summary);
        checks.push('a real 3D surface is generated while complete label data remains unchanged');
        await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
        assert.deepEqual(errors, []);
        assert.deepEqual(boundaries, []);
        report.browserErrors = errors;
        report.passed = true;
      } catch (error) {
        report.passed = false;
        report.error = error.stack;
        report.browserErrors = errors;
        report.errorBoundaries = boundaries;
        report.lastOperation = await page.evaluate(() => window.__realProbe?.operations?.at(-1));
        report.feedback = await page
          .locator('section[aria-label="Mask 编辑"] [role="alert"]')
          .allTextContents();
        await page.screenshot({ path: path.join(output, key + '-failure.png'), fullPage: true });
      }
      fs.writeFileSync(path.join(output, key + '-report.json'), JSON.stringify(report, null, 2));
      reports.push(report);
      console.log(JSON.stringify(report, null, 2));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(
    path.join(output, 'real-data-report.json'),
    JSON.stringify({ testDate, reports }, null, 2)
  );
  if (reports.some(r => !r.passed)) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

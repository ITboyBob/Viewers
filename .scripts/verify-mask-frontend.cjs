const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect: baseExpect } = require('@playwright/test'),
  { unzipSync } = require('fflate');
const { buildReference } = require('./real-dicom-reference.cjs');
const expect = baseExpect.configure({ timeout: 30000 });
const root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-frontend');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], errors: [] };
const reference = buildReference(folder),
  plane = reference.frames[0].columns * reference.frames[0].rows;
const seed = reference.regions.seedIndex,
  frame = reference.frames[Math.floor(seed / plane)],
  px = seed % frame.columns,
  py = Math.floor(seed / frame.columns) % frame.rows;
const world = frame.position.map(
  (v, i) =>
    v +
    px * frame.spacing[1] * frame.orientation[i] +
    py * frame.spacing[0] * frame.orientation[i + 3]
);
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
async function maskSummary(page) {
  return page.evaluate(() => {
    const s = window.services,
      a = s.segmentationService.getActiveSegmentation(s.viewportGridService.getActiveViewportId());
    const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return t.segmentation
      .getLabelmapImageIds(a.segmentationId)
      .map(id => {
        const im = c.cache.getImage(id),
          m = c.metaData.get('instance', im.referencedImageId);
        let hash = 2166136261,
          count = 0;
        for (const value of im.getPixelData()) {
          const v = Number(value === 1);
          hash = Math.imul(hash ^ v, 16777619) >>> 0;
          count += v;
        }
        return { uid: m.SOPInstanceUID || m.SopInstanceUID, count, hash };
      })
      .sort((a, b) => a.uid.localeCompare(b.uid));
  });
}
async function frameHashes(page) {
  return page.evaluate(() => {
    const f = window.__front;
    let hashes = [],
      count = 0;
    const p = f.dims[0] * f.dims[1];
    for (let z = 0; z < f.dims[2]; z++) {
      let h = 2166136261;
      for (let i = 0; i < p; i++) {
        const v = f.volume.voxelManager.getAtIndex(z * p + i);
        h = Math.imul(h ^ v, 16777619) >>> 0;
        count += v === 1;
      }
      hashes.push(h);
    }
    return { hashes, count };
  });
}
async function apply(page) {
  await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('可整组撤销');
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  let page;
  try {
    page = await open(browser);
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await page.getByRole('button', { name: '编辑工具组：HU 生长', exact: true }).click();
    await page.getByLabel('灰度生长 HU 下限', { exact: true }).fill(String(reference.lower));
    await page.getByLabel('灰度生长 HU 上限', { exact: true }).fill(String(reference.upper));
    const initial = await maskSummary(page);
    assert.ok(initial.every(f => f.count === 0));
    await page.evaluate(async world => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
      await v.jumpToWorld(world);
      v.render();
    }, world);
    await page.getByRole('button', { name: '点选 HU 灰度生长 · 先预览', exact: true }).click();
    const canvas = await page.evaluate(world => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        r = v.element.getBoundingClientRect(),
        p = v.worldToCanvas(world);
      return [r.left + p[0], r.top + p[1]];
    }, world);
    await page.mouse.click(...canvas);
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    assert.deepEqual(await maskSummary(page), initial);
    await apply(page);
    assert.deepEqual(await maskSummary(page), reference.largestSummary);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await maskSummary(page), initial);
    report.checks.push(
      'actual CT point-picking grows from an empty Mask using raw HU; every selected voxel matches an independent raw-file six-connected component and undo restores it'
    );
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.evaluate(async world => {
      await window.commandsManager.run('previewMaskRefinement', {
        operation: 'huGrow',
        lower: 150,
        upper: 2000,
        worldPoint: world,
      });
    }, world);
    await apply(page);
    assert.deepEqual(await maskSummary(page), reference.largestSummary);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await maskSummary(page), initial);
    report.checks.push(
      'HU growth also works from MPR with the same source UID/pixel correspondence'
    );
    await page.getByRole('button', { name: '轴向优先', exact: true }).click();
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByRole('button', { name: '框选三维 ROI', exact: true }).click();
    const corners = await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        d = v.getImageData(),
        r = v.element.getBoundingClientRect();
      return [
        [d.dimensions[0] * 0.25 + 0.25, d.dimensions[1] * 0.25 + 0.25, 0],
        [d.dimensions[0] * 0.65 + 0.25, d.dimensions[1] * 0.75 + 0.25, 0],
      ].map(p => {
        const w = d.imageData.indexToWorld(p),
          c = v.worldToCanvas(w);
        return [r.left + c[0], r.top + c[1]];
      });
    });
    await page.mouse.move(...corners[0]);
    await page.mouse.down();
    await page.mouse.move(...corners[1], { steps: 10 });
    await page.mouse.up();
    await expect(page.getByLabel('ROI 起始层', { exact: true })).toHaveValue('1');
    await page.getByLabel('ROI 结束层', { exact: true }).fill('5');
    await page.getByLabel('ROI 起始层', { exact: true }).fill('2');
    const savedRoi = JSON.parse(
      await page.locator('[data-mask-roi]').getAttribute('data-mask-roi')
    );
    await expect(page.getByTestId('mask-save-state')).toContainText('未保存');
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    report.geometry = await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        dims = volume.dimensions,
        plane = dims[0] * dims[1];
      s.segmentationService.addSegment(a.segmentationId, {
        segmentIndex: 2,
        label: '原本隐藏',
        isLocked: true,
      });
      s.segmentationService.addSegment(a.segmentationId, { segmentIndex: 3, label: '原本可见' });
      s.segmentationService.setSegmentVisibilityForAllViewports(a.segmentationId, 2, false);
      s.segmentationService.setSegmentVisibilityForAllViewports(a.segmentationId, 3, true);
      s.segmentationService.setActiveSegment(a.segmentationId, 1);
      const total = plane * dims[2];
      for (let i = 0; i < total; i++) volume.voxelManager.setAtIndex(i, 0);
      for (let z = 1; z < Math.min(5, dims[2]); z++)
        for (let y = Math.floor(dims[1] * 0.4); y < dims[1] * 0.45; y++)
          for (let x = Math.floor(dims[0] * 0.45); x < dims[0] * 0.5; x++)
            volume.voxelManager.setAtIndex(x + dims[0] * (y + dims[1] * z), 1);
      volume.voxelManager.setAtIndex(0, 2);
      window.__front = { volume, dims, id: a.segmentationId };
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(a.segmentationId);
      return { dimensions: [...dims], spacing: [...volume.spacing] };
    });
    const visibility = () =>
      page.evaluate(() => {
        const s = window.services,
          id = window.__front.id,
          v = s.viewportGridService.getActiveViewportId();
        const { cornerstoneTools: t } = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries();
        return [1, 2, 3].map(i =>
          t.segmentation.config.visibility.getSegmentIndexVisibility(
            v,
            { segmentationId: id, type: 'Labelmap' },
            i
          )
        );
      });
    const originalVisibility = await visibility();
    await page.getByRole('button', { name: '只显示当前 Mask', exact: true }).click();
    assert.deepEqual(await visibility(), [true, false, false]);
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    assert.deepEqual(await visibility(), [true, false, false]);
    await page.getByRole('button', { name: '恢复之前显隐', exact: true }).click();
    assert.deepEqual(await visibility(), originalVisibility);
    report.checks.push(
      'isolate-current-Mask survives layout changes; restoring keeps previously hidden Masks hidden rather than forcing all visible'
    );
    const before = await frameHashes(page);
    await page.getByLabel('精修仅处理 ROI', { exact: true }).check();
    await page.getByRole('button', { name: '编辑工具组：形态学', exact: true }).click();
    await page.getByLabel('形态学半径 mm', { exact: true }).fill('3');
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toContainText(
      '仅 ROI'
    );
    assert.deepEqual(await frameHashes(page), before);
    await page.evaluate(() => {
      const f = window.__front,
        total = f.dims.reduce((a, b) => a * b, 1);
      f.before = Uint8Array.from({ length: total }, (_, i) => f.volume.voxelManager.getAtIndex(i));
    });
    await apply(page);
    const outside = await page.evaluate(roi => {
      const f = window.__front,
        d = f.dims;
      let bad = 0,
        added = 0;
      for (let i = 0; i < f.before.length; i++) {
        const now = f.volume.voxelManager.getAtIndex(i),
          world = f.volume.imageData.indexToWorld([
            i % d[0],
            Math.floor(i / d[0]) % d[1],
            Math.floor(i / (d[0] * d[1])),
          ]);
        const inside = roi.axes.every((axis, k) => {
          const dot = axis.reduce((sum, v, j) => sum + v * world[j], 0);
          return dot >= roi.min[k] - 1e-4 && dot <= roi.max[k] + 1e-4;
        });
        if (!inside && now !== f.before[i]) bad++;
        if (now === 1 && f.before[i] === 0) added++;
      }
      return { bad, added };
    }, savedRoi);
    assert.equal(outside.bad, 0);
    assert.ok(outside.added > 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await frameHashes(page), before);
    report.checks.push(
      'ROI-limited morphology changes only inside the saved patient-space box; outside labels and other Masks survive; whole-series undo restores all data'
    );
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存标注文件', exact: true }).click();
    const filename = path.join(output, key + '.ohifmask');
    await (await download).saveAs(filename);
    const archive = unzipSync(fs.readFileSync(filename)),
      manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'));
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.roi, savedRoi);
    const fresh = await open(browser, [...files].reverse());
    await fresh.getByLabel('载入本地标注文件', { exact: true }).setInputFiles(filename);
    await expect(fresh.getByRole('status')).toContainText('已载入');
    assert.deepEqual(
      JSON.parse(await fresh.locator('[data-mask-roi]').getAttribute('data-mask-roi')),
      savedRoi
    );
    await expect(fresh.getByLabel('ROI 起始层', { exact: true })).toHaveValue('2');
    await expect(fresh.getByLabel('ROI 结束层', { exact: true })).toHaveValue('5');
    report.checks.push(
      'version-2 project files restore the exact ROI and layer controls in a fresh context after reversed original DICOM import'
    );
    await fresh.getByLabel('ROI 结束层', { exact: true }).fill('6');
    await expect(fresh.getByTestId('mask-save-state')).toContainText('未保存');
    const draftRoi = JSON.parse(
      await fresh.locator('[data-mask-roi]').getAttribute('data-mask-roi')
    );
    await expect(fresh.getByLabel('标注保存状态')).toContainText('最近本地暂存', {
      timeout: 20000,
    });
    await expect(
      fresh.getByRole('button', { name: '恢复本地暂存为新标注集', exact: true })
    ).toBeEnabled({ timeout: 20000 });
    fresh.once('dialog', dialog => dialog.accept());
    await fresh.reload({ waitUntil: 'networkidle' });
    await fresh.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
    await fresh
      .locator('input[type=file]')
      .first()
      .setInputFiles([...files].reverse());
    await fresh.waitForURL(/segmentation\/dicomlocal/);
    await fresh.getByRole('button', { name: '恢复本地暂存为新标注集', exact: true }).click();
    await expect(fresh.getByRole('status')).toContainText('已载入');
    await expect(fresh.getByLabel('ROI 结束层', { exact: true })).toHaveValue('6');
    assert.deepEqual(
      JSON.parse(await fresh.locator('[data-mask-roi]').getAttribute('data-mask-roi')),
      draftRoi
    );
    report.checks.push(
      'ROI-only edits trigger unsaved state and automatic local backup; actual refresh and draft recovery restore the changed ROI'
    );
    // Controlled identical keyframes make the expected interpolation independent of distance-transform details.
    await page.getByLabel('精修仅处理 ROI', { exact: true }).uncheck();
    await page.evaluate(() => {
      const f = window.__front,
        s = window.services,
        t = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries().cornerstoneTools,
        d = f.dims,
        p = d[0] * d[1];
      for (let i = 0; i < f.before.length; i++) f.volume.voxelManager.setAtIndex(i, 0);
      const x = Math.floor(d[0] / 2),
        y = Math.floor(d[1] / 2);
      for (const z of [0, 4])
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            f.volume.voxelManager.setAtIndex(x + dx + d[0] * (y + dy + d[1] * z), 1);
      f.volume.voxelManager.setAtIndex(x + d[0] * (y + d[1] * 2), 2);
      f.volume.voxelManager.setAtIndex(2 * p, 1);
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(f.id);
      f.interpolationBefore = Uint8Array.from({ length: f.before.length }, (_, i) =>
        f.volume.voxelManager.getAtIndex(i)
      );
    });
    await page.getByRole('button', { name: '编辑工具组：插值', exact: true }).click();
    await page.getByLabel('插值起始关键层', { exact: true }).fill('1');
    await page.getByLabel('插值结束关键层', { exact: true }).fill('5');
    await page.getByRole('button', { name: '预览关键层插值', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toContainText(
      '关键层插值'
    );
    await apply(page);
    const interpolation = await page.evaluate(() => {
      const f = window.__front,
        d = f.dims,
        p = d[0] * d[1];
      let bad = 0;
      for (let z = 0; z < d[2]; z++)
        for (let y = 0; y < d[1]; y++)
          for (let x = 0; x < d[0]; x++) {
            const i = x + d[0] * (y + d[1] * z),
              v = f.volume.voxelManager.getAtIndex(i);
            let expected = f.interpolationBefore[i];
            if (z === 1 || z === 3)
              expected =
                Math.abs(x - Math.floor(d[0] / 2)) <= 2 && Math.abs(y - Math.floor(d[1] / 2)) <= 2
                  ? 1
                  : 0;
            if (v !== expected) bad++;
          }
      return bad;
    });
    assert.equal(interpolation, 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(
      await page.evaluate(() => {
        const f = window.__front;
        return f.interpolationBefore.every((v, i) => v === f.volume.voxelManager.getAtIndex(i));
      }),
      true
    );
    report.checks.push(
      'keyframe interpolation fills identical contours, preserves endpoint and already annotated middle slices, protects other Masks, and undoes losslessly'
    );
    await page.getByRole('button', { name: '编辑工具组：布尔', exact: true }).click();
    await page.getByRole('button', { name: '复制当前 Mask 为独立副本', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('独立 Mask 副本');
    await page.evaluate(() => {
      const s = window.services,
        f = window.__front,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      if (a.segmentationId === f.id) throw Error('copy reused original collection');
      const target = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        total = f.dims.reduce((a, b) => a * b, 1);
      f.cloneId = a.segmentationId;
      f.cloneVolume = target;
      f.cloneBefore = new Uint8Array(total);
      for (let i = 0; i < total; i++) {
        const expected = f.interpolationBefore[i] === 1 ? 1 : 0;
        if (
          target.voxelManager.getAtIndex(i) !== expected ||
          f.volume.voxelManager.getAtIndex(i) !== f.interpolationBefore[i]
        )
          throw Error('clone changed source or copied another Mask');
        f.cloneBefore[i] = expected;
      }
      // An independent B overlaps part of A and extends to the right; original source data is controlled fixture data.
      for (let i = 0; i < total; i++)
        if (f.volume.voxelManager.getAtIndex(i) === 1) f.volume.voxelManager.setAtIndex(i, 0);
      const d = f.dims,
        x = Math.floor(d[0] / 2) + 2,
        y = Math.floor(d[1] / 2);
      for (const z of [0, 4])
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            f.volume.voxelManager.setAtIndex(x + dx + d[0] * (y + dy + d[1] * z), 1);
      f.booleanSource = Uint8Array.from({ length: total }, (_, i) =>
        f.volume.voxelManager.getAtIndex(i)
      );
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(f.id);
    });
    const operand = await page.evaluate(() => JSON.stringify([window.__front.id, 1]));
    await page.getByLabel('布尔运算源 Mask', { exact: true }).selectOption(operand);
    for (const operation of ['union', 'intersection', 'difference']) {
      await page.getByLabel('Mask 布尔运算', { exact: true }).selectOption(operation);
      await page.getByRole('button', { name: '预览 Mask 布尔运算', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toContainText(
        '布尔运算'
      );
      assert.equal(
        await page.evaluate(() => {
          const f = window.__front;
          return f.cloneBefore.every((v, i) => v === f.cloneVolume.voxelManager.getAtIndex(i));
        }),
        true
      );
      await apply(page);
      const result = await page.evaluate(operation => {
        const f = window.__front;
        let mismatch = 0,
          overlap = 0;
        for (let i = 0; i < f.cloneBefore.length; i++) {
          const a = f.cloneBefore[i] === 1,
            b = f.booleanSource[i] === 1,
            expected =
              operation === 'union' ? a || b : operation === 'intersection' ? a && b : a && !b;
          if (f.cloneVolume.voxelManager.getAtIndex(i) !== Number(expected)) mismatch++;
          if (a && b) overlap++;
          if (f.volume.voxelManager.getAtIndex(i) !== f.booleanSource[i])
            throw Error('boolean mutated the operand');
        }
        return { mismatch, overlap };
      }, operation);
      assert.equal(result.mismatch, 0);
      assert.ok(result.overlap > 0);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      assert.equal(
        await page.evaluate(() => {
          const f = window.__front;
          return f.cloneBefore.every((v, i) => v === f.cloneVolume.voxelManager.getAtIndex(i));
        }),
        true
      );
    }
    report.checks.push(
      'independent Mask copies overlap without sharing pixels; union/intersection/difference match voxel truth tables, preserve the operand and support whole-series undo'
    );
    await page.getByRole('button', { name: '预览 Mask 布尔运算', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    await page.evaluate(() => window.__front.volume.voxelManager.setAtIndex(0, 1));
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('源 Mask 已变化');
    assert.equal(
      await page.evaluate(() => {
        const f = window.__front;
        f.volume.voxelManager.setAtIndex(0, f.booleanSource[0]);
        return f.cloneBefore.every((v, i) => v === f.cloneVolume.voxelManager.getAtIndex(i));
      }),
      true
    );
    await page.evaluate(() => {
      const s = window.services,
        f = window.__front,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        d = f.dims;
      v.jumpToWorld(f.cloneVolume.imageData.indexToWorld([d[0] / 2, d[1] / 2, 2]));
      v.render();
      const camera = v.getCamera();
      f.cut = { point: [...camera.focalPoint], normal: [...camera.viewPlaneNormal] };
    });
    await page.getByRole('button', { name: '编辑工具组：切面', exact: true }).click();
    await page.getByRole('button', { name: '预览三维切面裁剪', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toContainText(
      '切面裁剪'
    );
    await apply(page);
    assert.equal(
      await page.evaluate(() => {
        const f = window.__front,
          d = f.dims;
        let bad = 0;
        for (let i = 0; i < f.cloneBefore.length; i++) {
          const w = f.cloneVolume.imageData.indexToWorld([
            i % d[0],
            Math.floor(i / d[0]) % d[1],
            Math.floor(i / (d[0] * d[1])),
          ]);
          const value = w.reduce((sum, v, k) => sum + (v - f.cut.point[k]) * f.cut.normal[k], 0),
            expected = f.cloneBefore[i] === 1 && value >= -1e-6 ? 1 : 0;
          if (f.cloneVolume.voxelManager.getAtIndex(i) !== expected) bad++;
        }
        return bad;
      }),
      0
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(
      await page.evaluate(() => {
        const f = window.__front;
        return f.cloneBefore.every((v, i) => v === f.cloneVolume.voxelManager.getAtIndex(i));
      }),
      true
    );
    report.checks.push(
      'changing a Boolean operand invalidates its old preview; current-view 3D plane clipping matches independent patient-coordinate half-space checks and is undoable'
    );
    await page.screenshot({ path: path.join(output, key + '-complete.png'), fullPage: true });
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    report.failurePage = await page
      ?.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(-3500) }))
      .catch(() => undefined);
    if (page)
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

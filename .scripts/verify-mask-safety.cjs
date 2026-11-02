const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-safety');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], errors: [] };
async function setup(page) {
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    l => l.click(),
    { times: 1 }
  );
  await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').first().setInputFiles(files);
  await page.waitForURL(/segmentation\/dicomlocal/);
  await expect(page.getByRole('button', { name: '载入标注文件', exact: true })).toBeEnabled();
}
async function snapshot(page) {
  return page.evaluate(() => {
    const s = window.services,
      id = s.segmentationService.getActiveSegmentation(
        s.viewportGridService.getActiveViewportId()
      ).segmentationId;
    const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const current = s.segmentationService.getSegmentation(id);
    return {
      label: current.label,
      segments: Object.values(current.segments).map(v => ({
        index: v.segmentIndex,
        label: v.label,
        locked: v.locked,
      })),
      frames: t.segmentation
        .getLabelmapImageIds(id)
        .map(imageId => {
          const image = c.cache.getImage(imageId),
            instance = c.metaData.get('instance', image.referencedImageId);
          let hash = 2166136261,
            count = 0;
          for (const value of image.getPixelData()) {
            hash = Math.imul(hash ^ value, 16777619) >>> 0;
            count += value === 1;
          }
          return { uid: instance.SOPInstanceUID || instance.SopInstanceUID, hash, count };
        })
        .sort((a, b) => a.uid.localeCompare(b.uid)),
    };
  });
}
async function apply(page) {
  const button = page.getByRole('button', { name: '应用阈值到整组切片', exact: true });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('完成');
}
async function previewCount(page) {
  return page.locator('[data-mask-threshold-preview]').getAttribute('data-candidates');
}
async function draw(page, full = false) {
  await page.getByRole('button', { name: '框选三维 ROI', exact: true }).click();
  const points = await page.evaluate(full => {
    const s = window.services,
      viewport = s.cornerstoneViewportService.getCornerstoneViewport(
        s.viewportGridService.getActiveViewportId()
      );
    const { cornerstone: c } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const d = viewport.getImageData(),
      w = d.dimensions[0],
      h = d.dimensions[1],
      r = viewport.element.getBoundingClientRect();
    return [
      [full ? w * 0.05 + 0.25 : w * 0.1 + 0.25, full ? h * 0.05 + 0.25 : h * 0.1 + 0.25, 0],
      [full ? w * 0.95 + 0.25 : w * 0.48 + 0.25, full ? h * 0.95 + 0.25 : h * 0.9 + 0.25, 0],
    ].map(p => {
      const world = c.utilities.transformIndexToWorld(d.imageData, p),
        canvas = viewport.worldToCanvas(world);
      return { world, canvas: [r.left + canvas[0], r.top + canvas[1]] };
    });
  }, full);
  await page.mouse.move(...points[0].canvas);
  await page.mouse.down();
  await page.mouse.move(...points[1].canvas, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByLabel('ROI 起始层', { exact: true })).toBeVisible();
  await expect(page.getByLabel('ROI 起始层', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('ROI 结束层', { exact: true })).toHaveValue(String(files.length));
  const end = Math.min(files.length, 6);
  await page.getByLabel('ROI 结束层', { exact: true }).fill(String(end));
  await page.getByLabel('ROI 起始层', { exact: true }).fill('3');
  await expect(page.getByLabel('ROI 起始层', { exact: true })).toHaveValue('3');
  return { points, start: 3, end };
}
async function verifyRoiClear(page, drawn) {
  return page.evaluate(({ points, start, end }) => {
    const s = window.services,
      v = s.viewportGridService.getActiveViewportId(),
      a = s.segmentationService.getActiveSegmentation(v);
    const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const frames = t.segmentation.getLabelmapImageIds(a.segmentationId).map(id => {
      const image = c.cache.getImage(id),
        reference = c.cache.getImage(image.referencedImageId),
        m = c.metaData.get('instance', image.referencedImageId);
      return { image, reference, m };
    });
    const o = frames[0].m.ImageOrientationPatient.map(Number),
      axes = [
        o.slice(0, 3),
        o.slice(3),
        [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]],
      ];
    const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
    const positions = frames
      .map(f => dot(axes[2], f.m.ImagePositionPatient.map(Number)))
      .sort((a, b) => a - b);
    let outside = 0,
      removed = 0;
    for (const f of frames) {
      const labels = f.image.getPixelData(),
        raw = f.reference.getPixelData(),
        m = f.m;
      const location = m.ImagePositionPatient.map(Number),
        spacing = m.PixelSpacing.map(Number);
      for (let i = 0; i < labels.length; i++) {
        const x = i % f.image.columns,
          y = Math.floor(i / f.image.columns);
        const world = location.map((v, k) => v + x * spacing[1] * o[k] + y * spacing[0] * o[k + 3]);
        const insideXY = axes.slice(0, 2).every(axis => {
          const v = dot(axis, world),
            a = dot(axis, points[0].world),
            b = dot(axis, points[1].world);
          return v >= Math.min(a, b) - 1e-4 && v <= Math.max(a, b) + 1e-4;
        });
        const z = dot(axes[2], world),
          inside = insideXY && z >= positions[start - 1] - 1e-4 && z <= positions[end - 1] + 1e-4;
        const hu =
          f.reference.isPreScaled || f.reference.preScale?.scaled
            ? raw[i]
            : raw[i] * (f.reference.slope ?? 1) + (f.reference.intercept ?? 0);
        const was = hu >= 150 && hu <= 2000 ? 1 : 0,
          expected = inside ? 0 : was;
        if (labels[i] !== expected)
          return { failure: { uid: m.SOPInstanceUID, index: i, got: labels[i], expected, inside } };
        if (was && inside) removed++;
        if (was && !inside) outside++;
      }
    }
    return { removed, outside };
  }, drawn);
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
  try {
    await setup(page);
    await page.locator('[data-cy="addSegmentation"]').click();
    await expect(page.getByTestId('mask-save-state')).toContainText('未保存');
    const empty = await snapshot(page);
    await page.getByLabel('阈值实时预览', { exact: true }).check();
    await expect.poll(() => previewCount(page)).not.toBe('0');
    await page.getByLabel('阈值下限', { exact: true }).fill('5000');
    await page.getByLabel('阈值上限', { exact: true }).fill('6000');
    await expect.poll(() => previewCount(page)).toBe('0');
    assert.deepEqual(await snapshot(page), empty);
    await page.getByLabel('阈值下限', { exact: true }).fill('150');
    await page.getByLabel('阈值上限', { exact: true }).fill('2000');
    await expect.poll(async () => Number(await previewCount(page))).toBeGreaterThan(0);
    const candidate = await previewCount(page);
    await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
      v.setProperties({ voiRange: { lower: -100, upper: 100 } });
      v.render();
    });
    await expect.poll(() => previewCount(page)).toBe(candidate);
    assert.deepEqual(await snapshot(page), empty);
    report.checks.push(
      'threshold preview responds to HU changes, ignores window settings and never changes accepted labels'
    );
    await apply(page);
    const full = await snapshot(page);
    assert.ok(full.frames.some(f => f.count > 0));
    const drawn = await draw(page);
    await page.getByLabel('阈值下限', { exact: true }).fill('5000');
    await page.getByLabel('阈值上限', { exact: true }).fill('6000');
    await apply(page);
    const roiCheck = await verifyRoiClear(page, drawn);
    assert.equal(roiCheck.failure, undefined, JSON.stringify(roiCheck));
    assert.ok(roiCheck.removed > 0 && roiCheck.outside > 0);
    report.roi = roiCheck;
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), full);
    report.checks.push(
      'drawn 3D ROI + slice limits clear only eligible voxels inside the ROI; all outside voxels survive; one undo restores everything'
    );
    await draw(page, true);
    const grow = await page.evaluate(async () => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId(),
        a = s.segmentationService.getActiveSegmentation(v);
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const volume = t.utilities.segmentation.getOrCreateSegmentationVolume(a.segmentationId),
        dims = volume.dimensions,
        plane = dims[0] * dims[1];
      const before = new Uint8Array(plane * dims[2]);
      for (let i = 0; i < before.length; i++) before[i] = volume.voxelManager.getAtIndex(i);
      const allowed = new Uint8Array(before.length),
        queue = new Uint32Array(before.length),
        seen = new Uint8Array(before.length);
      // These samples are axial; use each source frame's world position to choose layers 3–6.
      const frameIds = t.segmentation.getLabelmapImageIds(a.segmentationId),
        frames = frameIds.map(id => c.cache.getImage(id));
      const zPositions = frames
        .map(f => Number(c.metaData.get('instance', f.referencedImageId).ImagePositionPatient[2]))
        .sort((a, b) => a - b);
      const zMin = zPositions[2],
        zMax = zPositions[Math.min(5, zPositions.length - 1)];
      const actualRoi = JSON.parse(document.querySelector('[data-mask-roi]').dataset.maskRoi);
      let seed = -1;
      for (let z = 0; z < dims[2]; z++)
        for (let y = 0; y < dims[1]; y++)
          for (let x = 0; x < dims[0]; x++) {
            const i = x + dims[0] * (y + dims[1] * z),
              world = c.utilities.transformIndexToWorld(volume.imageData, [x, y, z]);
            if (
              actualRoi.axes.every((axis, k) => {
                const distance = axis.reduce((sum, value, j) => sum + value * world[j], 0);
                return distance >= actualRoi.min[k] - 1e-4 && distance <= actualRoi.max[k] + 1e-4;
              })
            ) {
              allowed[i] = 1;
              if (seed < 0 && before[i] === 1) seed = i;
            }
          }
      if (seed < 0) throw Error('no seed in test ROI');
      let head = 0,
        tail = 1;
      queue[0] = seed;
      seen[seed] = 1;
      while (head < tail) {
        const i = queue[head++],
          x = i % dims[0],
          y = Math.floor(i / dims[0]) % dims[1],
          z = Math.floor(i / plane);
        for (const n of [
          x > 0 ? i - 1 : -1,
          x + 1 < dims[0] ? i + 1 : -1,
          y > 0 ? i - dims[0] : -1,
          y + 1 < dims[1] ? i + dims[0] : -1,
          z > 0 ? i - plane : -1,
          z + 1 < dims[2] ? i + plane : -1,
        ])
          if (n >= 0 && allowed[n] && before[n] === 1 && !seen[n]) {
            seen[n] = 1;
            queue[tail++] = n;
          }
      }
      const world = c.utilities.transformIndexToWorld(volume.imageData, [
        seed % dims[0],
        Math.floor(seed / dims[0]) % dims[1],
        Math.floor(seed / plane),
      ]);
      await window.commandsManager.run('growMaskFromSeed', { worldPoint: world });
      let removed = 0,
        outside = 0;
      for (let i = 0; i < before.length; i++) {
        const expected = allowed[i] && before[i] === 1 && !seen[i] ? 0 : before[i];
        if (volume.voxelManager.getAtIndex(i) !== expected)
          return {
            failure: {
              index: i,
              expected,
              got: volume.voxelManager.getAtIndex(i),
              actualRoi,
              zMin,
              zMax,
              seed,
            },
          };
        removed += before[i] === 1 && expected === 0;
        outside += !allowed[i] && before[i] === 1;
      }
      return { removed, outside };
    });
    assert.equal(grow.failure, undefined, JSON.stringify(grow));
    assert.ok(grow.removed > 0 && grow.outside > 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), full);
    report.checks.push(
      'ROI region grow matches an independent 6-neighbor BFS and preserves all voxels outside ROI'
    );
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect(page.getByLabel('ROI 起始层', { exact: true })).toHaveValue('3');
    await page.evaluate(() => {
      const s = window.services,
        id = s.viewportGridService.getActiveViewportId(),
        v = s.cornerstoneViewportService.getCornerstoneViewport(id);
      const { cornerstone: c } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const d = s.displaySetService.getDisplaySetByUID(
        s.viewportGridService.getDisplaySetsUIDsForViewport(id)[0]
      );
      const m = d.imageIds
        .map(imageId => c.metaData.get('instance', imageId))
        .sort((a, b) => Number(a.ImagePositionPatient[2]) - Number(b.ImagePositionPatient[2]))[3];
      const o = m.ImageOrientationPatient.map(Number),
        p = m.ImagePositionPatient.map(Number),
        spacing = m.PixelSpacing.map(Number);
      v.jumpToWorld(
        p.map(
          (value, k) =>
            value +
            Number(m.Columns) * 0.5 * spacing[1] * o[k] +
            Number(m.Rows) * 0.5 * spacing[0] * o[k + 3]
        )
      );
      v.render();
    });
    await page.getByLabel('阈值处理范围', { exact: true }).selectOption('slice');
    await page.getByRole('button', { name: '应用阈值到当前切片', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('完成');
    const mprEdit = await snapshot(page);
    assert.equal(mprEdit.frames.filter((frame, i) => frame.hash !== full.frames[i].hash).length, 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), full);
    report.checks.push(
      'ROI survives the MPR layout change; single-plane ROI threshold edits exactly one source slice and is undoable'
    );
    await page.getByLabel('阈值下限', { exact: true }).fill('150');
    await page.getByLabel('阈值上限', { exact: true }).fill('2000');
    await page.getByLabel('阈值实时预览', { exact: true }).check();
    await expect
      .poll(async () => Number(await previewCount(page)), { timeout: 30000 })
      .toBeGreaterThan(0);
    assert.deepEqual(await snapshot(page), full);
    report.checks.push('read-only threshold preview also works on MPR');
    await page.getByLabel('阈值实时预览', { exact: true }).uncheck();
    await page.getByRole('button', { name: '清除 ROI 限制', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存标注文件', exact: true }).click();
    await (await pending).saveAs(path.join(output, key + '.ohifmask'));
    await expect(page.getByTestId('mask-save-state')).toContainText('已保存', { timeout: 15000 });
    await page.getByRole('button', { name: '轴向优先', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已切换到轴向视图');
    await page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await expect(page.getByTestId('mask-save-state')).toContainText('已保存', { timeout: 15000 });
    assert.equal(
      await page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
      false
    );
    const previousDraftTime = await page
      .getByLabel('标注保存状态')
      .getByText(/^最近本地暂存：/)
      .textContent();
    await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      s.segmentationService.setSegmentLabel(a.segmentationId, 1, '暂存恢复测试');
    });
    await expect(page.getByTestId('mask-save-state')).toContainText('未保存');
    await expect(page.getByLabel('标注保存状态')).toContainText('最近本地暂存', { timeout: 20000 });
    await expect(page.getByLabel('标注保存状态').getByText(/^最近本地暂存：/)).not.toHaveText(
      previousDraftTime,
      { timeout: 20000 }
    );
    await expect(page.getByLabel('选择本地暂存')).toContainText('标注集', { timeout: 20000 });
    const backed = await snapshot(page);
    assert.equal(
      await page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
      true
    );
    report.checks.push(
      'manual save clears unsaved warning; later metadata edits trigger a local draft and keep close/refresh protection'
    );
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      window.__restoreDraftPut = () => {
        IDBObjectStore.prototype.put = original;
      };
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'files') throw new DOMException('simulated quota', 'QuotaExceededError');
        return original.apply(this, args);
      };
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      s.segmentationService.setSegmentLabel(a.segmentationId, 1, '暂存失败后的修改');
    });
    await expect(page.getByLabel('标注保存状态')).toContainText('暂存失败', { timeout: 20000 });
    await page.evaluate(() => window.__restoreDraftPut());
    report.checks.push(
      'quota failure is handled without a runtime error and preserves the previous successful draft atomically'
    );
    let warned = false;
    page.once('dialog', async dialog => {
      warned = dialog.type() === 'beforeunload';
      await dialog.accept();
    });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(warned, true);
    await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles([...files].reverse());
    await page.waitForURL(/segmentation\/dicomlocal/);
    await expect(
      page.getByRole('button', { name: '恢复本地暂存为新标注集', exact: true })
    ).toBeEnabled({ timeout: 20000 });
    await page.getByRole('button', { name: '恢复本地暂存为新标注集', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已载入');
    assert.deepEqual(await snapshot(page), backed);
    await expect(page.getByTestId('mask-save-state')).toContainText('未保存');
    report.checks.push(
      'actual refresh prompts once; reimport + draft recovery restores the last successful pixels and metadata, rather than the failed snapshot'
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
    await page.screenshot({ path: path.join(output, key + '-restored.png'), fullPage: true });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    report.debug = await page
      .evaluate(() => {
        const s = window.services,
          v = s.cornerstoneViewportService.getCornerstoneViewport(
            s.viewportGridService.getActiveViewportId()
          );
        const { cornerstone: c } = window.extensionManager
          .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
          .exports.getCornerstoneLibraries();
        const d = v.getImageData(),
          r = v.element.getBoundingClientRect(),
          image = c.cache.getImage(v.getCurrentImageId?.());
        return {
          body: document.body.innerText.slice(-1800),
          dimensions: d?.dimensions,
          origin: d?.origin,
          direction: d?.direction,
          spacing: d?.spacing,
          center: v.canvasToWorld([r.width / 2, r.height / 2]),
          index: c.utilities.transformWorldToIndex(
            d.imageData,
            v.canvasToWorld([r.width / 2, r.height / 2])
          ),
          data: image && {
            slope: image.slope,
            intercept: image.intercept,
            isPreScaled: image.isPreScaled,
            preScale: image.preScale,
            min: Math.min(...image.getPixelData()),
            max: Math.max(...image.getPixelData()),
          },
        };
      })
      .catch(() => undefined);
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

const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { unzipSync, zipSync } = require('fflate');
const root = path.resolve(__dirname, '..');
const key = process.argv[2] || 'synthetic';
const folder =
  key === 'synthetic' ? path.join(root, 'demo-data') : path.join(root, '.cache/real-dicom', key);
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-project');
fs.mkdirSync(output, { recursive: true });
const errors = [],
  checks = [];
async function open(browser, inputs = files) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'debug' && m.text().includes('Error Boundary')) errors.push(m.text());
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
async function currentId(page) {
  return page.evaluate(
    () =>
      window.services.segmentationService.getActiveSegmentation(
        window.services.viewportGridService.getActiveViewportId()
      )?.segmentationId
  );
}
async function snapshot(page, id) {
  return page.evaluate(
    id => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId();
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const a = s.segmentationService.getSegmentation(id);
      return {
        frames: t.segmentation
          .getLabelmapImageIds(id)
          .map(imageId => {
            const image = c.cache.getImage(imageId),
              instance = c.metaData.get('instance', image.referencedImageId);
            let hash = 2166136261,
              nonzero = 0;
            for (const value of image.getPixelData()) {
              hash = Math.imul(hash ^ value, 16777619) >>> 0;
              nonzero += value !== 0;
            }
            return { uid: instance.SOPInstanceUID || instance.SopInstanceUID, hash, nonzero };
          })
          .sort((a, b) => a.uid.localeCompare(b.uid)),
        active: Object.values(a.segments).find(segment => segment.active)?.segmentIndex ?? null,
        segments: Object.values(a.segments)
          .map(segment => {
            const style = s.segmentationService.getStyle({
              viewportId: v,
              segmentationId: id,
              segmentIndex: segment.segmentIndex,
              type: 'Labelmap',
            });
            return {
              index: segment.segmentIndex,
              label: segment.label,
              color: [...s.segmentationService.getSegmentColor(v, id, segment.segmentIndex)],
              visible: t.segmentation.config.visibility.getSegmentIndexVisibility(
                v,
                { segmentationId: id, type: 'Labelmap' },
                segment.segmentIndex
              ),
              locked: t.segmentation.segmentLocking.isSegmentIndexLocked(id, segment.segmentIndex),
              style: {
                fillAlpha: style.fillAlpha,
                outlineWidth: style.outlineWidth,
                renderFill: style.renderFill,
                renderOutline: style.renderOutline,
              },
            };
          })
          .sort((a, b) => a.index - b.index),
      };
    },
    id || (await currentId(page))
  );
}
async function save(page, filename) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存标注文件', exact: true }).click();
  await (await download).saveAs(filename);
}
async function load(page, filename) {
  await page.getByLabel('载入本地标注文件', { exact: true }).setInputFiles(filename);
  await expect(page.getByRole('status')).toContainText('已载入', { timeout: 120000 });
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const started = Date.now(),
    report = { key, checks, errors };
  try {
    const page = await open(browser);
    await page.locator('[data-cy="addSegmentation"]').click();
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeEnabled();
    await expect(page.getByRole('status')).toContainText('完成');
    if (key === 'synthetic') {
      await page.getByRole('tab', { name: '拆分', exact: true }).click();
      await page.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
      await page.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    }
    const id = await currentId(page);
    await page.evaluate(id => {
      const s = window.services,
        service = s.segmentationService;
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      service.addSegment(id, { segmentIndex: 5, label: '主骨组织' });
      // Sparse indices test: the restored set must remove the generated default Mask 1.
      for (const imageId of t.segmentation.getLabelmapImageIds(id)) {
        const image = c.cache.getImage(imageId),
          pixels = image.getPixelData();
        for (let i = 0; i < pixels.length; i++)
          if (pixels[i] === 1) image.voxelManager.setAtIndex(i, 5);
      }
      service.removeSegment(id, 1);
      if (!service.getSegmentation(id).segments[2])
        service.addSegment(id, { segmentIndex: 2, label: '待标注区域' });
      service.addSegment(id, { segmentIndex: 7, label: '空 Mask 占位' });
      for (const [index, color] of [
        [5, [255, 25, 60, 255]],
        [2, [20, 80, 255, 255]],
        [7, [80, 200, 40, 255]],
      ]) {
        service.setSegmentColorForAllViewports(id, index, color);
        service.setSegmentVisibilityForAllViewports(id, index, index !== 2);
        service.setSegmentLocked(id, index, index === 2);
        window.commandsManager.run('setMaskAppearance', {
          segmentationId: id,
          segmentIndex: index,
          style: {
            fillAlpha: index === 5 ? 0.23 : 0.7,
            outlineWidth: index === 5 ? 4.5 : 2,
            renderFill: index !== 2,
            renderOutline: index === 2,
          },
        });
      }
      service.setActiveSegment(id, 5);
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(id);
    }, id);
    const expected = await snapshot(page, id);
    assert.ok(expected.frames.some(f => f.nonzero > 0));
    const file = path.join(output, key + '.ohifmask');
    await save(page, file);
    report.frames = files.length;
    report.fileBytes = fs.statSync(file).size;
    const manifest = JSON.parse(
      Buffer.from(unzipSync(fs.readFileSync(file))['manifest.json']).toString()
    );
    assert.equal(manifest.segments.length, 3);
    checks.push(
      'save all slices, sparse Mask indices, empty Mask, exact colors, hidden/locked state and independent styles'
    );
    console.log(key + ': saved ' + report.fileBytes + ' bytes');
    // Fresh context has fresh wadouri IDs; reverse file input order as well.
    const fresh = await open(browser, [...files].reverse());
    assert.equal(await currentId(fresh), undefined);
    await load(fresh, file);
    const restoredId = await currentId(fresh);
    assert.deepEqual(await snapshot(fresh), expected);
    checks.push(
      'fresh browser context + reversed import order restores every slice hash and all editing state'
    );
    await fresh.evaluate(async () => {
      await window.commandsManager.run('thresholdMaskSeries', {
        lower: 3000,
        upper: 3001,
        replace: true,
      });
    });
    assert.notDeepEqual((await snapshot(fresh)).frames, expected.frames);
    await fresh.evaluate(() => window.commandsManager.run('undo'));
    assert.deepEqual(await snapshot(fresh), expected);
    checks.push('restored Mask can be edited across the series and undone losslessly');
    // Failed validation must neither change pixels nor create another set.
    const broken = unzipSync(fs.readFileSync(file));
    broken['labels.bin'][0] = broken['labels.bin'][0] === 0 ? 5 : 0;
    const badFile = path.join(output, key + '-corrupt.ohifmask');
    fs.writeFileSync(badFile, zipSync(broken));
    await fresh.getByLabel('载入本地标注文件').setInputFiles(badFile);
    await expect(fresh.getByRole('alert')).toContainText('校验失败');
    assert.deepEqual(await snapshot(fresh), expected);
    assert.equal(
      await fresh.evaluate(() => window.services.segmentationService.getSegmentations().length),
      1
    );
    checks.push('corrupted file is rejected without changing the existing set');
    await fresh.evaluate(() => {
      const service = window.services.segmentationService,
        original = service.setSegmentLocked;
      service.setSegmentLocked = function (...args) {
        service.setSegmentLocked = original;
        throw new Error('模拟恢复失败');
      };
    });
    await fresh.getByLabel('载入本地标注文件').setInputFiles(file);
    await expect(fresh.getByRole('alert')).toContainText('模拟恢复失败');
    assert.deepEqual(await snapshot(fresh), expected);
    assert.equal(
      await fresh.evaluate(() => window.services.segmentationService.getSegmentations().length),
      1
    );
    checks.push(
      'failure after pixel restoration rolls back the new collection and preserves original pixels, metadata and selection'
    );
    await fresh.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(
        () =>
          fresh.evaluate(
            () =>
              window.services.cornerstoneViewportService.getRenderingEngine().getViewports().length
          ),
        { timeout: 30000 }
      )
      .toBe(3);
    const mprFile = path.join(output, key + '-mpr.ohifmask');
    await save(fresh, mprFile);
    await load(fresh, mprFile);
    const second = await currentId(fresh);
    assert.notEqual(second, restoredId);
    assert.deepEqual(await snapshot(fresh), expected);
    assert.deepEqual((await snapshot(fresh, restoredId)).frames, expected.frames);
    checks.push('MPR save/load creates a separate editable set and preserves the previous set');
    const wrong = await open(
      browser,
      fs
        .readdirSync(
          path.join(root, key === 'synthetic' ? '.cache/real-dicom/abdomen-ct' : 'demo-data')
        )
        .filter(f => f.endsWith('.dcm'))
        .map(f =>
          path.join(root, key === 'synthetic' ? '.cache/real-dicom/abdomen-ct' : 'demo-data', f)
        )
    );
    await wrong.getByLabel('载入本地标注文件').setInputFiles(file);
    await expect(wrong.getByRole('alert')).toContainText('不匹配');
    assert.equal(
      await wrong.evaluate(() => window.services.segmentationService.getSegmentations().length),
      0
    );
    checks.push('wrong original series is rejected before any new segmentation is created');
    // A collection with no Masks is a valid work checkpoint too.
    await page.evaluate(id => {
      const service = window.services.segmentationService;
      Object.keys(service.getSegmentation(id).segments).forEach(index =>
        service.removeSegment(id, Number(index))
      );
    }, id);
    const emptyFile = path.join(output, key + '-empty.ohifmask');
    await save(page, emptyFile);
    const emptyPage = await open(browser);
    await load(emptyPage, emptyFile);
    const empty = await snapshot(emptyPage);
    assert.deepEqual(empty.segments, []);
    assert.equal(empty.active, null);
    assert.ok(empty.frames.every(frame => frame.nonzero === 0));
    checks.push(
      'empty collection roundtrip preserves zero Masks without leaving an invented default Mask'
    );
    assert.deepEqual(errors, []);
    await fresh.screenshot({ path: path.join(output, key + '-restored.png'), fullPage: true });
    report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, key + '-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});

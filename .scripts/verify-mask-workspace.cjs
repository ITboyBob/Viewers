const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect: baseExpect } = require('@playwright/test'),
  { unzipSync, zipSync } = require('fflate');
const expect = baseExpect.configure({ timeout: 30000 }),
  root = path.resolve(__dirname, '..'),
  key = process.argv[2] || 'synthetic';
const folder = path.join(root, key === 'synthetic' ? 'demo-data' : '.cache/real-dicom/' + key),
  files = fs
    .readdirSync(folder)
    .filter(f => f.endsWith('.dcm'))
    .map(f => path.join(folder, f));
const output = path.join(root, '.cache/mask-workspace');
fs.mkdirSync(output, { recursive: true });
const report = { key, checks: [], errors: [], consoleErrors: [] };
async function open(browser, inputs = files) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' });
  page.setDefaultTimeout(120000);
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().startsWith('Warning:')) {
      report.consoleErrors.push(m.text());
      console.log('[browsererror] ' + m.text().slice(0, 800));
    }
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
  await expect(page.getByRole('button', { name: '载入整个项目', exact: true })).toBeEnabled();
  return page;
}
async function snapshot(page) {
  return page.evaluate(() => {
    const s = window.services,
      v = s.viewportGridService.getActiveViewportId(),
      active = s.segmentationService.getActiveSegmentation(v)?.segmentationId;
    const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    return {
      active: s.segmentationService.getSegmentation(active)?.label,
      collections: s.segmentationService
        .getSegmentations()
        .map(item => {
          const viewport = s.segmentationService.getViewportIdsWithSegmentation(
            item.segmentationId
          )[0];
          return {
            label: item.label,
            collectionVisible:
              t.segmentation.config.visibility.getSegmentationRepresentationVisibility(viewport, {
                segmentationId: item.segmentationId,
                type: 'Labelmap',
              }),
            segments: Object.values(item.segments).map(segment => {
              const style = s.segmentationService.getStyle({
                viewportId: viewport,
                segmentationId: item.segmentationId,
                segmentIndex: segment.segmentIndex,
                type: 'Labelmap',
              });
              return {
                index: segment.segmentIndex,
                label: segment.label,
                active: segment.active,
                locked: segment.locked,
                color: [
                  ...s.segmentationService.getSegmentColor(
                    viewport,
                    item.segmentationId,
                    segment.segmentIndex
                  ),
                ],
                visible: t.segmentation.config.visibility.getSegmentIndexVisibility(
                  viewport,
                  { segmentationId: item.segmentationId, type: 'Labelmap' },
                  segment.segmentIndex
                ),
                style: {
                  fillAlpha: style.fillAlpha,
                  outlineWidth: style.outlineWidth,
                  renderFill: style.renderFill,
                  renderOutline: style.renderOutline,
                },
              };
            }),
            frames: t.segmentation
              .getLabelmapImageIds(item.segmentationId)
              .map(id => {
                const image = c.cache.getImage(id),
                  m = c.metaData.get('instance', image.referencedImageId);
                let hash = 2166136261,
                  count = 0;
                for (const value of image.getPixelData()) {
                  hash = Math.imul(hash ^ value, 16777619) >>> 0;
                  count += value > 0;
                }
                return { uid: m.SOPInstanceUID || m.SopInstanceUID, hash, count };
              })
              .sort((a, b) => a.uid.localeCompare(b.uid)),
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  });
}
async function historyTitles(page) {
  return page.getByTestId('mask-history-entries').locator('li strong').allTextContents();
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
    await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeEnabled();
    await expect(page.getByTestId('next-undo')).toContainText('整组阈值');
    await page.locator('summary').filter({ hasText: '操作历史（' }).click();
    assert.deepEqual(await historyTitles(page), ['整组阈值']);
    await expect(page.getByTestId('mask-history-entries')).toContainText('下限 HU：150');
    await expect(page.getByTestId('mask-history-entries')).toContainText('更改');
    await page.getByRole('tab', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('三维形态学操作', { exact: true })).toBeVisible();
    await expect(page.getByLabel('灰度生长 HU 下限', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: '编辑工具组：HU 生长', exact: true }).click();
    await expect(page.getByLabel('灰度生长 HU 下限', { exact: true })).toBeVisible();
    await expect(page.getByLabel('三维形态学操作', { exact: true })).toBeHidden();
    await page.getByRole('button', { name: '编辑工具组：形态学', exact: true }).click();
    await page.getByLabel('形态学半径 mm', { exact: true }).fill('1.1');
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    assert.deepEqual(await historyTitles(page), ['整组阈值']);
    await page.getByRole('button', { name: '应用精修结果', exact: true }).click();
    await expect(page.getByTestId('next-undo')).toContainText('三维膨胀');
    assert.deepEqual(await historyTitles(page), ['三维膨胀', '整组阈值']);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByTestId('mask-history-entries').locator('li').first()).toHaveAttribute(
      'data-state',
      'undone'
    );
    await expect(page.getByTestId('next-undo')).toContainText('整组阈值');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByTestId('next-undo')).toContainText('三维膨胀');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    // Replace the undone branch with a different actual edit; the old redo entry must disappear.
    await page.evaluate(async () =>
      window.commandsManager.run('thresholdMaskSeries', { lower: 5000, upper: 6000, replace: true })
    );
    assert.deepEqual(await historyTitles(page), ['整组阈值', '整组阈值']);
    await expect(page.getByLabel('编辑历史')).not.toContainText('三维膨胀');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    report.checks.push(
      'group navigation shows one tool family at a time; history matches actual threshold/morphology edits, preview exclusion, undo/redo and discarded branches'
    );
    const beforeBrush = await snapshot(page);
    const brushPoint = await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        a = s.segmentationService.getActiveSegmentation(v.id);
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const source = v.getCurrentImageId(),
        image = t.segmentation
          .getLabelmapImageIds(a.segmentationId)
          .map(id => c.cache.getImage(id))
          .find(item => item.referencedImageId === source);
      const labels = image.getPixelData(),
        r = v.element.getBoundingClientRect(),
        d = v.getImageData();
      for (let i = 0; i < labels.length; i++)
        if (labels[i] === 1) {
          const point = v.worldToCanvas(
            d.imageData.indexToWorld([i % image.columns, Math.floor(i / image.columns), 0])
          );
          if (point[0] > 25 && point[1] > 25 && point[0] < r.width - 25 && point[1] < r.height - 25)
            return [r.left + point[0], r.top + point[1]];
        }
      throw Error('test has no visible paint target');
    });
    await page.getByRole('button', { name: '橡皮擦', exact: true }).click();
    await page.mouse.move(brushPoint[0] - 6, brushPoint[1]);
    await page.mouse.down();
    await page.mouse.move(brushPoint[0] + 6, brushPoint[1], { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('next-undo')).toContainText('橡皮擦');
    await expect(page.getByTestId('next-undo')).toContainText(beforeBrush.active);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), beforeBrush);
    report.checks.push(
      'a genuine native eraser stroke appears in the same history with its real target and can be undone without desynchronizing the list'
    );
    await page.getByRole('tab', { name: '阈值', exact: true }).click();
    await page.getByRole('button', { name: '框选三维 ROI', exact: true }).click();
    const points = await page.evaluate(() => {
      const s = window.services,
        v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        ),
        d = v.getImageData(),
        r = v.element.getBoundingClientRect();
      return [
        [d.dimensions[0] * 0.2, d.dimensions[1] * 0.2, 0],
        [d.dimensions[0] * 0.7, d.dimensions[1] * 0.8, 0],
      ].map(p => {
        const q = v.worldToCanvas(d.imageData.indexToWorld(p));
        return [r.left + q[0], r.top + q[1]];
      });
    });
    await page.mouse.move(...points[0]);
    await page.mouse.down();
    await page.mouse.move(...points[1], { steps: 8 });
    await page.mouse.up();
    await expect(page.getByLabel('ROI 起始层', { exact: true })).toBeVisible();
    await page.getByLabel('ROI 结束层', { exact: true }).fill('5');
    await page.getByLabel('ROI 起始层', { exact: true }).fill('2');
    const roi = JSON.parse(await page.locator('[data-mask-roi]').getAttribute('data-mask-roi'));
    await page.evaluate(async () => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId(),
        a = s.segmentationService.getActiveSegmentation(v);
      const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      s.segmentationService.addSegment(a.segmentationId, {
        segmentIndex: 4,
        label: '空 Mask 占位',
        isLocked: true,
      });
      s.segmentationService.setSegmentColorForAllViewports(a.segmentationId, 1, [255, 30, 80, 255]);
      s.segmentationService.setSegmentVisibilityForAllViewports(a.segmentationId, 4, false);
      s.segmentationService.setActiveSegment(a.segmentationId, 1);
      const copy = await window.commandsManager.run('createLabelmapForViewport', {
        viewportId: v,
        options: { label: '独立重叠骨组织', createInitialSegment: true },
      });
      const originals = new Map(
        t.segmentation.getLabelmapImageIds(a.segmentationId).map(id => {
          const image = c.cache.getImage(id);
          return [
            c.metaData.get('instance', image.referencedImageId).SOPInstanceUID ||
              c.metaData.get('instance', image.referencedImageId).SopInstanceUID,
            image,
          ];
        })
      );
      for (const id of t.segmentation.getLabelmapImageIds(copy)) {
        const image = c.cache.getImage(id),
          m = c.metaData.get('instance', image.referencedImageId),
          source = originals.get(m.SOPInstanceUID || m.SopInstanceUID).getPixelData();
        for (let i = 0; i < source.length; i++)
          if (source[i] === 1) image.voxelManager.setAtIndex(i, 1);
      }
      s.segmentationService.setSegmentColorForAllViewports(copy, 1, [30, 120, 255, 255]);
      s.segmentationService.setStyle(
        { type: 'Labelmap', segmentationId: copy, segmentIndex: 1 },
        {
          fillAlpha: 0.23,
          fillAlphaInactive: 0.23,
          outlineWidth: 5,
          outlineWidthInactive: 5,
          renderFill: true,
          renderFillInactive: true,
          renderOutline: true,
          renderOutlineInactive: true,
        }
      );
      s.segmentationService.setSegmentLocked(copy, 1, true);
      s.segmentationService.setCollectionVisibilityForAllViewports(copy, false);
      t.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(copy);
      const empty = await window.commandsManager.run('createLabelmapForViewport', {
        viewportId: v,
        options: { label: '空标注集占位', createInitialSegment: true },
      });
      s.segmentationService.removeSegment(empty, 1);
      s.segmentationService.setCollectionVisibilityForAllViewports(empty, false);
      s.segmentationService.setActiveSegmentation(v, copy);
      window.__workspaceActive = copy;
    });
    const expected = await snapshot(page);
    assert.equal(expected.collections.length, 3);
    assert.ok(expected.collections.some(item => item.segments.length === 0));
    const historyBefore = await historyTitles(page),
      pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存整个项目', exact: true }).click();
    const filename = path.join(output, key + '.ohifproject');
    await (await pending).saveAs(filename);
    assert.deepEqual(await historyTitles(page), historyBefore);
    await expect(page.getByTestId('mask-save-state')).toContainText('已保存');
    const archive = unzipSync(fs.readFileSync(filename)),
      manifest = JSON.parse(Buffer.from(archive['workspace.json']).toString());
    assert.equal(manifest.collections.length, 3);
    assert.deepEqual(manifest.roi, roi);
    report.fileBytes = fs.statSync(filename).size;
    report.checks.push(
      'one project file includes three collections with overlapping pixels, empty Mask/collection, colors, locks, per-Mask styles, ROI and selected collection; saving adds no undo record'
    );
    await page.close();
    page = await open(browser, [...files].reverse());
    await page.evaluate(async () => {
      const s = window.services;
      await window.commandsManager.run('createLabelmapForViewport', {
        viewportId: s.viewportGridService.getActiveViewportId(),
        options: { label: '先前标注', createInitialSegment: true },
      });
    });
    const sentinel = await snapshot(page);
    await page.getByLabel('载入完整项目文件', { exact: true }).setInputFiles(filename);
    await expect(page.getByRole('status')).toContainText('已恢复整个项目');
    let restored = await snapshot(page);
    assert.equal(restored.collections.length, 4);
    assert.deepEqual(
      restored.collections.filter(item => item.label !== '先前标注'),
      expected.collections
    );
    assert.equal(restored.active, expected.active);
    assert.deepEqual(
      restored.collections.find(item => item.label === '先前标注'),
      sentinel.collections[0]
    );
    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    assert.deepEqual((await snapshot(page)).collections, restored.collections);
    assert.equal((await snapshot(page)).active, expected.active);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.services,
            v = s.viewportGridService.getActiveViewportId(),
            active = s.segmentationService.getActiveSegmentation(v);
          const actor = s.cornerstoneViewportService
            .getCornerstoneViewport(v)
            .getActors()
            .find(item =>
              item.representationUID?.startsWith(active.segmentationId + '-Labelmap')
            )?.actor;
          return actor?.getVisibility();
        })
      )
      .toBe(false);
    await page.evaluate(() => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId(),
        a = s.segmentationService.getActiveSegmentation(v);
      s.segmentationService.setCollectionVisibilityForAllViewports(a.segmentationId, true);
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.services,
            v = s.viewportGridService.getActiveViewportId(),
            a = s.segmentationService.getActiveSegmentation(v);
          return s.cornerstoneViewportService
            .getCornerstoneViewport(v)
            .getActors()
            .find(item => item.representationUID?.startsWith(a.segmentationId + '-Labelmap'))
            ?.actor.getVisibility();
        })
      )
      .toBe(true);
    await page.evaluate(() => {
      const s = window.services,
        v = s.viewportGridService.getActiveViewportId(),
        a = s.segmentationService.getActiveSegmentation(v);
      s.segmentationService.setCollectionVisibilityForAllViewports(a.segmentationId, false);
    });
    if (key === 'synthetic') {
      await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const s = window.services,
                a = s.segmentationService
                  .getSegmentations()
                  .find(item => item.label === '独立重叠骨组织'),
                view = s.cornerstoneViewportService
                  .getRenderingEngine()
                  .getViewports()
                  .find(item => item.type === 'volume3d');
              return view
                ?.getActors()
                .find(item => item.representationUID?.startsWith(a.segmentationId + '-Surface-'))
                ?.actor.getVisibility();
            }),
          { timeout: 60000 }
        )
        .toBe(false);
      await page.getByRole('button', { name: '三视图', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
        )
        .toBe(3);
      report.checks.push(
        'collection master visibility reaches the actual MPR and 3D actors without changing per-Mask visibility preferences'
      );
    }
    assert.deepEqual(
      JSON.parse(await page.locator('[data-mask-roi]').getAttribute('data-mask-roi')),
      roi
    );
    await expect(page.getByTestId('next-undo')).toContainText('无');
    report.checks.push(
      'fresh-context reversed source import restores every source-frame hash and Mask state, selected collection and ROI while preserving an existing collection'
    );
    // Inject a failure in the second restored collection: all earlier newly created sets must roll back too.
    const before = await snapshot(page);
    await page.evaluate(() => {
      const service = window.services.segmentationService,
        original = service.setSegmentLocked;
      let calls = 0;
      service.setSegmentLocked = function (...args) {
        if (++calls === 3) {
          service.setSegmentLocked = original;
          throw Error('模拟第二标注集恢复失败');
        }
        return original.apply(this, args);
      };
    });
    await page.getByLabel('载入完整项目文件', { exact: true }).setInputFiles(filename);
    await expect(page.getByRole('alert')).toContainText('模拟第二标注集恢复失败');
    assert.deepEqual(await snapshot(page), before);
    assert.deepEqual(
      JSON.parse(await page.locator('[data-mask-roi]').getAttribute('data-mask-roi')),
      roi
    );
    report.checks.push(
      'failure after restoring one collection rolls back all collections from the failed import and preserves old pixels, metadata, ROI and selection'
    );
    const broken = unzipSync(fs.readFileSync(filename));
    broken['collections/set-000.ohifmask'][20] ^= 1;
    const bad = path.join(output, key + '-corrupt.ohifproject');
    fs.writeFileSync(bad, zipSync(broken));
    await page.getByLabel('载入完整项目文件', { exact: true }).setInputFiles(bad);
    await expect(page.getByRole('alert')).toContainText('校验失败');
    assert.deepEqual(await snapshot(page), before);
    report.checks.push(
      'corrupted nested collection data is rejected before any annotation is created'
    );
    await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      s.segmentationService.setSegmentLocked(a.segmentationId, 1, false);
    });
    const editable = await snapshot(page);
    await page.evaluate(async () =>
      window.commandsManager.run('thresholdMaskSeries', { lower: 5000, upper: 6000, replace: true })
    );
    await expect(page.getByTestId('next-undo')).toContainText('整组阈值');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.deepEqual(await snapshot(page), editable);
    report.checks.push(
      'the restored project remains editable; new whole-series edits enter the actual history and undo restores all previous collections'
    );
    await page.screenshot({ path: path.join(output, key + '-restored.png'), fullPage: true });
    await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      s.segmentationService.removeSegment(a.segmentationId, 1);
    });
    const deletedTarget = await snapshot(page);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('已被删除');
    assert.deepEqual(await snapshot(page), deletedTarget);
    report.checks.push(
      'deleted history targets produce an actionable message instead of writing orphan labels or causing a runtime error'
    );
    await page.close();
    const wrongFolder = path.join(
      root,
      key === 'synthetic' ? '.cache/real-dicom/abdomen-ct' : 'demo-data'
    );
    const wrongFiles = fs
      .readdirSync(wrongFolder)
      .filter(file => file.endsWith('.dcm'))
      .map(file => path.join(wrongFolder, file));
    page = await open(browser, wrongFiles);
    await page.getByLabel('载入完整项目文件', { exact: true }).setInputFiles(filename);
    await expect(page.getByRole('alert')).toContainText('不匹配');
    assert.equal((await snapshot(page)).collections.length, 0);
    report.checks.push(
      'a complete project from another original DICOM series is rejected without creating partial collections'
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.consoleErrors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    report.rendering = await page
      ?.evaluate(() => {
        const s = window.services;
        return {
          active: s.viewportGridService.getActiveViewportId(),
          grid: [...s.viewportGridService.getState().viewports.keys()],
          views: s.cornerstoneViewportService
            .getRenderingEngine()
            .getViewports()
            .map(v => ({
              id: v.id,
              type: v.type,
              width: v.element.offsetWidth,
              active: s.segmentationService.getActiveSegmentation(v.id)?.segmentationId,
              actors: v
                .getActors()
                .map(a => ({
                  uid: a.uid,
                  representationUID: a.representationUID,
                  visible: a.actor.getVisibility(),
                })),
            })),
        };
      })
      .catch(() => undefined);
    if (page && !page.isClosed()) {
      report.body = await page
        .locator('body')
        .innerText()
        .catch(() => undefined);
      await page.screenshot({ path: path.join(output, key + '-failure.png'), fullPage: true });
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, key + '-report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

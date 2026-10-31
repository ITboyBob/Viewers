const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dcmjs = require('dcmjs');
const dicomParser = require('dicom-parser');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve(__dirname, '../.cache/mask-ui');
fs.mkdirSync(output, { recursive: true });
const one = value => (Array.isArray(value) ? value[0] : value);
const list = value => (Array.isArray(value) ? value : [value]);

async function snapshot(page) {
  return page.evaluate(() => {
    const s = window.services;
    const active = s.segmentationService.getActiveSegmentation(
      s.viewportGridService.getActiveViewportId()
    );
    const { cornerstone, cornerstoneTools } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    const labelIds = cornerstoneTools.segmentation.getLabelmapImageIds(active.segmentationId);
    return {
      frames: labelIds
        .map(id => {
          const image = cornerstone.cache.getImage(id);
          const instance = cornerstone.metaData.get('instance', image.referencedImageId);
          return {
            uid: instance.SOPInstanceUID || instance.SopInstanceUID,
            pixels: Array.from(image.getPixelData()),
            position: Array.from(instance.ImagePositionPatient),
          };
        })
        .sort((a, b) => a.uid.localeCompare(b.uid)),
      segments: Object.values(active.segments).map(segment => ({
        index: segment.segmentIndex,
        label: segment.label,
      })),
      study: cornerstone.metaData.get(
        'instance',
        cornerstone.cache.getImage(labelIds[0]).referencedImageId
      ).StudyInstanceUID,
    };
  });
}

function inspect(file, expected) {
  const bytes = fs.readFileSync(file);
  const raw = dcmjs.data.DicomMessage.readFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  );
  const data = dcmjs.data.DicomMetaDictionary.naturalizeDataset(raw.dict);
  const parsed = dicomParser.parseDicom(new Uint8Array(bytes));
  assert.equal(parsed.string('x00080005').trim(), 'ISO_IR 192');
  assert.equal(data.Modality, 'SEG');
  assert.equal(data.StudyInstanceUID, expected.study);
  assert.equal(data.SegmentationType, 'BINARY');
  assert.equal(data.SpecificCharacterSet, 'ISO_IR 192');
  const sequence = list(data.SegmentSequence);
  assert.equal(
    sequence.length,
    expected.segments.filter(segment =>
      expected.frames.some(frame => frame.pixels.includes(segment.index))
    ).length
  );
  const bySegment = new Map(sequence.map(s => [Number(s.SegmentNumber), s]));
  // dcmjs 0.43 resets its decoder for nested sequence items. Read the raw item text independently
  // using the declared UTF-8 character set, so export validation does not inherit that reader bug.
  const labels = new Map(
    parsed.elements.x00620002.items.map(item => {
      const dataset = item.dataSet,
        field = dataset.elements.x00620005;
      const label = new TextDecoder('utf-8', { fatal: true })
        .decode(dataset.byteArray.subarray(field.dataOffset, field.dataOffset + field.length))
        .trim();
      return [dataset.uint16('x00620004'), label];
    })
  );
  for (const segment of expected.segments) {
    if (expected.frames.some(frame => frame.pixels.includes(segment.index)))
      assert.equal(labels.get(segment.index), segment.label);
  }
  const plane = Number(data.Rows) * Number(data.Columns);
  const unpacked = dcmjs.data.BitArray.unpack(one(data.PixelData));
  const functional = list(data.PerFrameFunctionalGroupsSequence);
  assert.equal(functional.length, Number(data.NumberOfFrames));
  const seen = new Set();
  for (let frameIndex = 0; frameIndex < functional.length; frameIndex++) {
    const group = functional[frameIndex];
    const segment = Number(one(group.SegmentIdentificationSequence).ReferencedSegmentNumber);
    const source = one(one(group.DerivationImageSequence).SourceImageSequence);
    const original = expected.frames.find(frame => frame.uid === source.ReferencedSOPInstanceUID);
    assert.ok(
      original,
      `Export references a source SOP absent from the selected series: ${source.ReferencedSOPInstanceUID}`
    );
    assert.equal(original.pixels.length, plane);
    const position = one(group.PlanePositionSequence).ImagePositionPatient.map(Number);
    position.forEach((value, i) => assert.ok(Math.abs(value - original.position[i]) < 0.0001));
    for (let i = 0; i < plane; i++)
      assert.equal(
        unpacked[frameIndex * plane + i] > 0,
        original.pixels[i] === segment,
        `Pixel differs for source ${original.uid}, segment ${segment}, index ${i}`
      );
    const key = `${original.uid}:${segment}`;
    assert.ok(!seen.has(key), 'A source/segment frame was exported twice');
    seen.add(key);
  }
  for (const frame of expected.frames)
    for (const segment of expected.segments)
      if (frame.pixels.includes(segment.index))
        assert.ok(seen.has(`${frame.uid}:${segment.index}`));
  assert.ok(!bySegment.has(255), 'A temporary preview segment leaked into the file');
  return { frames: functional.length, segments: sequence.length, bytes: bytes.length };
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
    const panel = page.locator('section[aria-label="Mask 编辑"]');
    const exportButton = panel.getByRole('button', { name: '导出 DICOM SEG', exact: true });
    await exportButton.click();
    await expect(panel.getByRole('alert')).toContainText('没有选区');
    assert.deepEqual(errors, []);
    checks.push('an empty Mask reports a useful export error without a runtime overlay');

    await panel.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('阈值选区完成');
    await page.getByRole('tab', { name: '拆分', exact: true }).click();
    await panel.getByRole('button', { name: 'Split Mask 三维预览', exact: true }).click();
    await panel.getByRole('button', { name: '应用三维拆分', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('三维拆分完成');
    await page
      .locator('[data-cy="data-row"]')
      .nth(1)
      .getByRole('button', { name: '隐藏', exact: true })
      .click();
    await page
      .locator('[data-cy="data-row"]')
      .nth(1)
      .getByRole('button', { name: '操作', exact: true })
      .click();
    await page.locator('[data-cy="LockToggle"]').click();
    // Give each source slice a distinct marker so incorrect frame ordering cannot pass by symmetry.
    await page.evaluate(() => {
      const s = window.services,
        active = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      const { cornerstone, cornerstoneTools } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      cornerstoneTools.segmentation
        .getLabelmapImageIds(active.segmentationId)
        .forEach((id, index) => cornerstone.cache.getImage(id).voxelManager.setAtIndex(index, 1));
      cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
        active.segmentationId
      );
      s.segmentationService.setSegmentLabel(active.segmentationId, 1, '左侧骨组织');
      s.segmentationService.setSegmentLabel(active.segmentationId, 2, '右侧骨组织');
      s.segmentationService.addSegment(active.segmentationId, {
        segmentIndex: 5,
        label: '空白待标注',
      });
      s.segmentationService.setActiveSegment(active.segmentationId, 1);
    });
    const original = await snapshot(page);
    const download = async name => {
      const pending = page.waitForEvent('download');
      await exportButton.click();
      const result = await pending;
      const target = path.join(output, name);
      await result.saveAs(target);
      await expect(panel.getByRole('status')).toContainText('已生成整个标注集');
      return inspect(target, original);
    };
    const stack = await download('export-stack.dcm');
    assert.deepEqual(await snapshot(page), original);
    checks.push(
      'stack export includes every nonempty mask and source slice, including a hidden and locked mask'
    );

    await page.getByRole('button', { name: '三视图', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.services.viewportGridService.getState().viewports.size)
      )
      .toBe(3);
    await page.evaluate(() => {
      const s = window.services;
      const active = s.segmentationService.getActiveSegmentation(
        s.viewportGridService.getActiveViewportId()
      );
      if (!active.representationData.Labelmap.volumeId)
        throw Error('Fixture did not acquire a volume');
      window.__exportLabelmapFields = {
        imageIds: active.representationData.Labelmap.imageIds,
        referencedImageIds: active.representationData.Labelmap.referencedImageIds,
      };
      delete active.representationData.Labelmap.imageIds;
      delete active.representationData.Labelmap.referencedImageIds;
    });
    const mpr = await download('export-mpr-volume-only.dcm');
    assert.deepEqual(await snapshot(page), original);
    checks.push('a volume-only MPR labelmap exports without depending on a legacy imageIds field');
    await page.evaluate(() => {
      const s = window.services,
        a = s.segmentationService.getActiveSegmentation(
          s.viewportGridService.getActiveViewportId()
        );
      Object.assign(a.representationData.Labelmap, window.__exportLabelmapFields);
    });

    // A real uncommitted preview must be rejected before taking the export snapshot.
    const hover = await page.evaluate(() => {
      const s = window.services,
        id = s.viewportGridService.getActiveViewportId();
      const v = s.cornerstoneViewportService.getCornerstoneViewport(id),
        group = s.toolGroupService.getToolGroupForViewport(id);
      group.setToolConfiguration('CircularBrush', { brushSize: 3, preview: { enabled: true } });
      window.commandsManager.run('setToolActiveToolbar', { toolName: 'CircularBrush' });
      const { cornerstone } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      const world = cornerstone.utilities.transformIndexToWorld(
        v.getImageData().imageData,
        [62, 64, 3]
      );
      const canvas = v.worldToCanvas(world),
        rect = v.element.getBoundingClientRect();
      return { x: rect.left + canvas[0], y: rect.top + canvas[1] };
    });
    await page.mouse.move(hover.x, hover.y);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.services;
          return s.toolGroupService
            .getToolGroupForViewport(s.viewportGridService.getActiveViewportId())
            .getToolInstance('CircularBrush')
            .hasPreviewData();
        })
      )
      .toBe(true);
    const preview = await download('export-after-preview.dcm');
    assert.deepEqual(await snapshot(page), original);
    checks.push('export rejects a live brush preview and preserves all previously accepted pixels');

    await page.getByRole('button', { name: '三视图 + 3D', exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.services;
            return s.cornerstoneViewportService
              .getRenderingEngine()
              .getViewports()
              .some(
                v =>
                  v.type === 'volume3d' &&
                  v.getActors().some(a => a.representationUID?.includes('-Surface-'))
              );
          }),
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
    await expect(exportButton).toBeEnabled();
    const surface = await download('export-from-3d.dcm');
    assert.deepEqual(await snapshot(page), original);
    checks.push(
      'export remains available from the 3D preview and still contains full source-aligned masks'
    );
    const menuDownload = page.waitForEvent('download');
    await page.locator('.mask-manager button[aria-haspopup="menu"]').first().click();
    await page.getByRole('menuitem', { name: '下载与导出', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'DICOM SEG', exact: true }).first().click();
    const fromMenu = await menuDownload;
    const menuPath = path.join(output, 'export-from-menu.dcm');
    await fromMenu.saveAs(menuPath);
    const menu = inspect(menuPath, original);
    checks.push('the original Mask-list download menu shares the same validated export path');
    await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
    assert.deepEqual(errors, []);
    const report = {
      checks,
      exports: { stack, mpr, preview, surface, menu },
      browserErrors: errors,
    };
    fs.writeFileSync(path.join(output, 'export-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'export-failure.png'), fullPage: true });
    fs.writeFileSync(
      path.join(output, 'export-failure.json'),
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

const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..'),
  output = path.join(root, '.cache/refinement-cancel');
fs.mkdirSync(output, { recursive: true });
const folder = path.join(root, '.cache/real-dicom/abdomen-ct');
const files = fs
  .readdirSync(folder)
  .filter(f => f.endsWith('.dcm'))
  .map(f => path.join(folder, f));
const report = { checks: [], errors: [], dataset: 'abdomen-ct', frames: files.length };
async function snapshot(page) {
  return page.evaluate(() => {
    const s = window.services,
      a = s.segmentationService.getActiveSegmentation(s.viewportGridService.getActiveViewportId());
    const { cornerstone: c, cornerstoneTools: t } = window.extensionManager
      .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
      .exports.getCornerstoneLibraries();
    let count = 0;
    const hashes = t.segmentation.getLabelmapImageIds(a.segmentationId).map(imageId => {
      let hash = 2166136261;
      for (const value of c.cache.getImage(imageId).getPixelData()) {
        hash = Math.imul(hash ^ value, 16777619) >>> 0;
        count += value === 1;
      }
      return hash;
    });
    return {
      count,
      hashes,
      segments: Object.values(a.segments).map(segment => ({
        index: segment.segmentIndex,
        label: segment.label,
        locked: segment.locked,
      })),
    };
  });
}
async function startHeavy(page) {
  await page.evaluate(() => {
    window.__refinementTasks = [];
  });
  await page.getByLabel('三维形态学操作', { exact: true }).selectOption('smooth');
  await page.getByLabel('形态学半径 mm', { exact: true }).fill('2');
  await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '精修整体进度' })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__refinementTasks.some(
            task => task.phase === 'running' && task.stage === 'compute' && task.percent > 20
          )
        ),
      { timeout: 30000 }
    )
    .toBe(true);
  return page.evaluate(() => window.__refinementTasks[0].id);
}
(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, locale: 'zh-CN' });
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'debug' && message.text().includes('Error Boundary'))
      report.errors.push(message.text());
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
    await page.evaluate(() => {
      const { cornerstone: c } = window.extensionManager
        .getModuleEntry('@ohif/extension-cornerstone.utilityModule.common')
        .exports.getCornerstoneLibraries();
      window.__refinementTasks = [];
      c.eventTarget.addEventListener('OHIF_MASK_REFINEMENT_TASK', event => {
        const task = event.detail;
        window.__refinementTasks.push(task);
        if (
          window.__cancelRefinementAtStart &&
          task.phase === 'running' &&
          task.stage === 'prepare'
        ) {
          window.__cancelRefinementAtStart = false;
          window.commandsManager.run('cancelMaskRefinementCalculation', { taskId: task.id });
        }
        if (
          window.__cancelRefinementAtCompletion &&
          task.phase === 'running' &&
          task.percent === 100
        ) {
          window.__cancelRefinementAtCompletion = false;
          window.commandsManager.run('cancelMaskRefinementCalculation', { taskId: task.id });
        }
      });
    });
    const baseline = await snapshot(page),
      firstId = await startHeavy(page);
    await expect(page.getByRole('progressbar', { name: '精修整体进度' }).locator('div')).toHaveCSS(
      'background-color',
      'rgb(34, 211, 238)'
    );
    await page.screenshot({ path: path.join(output, 'progress.png'), fullPage: true });
    const start = Date.now();
    await page.getByRole('button', { name: '取消精修计算', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已取消精修计算');
    await expect(page.getByRole('progressbar', { name: '精修整体进度' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toHaveCount(0);
    assert.deepEqual(await snapshot(page), baseline);
    report.cancelMs = Date.now() - start;
    report.checks.push(
      'a real worker calculation reports progress and can be cancelled through the UI without changing pixels or Mask metadata'
    );
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal((await snapshot(page)).count, 0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.deepEqual(await snapshot(page), baseline);
    report.checks.push(
      'cancelling creates no undo item: one undo still reverts the preceding whole-series threshold, and redo restores it'
    );
    await page.evaluate(() => {
      window.__cancelRefinementAtStart = true;
    });
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('button', { name: '预览三维形态学', exact: true })).toBeEnabled();
    await expect(page.getByRole('status')).toContainText('已取消精修计算');
    assert.deepEqual(await snapshot(page), baseline);
    report.checks.push(
      'cancellation during snapshot preparation also releases the operation and leaves accepted data intact'
    );
    const secondId = await startHeavy(page);
    assert.notEqual(secondId, firstId);
    assert.equal(
      await page.evaluate(
        taskId =>
          window.commandsManager.run('cancelMaskRefinementCalculation', { taskId }).cancelled,
        firstId
      ),
      false
    );
    await expect(page.getByRole('button', { name: '取消精修计算', exact: true })).toBeEnabled();
    await page.evaluate(() => window.commandsManager.run('discardMaskRefinementPreview'));
    await expect(page.getByRole('status')).toContainText('已取消精修计算');
    assert.deepEqual(await snapshot(page), baseline);
    report.checks.push(
      'an old cancellation token cannot stop a new task; discarding the current calculation cancels it safely'
    );
    await page.getByLabel('三维形态学操作', { exact: true }).selectOption('dilate');
    await page.getByLabel('形态学半径 mm', { exact: true }).fill('1.1');
    await page.evaluate(() => {
      window.__refinementTasks = [];
    });
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toBeVisible();
    const tasks = await page.evaluate(() => window.__refinementTasks);
    assert.equal(tasks.at(-1).phase, 'complete');
    assert.equal(tasks.at(-1).percent, 100);
    assert.ok(
      tasks.some(task => task.stage === 'prepare') &&
        tasks.some(task => task.stage === 'compute') &&
        tasks.some(task => task.stage === 'validate')
    );
    assert.ok(
      tasks.every(
        (task, i) =>
          task.percent >= 0 && task.percent <= 100 && (!i || task.percent >= tasks[i - 1].percent)
      )
    );
    assert.deepEqual(await snapshot(page), baseline);
    report.checks.push(
      'a subsequent task completes normally with bounded monotonic progress across preparation, computation and validation'
    );
    await page.getByRole('button', { name: '关闭精修预览', exact: true }).click();
    await page.evaluate(() => {
      window.__cancelRefinementAtCompletion = true;
    });
    await page.getByRole('button', { name: '预览三维形态学', exact: true }).click();
    await expect(page.getByRole('button', { name: '预览三维形态学', exact: true })).toBeEnabled();
    await expect(page.getByRole('status')).toContainText('已取消精修计算');
    await expect(page.getByRole('region', { name: 'Mask 精修预览', exact: true })).toHaveCount(0);
    assert.deepEqual(await snapshot(page), baseline);
    report.checks.push(
      'cancellation at the final validation checkpoint does not publish a late preview or mutate accepted data'
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.failure = error.stack;
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

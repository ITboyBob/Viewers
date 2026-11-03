import { copySharedLink } from './sharedLink';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dcmjs from 'dcmjs';
import type { BusinessServices } from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from '../phase-one/syntheticDicom';

test.use({ headless: false });
const execute = promisify(execFile);

type Camera = { parallelScale: number; position: number[]; focalPoint: number[]; viewUp: number[] };
type CursorViewport = {
  type: string;
  element: HTMLElement;
  getImageData(): { imageData: { indexToWorld(index: number[]): number[] }; dimensions: number[] };
  getCurrentImageId(): string;
  getCornerstoneImage(): { imageId: string; columns: number; rows: number };
  imagesLoader: { loadImages(...args: unknown[]): Promise<unknown> };
  getCurrentImageIdIndex(): number;
  setImageIdIndex(index: number): Promise<unknown>;
  canvasToWorld(point: number[]): number[];
  worldToCanvas(point: number[]): number[];
  getCamera(): Camera;
  setCamera(camera: Partial<Camera>): void;
  render(): void;
};
type CursorWindow = Window & {
  nativeFrameGate?: { release(): void; done: Promise<unknown> };
  cursorAudit?: Array<{ event: string; at: number; x?: number; y?: number; target?: string }>;
  services: {
    businessServices: BusinessServices;
    viewportGridService: { getActiveViewportId(): string };
    cornerstoneViewportService: { getCornerstoneViewport(id: string): CursorViewport };
    toolGroupService: { getToolGroupForViewport(id: string): { id: string } };
  };
  commandsManager: { run(command: string, options?: Record<string, unknown>): unknown };
};

function auditViewportEvents() {
  const audit: NonNullable<CursorWindow['cursorAudit']> = [];
  (window as unknown as CursorWindow).cursorAudit = audit;
  const record = (event: Event) => {
    if (
      event instanceof MouseEvent &&
      (!(event.target instanceof Element) || !event.target.closest('.cornerstone-viewport-element'))
    ) {
      return;
    }
    audit.push({
      event: event.type,
      at: performance.now(),
      ...(event instanceof MouseEvent
        ? { x: event.clientX, y: event.clientY, target: (event.target as Element).tagName }
        : {}),
    });
    if (audit.length > 30) {
      audit.shift();
    }
  };
  window.addEventListener('blur', record);
  window.addEventListener('focus', record);
  document.addEventListener('visibilitychange', record);
  document.addEventListener('CORNERSTONE_PRE_STACK_NEW_IMAGE', record, true);
  document.addEventListener('CORNERSTONE_STACK_NEW_IMAGE', record, true);
  document.addEventListener('pointermove', record, true);
  document.addEventListener('pointerenter', record, true);
  document.addEventListener('pointerleave', record, true);
}

async function login(page: Page, request: APIRequestContext, prefix: string) {
  const username = `${prefix}-${randomUUID().slice(0, 8)}`,
    password = 'cursor-synthetic-password';
  const response = await request.post('/api/v1/users', { data: { username, password } });
  expect(response.status()).toBe(201);
  const uid = (await response.json()).data.user.uid;
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  return { username, uid };
}
async function ready(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as CursorWindow).services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return !!v?.getImageData()?.imageData && v.type === 'stack';
      })
    )
    .toBe(true);
}
async function activatePointerWindow(page: Page) {
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.mouse.move(0, 0);
  // 等原生窗口完成焦点/悬停恢复，随后由调用者提供新的图像内指针样本。
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}
async function imagePoint(page: Page, column = 12, row = 10) {
  return page.evaluate(
    ({ column, row }) => {
      const s = (window as unknown as CursorWindow).services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport(
        s.viewportGridService.getActiveViewportId()
      );
      const point = v.worldToCanvas(v.getImageData().imageData.indexToWorld([column, row, 0]));
      const rect = v.element.getBoundingClientRect();
      return {
        x: rect.left + point[0],
        y: rect.top + point[1],
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
      };
    },
    { column, row }
  );
}
async function aligned(page: Page, participant: string, column = 12, row = 10) {
  const mark = page.locator(`[data-remote-cursor="${participant}"]`);
  try {
    await expect(mark).toHaveCount(1);
    await expect
      .poll(async () => {
        const expected = await imagePoint(page, column, row);
        const path = await mark.locator('svg path').elementHandle();
        if (!path) {
          return 1000000;
        }
        return path.evaluate((element, point) => {
          const tip = new DOMPoint(0.75, 0.75).matrixTransform(
            (element as SVGGraphicsElement).getScreenCTM()!
          );
          return Math.hypot(tip.x - point.x, tip.y - point.y);
        }, expected);
      })
      .toBeLessThanOrEqual(2);
  } catch (error) {
    for (const current of page.context().pages()) {
      console.info(
        '光标运行证据',
        await current.evaluate(() => {
          const w = window as unknown as CursorWindow;
          const p = w.services?.businessServices?.localCollaboration?.participation;
          return {
            focus: document.hasFocus(),
            visibility: document.visibilityState,
            phase: p?.getSnapshot().phase,
            members: p?.getSnapshot().members.map(member => ({
              self: member.participant_id === p.identity.participant_id,
              hasCursor: !!member.cursor,
              seq: member.cursor_seq,
            })),
            marks: document.querySelectorAll('[data-remote-cursor]').length,
            events: w.cursorAudit,
          };
        })
      );
    }
    throw error;
  }
  return mark;
}

test('G4：真实Stack双向箭头、变换重投影、固定样式、静止与工具隔离', async ({
  page,
  request,
}, testInfo) => {
  await page.addInitScript(auditViewportEvents);
  const sourceCDP = await page.context().newCDPSession(page);
  await sourceCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const a = await login(page, request, 'cursor-source-long');
  const writesA: string[] = [],
    writesB: string[] = [];
  let inFlight = 0;
  const taskWrite = (url: string) => /\/tasks(?:\/|$)/.test(new URL(url).pathname);
  page.on('request', req => {
    if (taskWrite(req.url())) {
      writesA.push(req.method());
      inFlight++;
    }
  });
  page.on('requestfinished', req => {
    if (taskWrite(req.url())) {
      inFlight--;
    }
  });
  page.on('requestfailed', req => {
    if (taskWrite(req.url())) {
      inFlight--;
    }
  });
  const files = syntheticSeries(3).files;
  await page
    .getByLabel('导入文件', { exact: true })
    .setInputFiles([
      { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('invalid') },
      ...files,
    ]);
  await expect(page.getByRole('button', { name: '共享链接', exact: true })).toBeVisible();
  await ready(page);
  const href = await copySharedLink(page);
  const viewer = await page.context().newPage();
  await viewer.addInitScript(auditViewportEvents);
  const viewerCDP = await viewer.context().newCDPSession(viewer);
  await viewerCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const b = await login(viewer, request, 'cursor-b');
  viewer.on('request', req => {
    if (taskWrite(req.url())) {
      writesB.push(req.method());
    }
  });
  await viewer.goto(href!);
  await expect(viewer.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await ready(viewer);
  const ids = await Promise.all(
    [page, viewer].map(value =>
      value.evaluate(
        () =>
          (window as unknown as CursorWindow).services.businessServices.localCollaboration!
            .participation!.identity.participant_id
      )
    )
  );
  expect(a.uid).not.toBe(b.uid);
  expect(ids[0]).not.toBe(ids[1]);
  // 先完成真实确认，再移除自动点击；接收窗的被动断言不能改变发送窗焦点。
  for (const current of [page, viewer]) {
    await current.bringToFront();
    const confirmation = current.getByRole('button', { name: 'Confirm and hide', exact: true });
    await current.removeLocatorHandler(confirmation);
    if (await confirmation.isVisible()) {
      await confirmation.click();
    }
  }
  await activatePointerWindow(page);
  const pointA = await imagePoint(page);
  await page.mouse.move(pointA.x, pointA.y);
  const initialSampling = await page.evaluate(target => {
    const w = window as unknown as CursorWindow;
    const p = w.services.businessServices.localCollaboration!.participation!;
    const cursor = p
      .getSnapshot()
      .members.find(member => member.participant_id === p.identity.participant_id)?.cursor;
    return {
      target,
      focus: document.hasFocus(),
      isCurrent: p.identity.isCurrent(),
      viewReady: w.services.businessServices
        .localCollaboration!.identities.getSource()
        ?.getSnapshot().view_ready,
      sample: cursor ? { column: cursor.column, row: cursor.row } : null,
      events: w.cursorAudit,
    };
  }, pointA);
  await testInfo.attach('原图像素采样', {
    body: Buffer.from(JSON.stringify(initialSampling)),
    contentType: 'application/json',
  });
  const arrowA = await aligned(viewer, ids[0]);
  await expect(arrowA.locator('[data-cursor-username]')).toHaveText(a.username);
  expect(await viewer.locator(`[data-remote-cursor="${ids[1]}"]`).count()).toBe(0);
  const style = await arrowA.evaluate(mark => {
    const svg = mark.querySelector('svg')!,
      label = mark.querySelector('[data-cursor-label]')!,
      text = mark.querySelector('[data-cursor-username]')!;
    const css = getComputedStyle(label),
      arrow = svg.getBoundingClientRect();
    return {
      width: arrow.width,
      height: arrow.height,
      stroke: getComputedStyle(svg.querySelector('path')!).strokeWidth,
      font: css.fontSize,
      line: css.lineHeight,
      weight: css.fontWeight,
      labelHeight: label.getBoundingClientRect().height,
      radius: css.borderRadius,
      padding: css.padding,
      background: css.backgroundColor,
      color: css.color,
      pointer: getComputedStyle(mark).pointerEvents,
      overflow: getComputedStyle(text).textOverflow,
      title: text.getAttribute('title'),
    };
  });
  expect(style).toMatchObject({
    width: 20,
    height: 24,
    stroke: '1.5px',
    font: '12px',
    line: '16px',
    weight: '500',
    labelHeight: 22,
    radius: '4px',
    padding: '3px 6px',
    background: 'rgb(37, 99, 235)',
    color: 'rgb(255, 255, 255)',
    pointer: 'none',
    overflow: 'ellipsis',
    title: null,
  });
  const beforeSequence = await page.evaluate(() => {
    const p = (window as unknown as CursorWindow).services.businessServices.localCollaboration!
      .participation!;
    return p
      .getSnapshot()
      .members.find(member => member.participant_id === p.identity.participant_id)!.cursor_seq;
  });
  const camera = await viewer.evaluate(() => {
    const s = (window as unknown as CursorWindow).services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    const c = v.getCamera();
    const saved = {
      parallelScale: c.parallelScale,
      position: Array.from(c.position),
      focalPoint: Array.from(c.focalPoint),
      viewUp: Array.from(c.viewUp),
    };
    v.setCamera({ parallelScale: c.parallelScale * 0.7 });
    v.render();
    return saved;
  });
  await aligned(viewer, ids[0]);
  await viewer.evaluate(() => {
    const s = (window as unknown as CursorWindow).services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    const world = v.getImageData().imageData.indexToWorld([12, 10, 0]);
    const target = v.canvasToWorld([v.element.clientWidth - 5, v.element.clientHeight - 5]);
    const delta = world.map((value, index) => value - target[index]);
    const c = v.getCamera();
    v.setCamera({
      position: c.position.map((value, index) => value + delta[index]),
      focalPoint: c.focalPoint.map((value, index) => value + delta[index]),
    });
    v.render();
  });
  const edge = await aligned(viewer, ids[0]);
  const boundary = await imagePoint(viewer);
  const labelBox = await edge.locator('[data-cursor-label]').boundingBox();
  expect(labelBox!.x).toBeGreaterThanOrEqual(boundary.left + 4 - 0.1);
  expect(labelBox!.y).toBeGreaterThanOrEqual(boundary.top + 4 - 0.1);
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(
    boundary.left + boundary.width - 4 + 0.1
  );
  expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(
    boundary.top + boundary.height - 4 + 0.1
  );
  expect(labelBox!.width).toBeLessThanOrEqual(132);
  await viewer.screenshot({ path: testInfo.outputPath('远端箭头与边缘标签.png') });
  await viewer.evaluate(saved => {
    const s = (window as unknown as CursorWindow).services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    v.setCamera(saved);
    v.render();
  }, camera);
  await aligned(viewer, ids[0]);
  await viewer.setViewportSize({ width: 1280, height: 800 });
  await aligned(viewer, ids[0]);
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await viewer.setViewportSize({ width: 1440, height: 900 });
  await aligned(viewer, ids[0]);
  expect(
    await page.evaluate(() => {
      const p = (window as unknown as CursorWindow).services.businessServices.localCollaboration!
        .participation!;
      return p
        .getSnapshot()
        .members.find(member => member.participant_id === p.identity.participant_id)!.cursor_seq;
    })
  ).toBe(beforeSequence);
  await expect.poll(() => inFlight).toBe(0);
  const pureStart = writesA.length;
  await activatePointerWindow(viewer);
  const pointB = await imagePoint(viewer, 20, 18);
  await viewer.mouse.move(pointB.x, pointB.y);
  const arrowB = await aligned(page, ids[1], 20, 18);
  await expect(arrowB.locator('[data-cursor-username]')).toHaveText(b.username);
  expect(
    await arrowB
      .locator('[data-cursor-label]')
      .evaluate(label => getComputedStyle(label).backgroundColor)
  ).toBe('rgb(194, 65, 12)');
  await viewer.waitForTimeout(6100);
  await aligned(page, ids[1], 20, 18);
  await viewer.mouse.move(0, 0);
  await expect(page.locator(`[data-remote-cursor="${ids[1]}"]`)).toHaveCount(0, { timeout: 1000 });
  await viewer.mouse.move(pointB.x, pointB.y);
  await aligned(page, ids[1], 20, 18);
  await activatePointerWindow(page);
  await expect.poll(() => viewer.evaluate(() => document.hasFocus())).toBe(false);
  await expect(page.locator(`[data-remote-cursor="${ids[1]}"]`)).toHaveCount(0, { timeout: 1000 });
  expect(writesA.length).toBe(pureStart);
  expect(writesB).toEqual([]);
  const back = await imagePoint(page);
  await page.mouse.move(back.x, back.y);
  await aligned(viewer, ids[0]);
  const pendingFrame = await page.evaluate(() => {
    const w = window as unknown as CursorWindow;
    const s = w.services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    const loader = v.imagesLoader,
      original = loader.loadImages;
    let release: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    loader.loadImages = async (...args) => {
      await gate;
      return original.apply(loader, args);
    };
    const done = v.setImageIdIndex(1);
    w.nativeFrameGate = {
      done,
      release: () => {
        loader.loadImages = original;
        release();
      },
    };
    return { targetAheadOfLoaded: v.getCurrentImageId() !== v.getCornerstoneImage().imageId };
  });
  expect(pendingFrame.targetAheadOfLoaded).toBe(true);
  await page.mouse.move(back.x + 3, back.y);
  expect(
    await page.evaluate(() => {
      const p = (window as unknown as CursorWindow).services.businessServices.localCollaboration!
        .participation!;
      return p
        .getSnapshot()
        .members.find(member => member.participant_id === p.identity.participant_id)!.cursor;
    })
  ).toBeNull();
  await expect(viewer.locator(`[data-remote-cursor="${ids[0]}"]`)).toHaveCount(0);
  await page.evaluate(async () => {
    const w = window as unknown as CursorWindow;
    w.nativeFrameGate!.release();
    await w.nativeFrameGate!.done;
    delete w.nativeFrameGate;
  });
  const otherFrame = await imagePoint(page);
  await page.mouse.move(otherFrame.x + 1, otherFrame.y);
  await page.mouse.move(otherFrame.x, otherFrame.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const p = (window as unknown as CursorWindow).services.businessServices.localCollaboration!
          .participation!;
        return !!p
          .getSnapshot()
          .members.find(member => member.participant_id === p.identity.participant_id)!.cursor;
      })
    )
    .toBe(true);
  await expect(viewer.locator(`[data-remote-cursor="${ids[0]}"]`)).toHaveCount(0);
  await page.evaluate(async () => {
    const s = (window as unknown as CursorWindow).services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    await v.setImageIdIndex(0);
    v.render();
  });
  await expect(viewer.locator(`[data-remote-cursor="${ids[0]}"]`)).toHaveCount(0);
  const again = await imagePoint(page);
  await page.mouse.move(again.x + 1, again.y);
  await page.mouse.move(again.x, again.y);
  await aligned(viewer, ids[0]);
  await activatePointerWindow(viewer);
  const oldCamera = await viewer.evaluate(() => {
    const w = window as unknown as CursorWindow,
      s = w.services,
      id = s.viewportGridService.getActiveViewportId();
    w.commandsManager.run('setToolActiveToolbar', {
      toolName: 'Pan',
      toolGroupIds: [s.toolGroupService.getToolGroupForViewport(id).id],
    });
    return Array.from(
      s.cornerstoneViewportService.getCornerstoneViewport(id).getCamera().focalPoint
    );
  });
  const drag = await imagePoint(viewer, 16, 16);
  await viewer.mouse.move(drag.x, drag.y);
  await viewer.mouse.down();
  await viewer.mouse.move(drag.x + 35, drag.y + 20, { steps: 5 });
  await viewer.mouse.up();
  expect(
    await viewer.evaluate(() => {
      const s = (window as unknown as CursorWindow).services;
      return Array.from(
        s.cornerstoneViewportService
          .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
          .getCamera().focalPoint
      );
    })
  ).not.toEqual(oldCamera);
  expect(writesB).toEqual([]);
  await viewer.evaluate(() =>
    (window as unknown as CursorWindow).commandsManager.run('setHangingProtocol', {
      protocolId: 'mpr',
      reset: true,
    })
  );
  await expect
    .poll(() =>
      viewer.evaluate(() => {
        const s = (window as unknown as CursorWindow).services;
        const v = s.cornerstoneViewportService.getCornerstoneViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return v?.type === 'orthographic' && !!v.getImageData();
      })
    )
    .toBe(true);
  await expect(viewer.getByText('当前视口暂不支持共享光标', { exact: true }).first()).toBeVisible();
  expect(await viewer.locator('[data-remote-cursor]').count()).toBe(0);
  expect(writesB).toEqual([]);
  await viewer.close();
});

test('旧MPR脚本原断言在受控Chrome、真实登录和本次合成数据上通过', async ({ request }, testInfo) => {
  test.setTimeout(180000);
  expect((await request.get('/actuator/health')).status()).toBe(200);
  const scripts = path.resolve('.scripts');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'colla-mpr-fixture-'));
  try {
    const generator = await fs.readFile(path.join(scripts, 'generate-mask-demo.cjs'), 'utf8');
    const outputLine = "const output = path.resolve(__dirname, '../demo-data');";
    expect(generator.includes(outputLine)).toBe(true);
    const generate = generator
      .replace(outputLine, `const output = ${JSON.stringify(fixture)};`)
      .replaceAll('__dirname', JSON.stringify(scripts));
    await execute(process.execPath, ['-e', generate], { cwd: process.cwd(), timeout: 60000 });
    let original = await fs.readFile(path.join(scripts, 'verify-mpr-brushes.cjs'), 'utf8');
    const entry =
      "await page.goto('http://localhost:3000/local-mask', { waitUntil: 'networkidle' });";
    expect(original.includes(entry)).toBe(true);
    expect(original.includes("channel: 'msedge'")).toBe(true);
    const loginCode = `const username='mpr-'+require('node:crypto').randomUUID().slice(0,8), password='mpr-synthetic-password';
      assert.equal((await page.request.post('http://localhost:3336/api/v1/users',{data:{username,password}})).status(),201);
      await page.goto('http://localhost:3336/account/login');
      await page.getByLabel('用户名').fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
      await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page).toHaveURL(/local-mask$/);`;
    original = original
      .replace("channel: 'msedge'", "channel: 'chrome'")
      .replace(entry, loginCode)
      .replace(
        "const output = path.resolve(__dirname, '../.cache/mask-ui');",
        `const output = ${JSON.stringify(testInfo.outputPath('mpr-原脚本'))};`
      )
      .replaceAll("path.resolve(__dirname, '../demo-data')", JSON.stringify(fixture))
      .replace(
        "path.resolve(__dirname, '../demo-data', file)",
        `path.resolve(${JSON.stringify(fixture)}, file)`
      )
      .replaceAll('__dirname', JSON.stringify(scripts));
    // 保留原脚本全部工具／像素／预览断言，仅适配浏览器、地址、登录、输入与输出目录。
    const result = await execute(process.execPath, ['-e', original], {
      cwd: process.cwd(),
      timeout: 150000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await testInfo.attach('旧MPR原断言结果', {
      body: Buffer.from(result.stdout),
      contentType: 'application/json',
    });
    const report = JSON.parse(
      await fs.readFile(testInfo.outputPath('mpr-原脚本', 'mpr-brush-report.json'), 'utf8')
    );
    expect(report.browserErrors).toEqual([]);
    expect(report.checks).toHaveLength(8);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('CPU Stack在真实完成先于metadata更新时，等待渲染后恢复同帧光标', async ({ page, request }) => {
  await page.route('**/app-config.js', async route => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()) + '\nwindow.config.useCPURendering = true;',
    });
  });
  const a = await login(page, request, 'cpu-source');
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { cornerstone: { getShouldUseCPURendering(): boolean } }
      ).cornerstone.getShouldUseCPURendering()
    )
  ).toBe(true);
  const sample = syntheticSeries(3);
  const data = sample.files[1].buffer;
  const parsed = dcmjs.data.DicomMessage.readFile(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  );
  parsed.dict['00280010'] = { vr: 'US', Value: [64] };
  parsed.dict['00280011'] = { vr: 'US', Value: [64] };
  parsed.dict['7FE00010'] = { vr: 'OW', Value: [new Uint16Array(64 * 64).fill(1124).buffer] };
  const writer = new dcmjs.data.DicomDict(parsed.meta);
  writer.dict = parsed.dict;
  sample.files[1].buffer = Buffer.from(writer.write());
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(sample.files);
  await expect(page.getByRole('button', { name: '共享链接', exact: true })).toBeVisible();
  await ready(page);
  const href = await copySharedLink(page);
  const viewer = await page.context().newPage();
  await login(viewer, request, 'cpu-peer');
  await viewer.goto(href!);
  await expect(viewer.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await ready(viewer);
  for (const current of [page, viewer]) {
    const confirm = current.getByRole('button', { name: 'Confirm and hide', exact: true });
    await current.removeLocatorHandler(confirm);
    if (await confirm.isVisible()) {
      await confirm.click();
    }
  }
  for (const current of [page, viewer]) {
    const transition = await current.evaluate(async () => {
      const s = (window as unknown as CursorWindow).services;
      const v = s.cornerstoneViewportService.getCornerstoneViewport(
        s.viewportGridService.getActiveViewportId()
      );
      let completedBeforeMetadata = false;
      const completed = () => {
        completedBeforeMetadata =
          v.getCornerstoneImage().columns === 64 && v.getImageData()?.dimensions[0] !== 64;
      };
      v.element.addEventListener('CORNERSTONE_STACK_NEW_IMAGE', completed, { once: true });
      await v.setImageIdIndex(1);
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      v.element.removeEventListener('CORNERSTONE_STACK_NEW_IMAGE', completed);
      return completedBeforeMetadata;
    });
    if (current === page) {
      expect(transition).toBe(true);
    }
  }
  expect(
    await page.evaluate(() => {
      const s = (window as unknown as CursorWindow).services;
      return s.cornerstoneViewportService
        .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
        .getImageData()
        .dimensions.slice(0, 2);
    })
  ).toEqual([64, 64]);
  const participant = await page.evaluate(
    () =>
      (window as unknown as CursorWindow).services.businessServices.localCollaboration!
        .participation!.identity.participant_id
  );
  await page.bringToFront();
  const point = await imagePoint(page);
  await page.mouse.move(0, 0);
  await page.mouse.move(point.x, point.y);
  const mark = await aligned(viewer, participant);
  await expect(mark.locator('[data-cursor-username]')).toHaveText(a.username);
  await viewer.close();
});

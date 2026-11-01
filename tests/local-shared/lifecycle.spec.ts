import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  BusinessServices,
  SharedFileRecord,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from '../phase-one/syntheticDicom';
import { openChromeWindows, activateChromeWindow } from './chromeWindows';

type NativeWindow = Window & {
  releaseNativeStack?: () => void;
  nativeStackPending?: boolean;
  savedSharedFile?: SharedFileRecord;
  services: {
    businessServices: BusinessServices;
    measurementService: { clearMeasurements(): void };
    viewportGridService: { getActiveViewportId(): string };
    cornerstoneViewportService: {
      getCornerstoneViewport(id: string): {
        element: HTMLElement;
        type: string;
        getImageData(): { imageData: { indexToWorld(value: number[]): number[] } };
        worldToCanvas(value: number[]): number[];
      };
    };
  };
};
async function login(page: Page, request: APIRequestContext, prefix: string) {
  const username = `${prefix}-${randomUUID().slice(0, 8)}`,
    password = 'native-window-synthetic';
  const response = await request.post('/api/v1/users', { data: { username, password } });
  expect(response.status()).toBe(201);
  const uid = (await response.json()).data.user.uid;
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  return { username, uid };
}
async function dismiss(page: Page) {
  if (!(await page.evaluate(() => !!sessionStorage.getItem('investigationalUseDialog')))) {
    await page.getByRole('button', { name: 'Confirm and hide', exact: true }).click();
  }
}
async function source(page: Page, request: APIRequestContext) {
  const user = await login(page, request, 'native-source');
  const sample = syntheticSeries(3);
  await page
    .getByLabel('导入文件', { exact: true })
    .setInputFiles([
      { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('invalid') },
      ...sample.files,
    ]);
  await expect(page.getByRole('link', { name: '共享链接', exact: true })).toBeVisible();
  await dismiss(page);
  const href = (await page
    .getByRole('link', { name: '共享链接', exact: true })
    .getAttribute('href'))!;
  const task = await page.evaluate(
    () =>
      (window as unknown as NativeWindow).services.businessServices.projectRuntime!.getCurrent()!
        .task_id
  );
  return { user, href, task };
}
async function enter(page: Page, href: string) {
  await page.goto(href);
  await expect(page.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
  await dismiss(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as NativeWindow).services;
        return !!s.cornerstoneViewportService
          .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
          ?.getImageData()?.imageData;
      })
    )
    .toBe(true);
}
async function point(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as NativeWindow).services;
    const v = s.cornerstoneViewportService.getCornerstoneViewport(
      s.viewportGridService.getActiveViewportId()
    );
    const p = v.worldToCanvas(v.getImageData().imageData.indexToWorld([12, 10, 0])),
      r = v.element.getBoundingClientRect();
    return { x: r.left + p[0], y: r.top + p[1] };
  });
}
const taskPath = (url: string) => /\/tasks(?:\/|$)/.test(new URL(url).pathname);

test('S5普通双原生窗口：同默认个人资料、不同真实账户、双向光标与退出保留', async ({
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const windows = await openChromeWindows();
  try {
    await testInfo.attach('普通双窗口形态', {
      body: Buffer.from(JSON.stringify(windows.evidence, null, 2)),
      contentType: 'application/json',
    });
    expect(windows.evidence.windows[0].windowId).not.toBe(windows.evidence.windows[1].windowId);
    expect(windows.evidence.nonDefaultContexts).toEqual([]);
    let creates = 0;
    windows.a.on('request', req => {
      if (req.method() === 'POST' && /\/tasks$/.test(new URL(req.url()).pathname)) {
        creates++;
      }
    });
    const a = await source(windows.a, request),
      b = await login(windows.b, request, 'native-viewer');
    expect(a.user.uid).not.toBe(b.uid);
    const writes: string[] = [];
    windows.b.on('request', req => {
      if (taskPath(req.url())) {
        writes.push(req.method());
      }
    });
    await enter(windows.b, a.href);
    const state = await windows.b.evaluate(() => {
      const s = (window as unknown as NativeWindow).services.businessServices,
        c = s.localCollaboration!,
        v = c.sharedView!.getSnapshot()!;
      return {
        task: v.task_id,
        viewer: v.viewer_uid,
        importer: v.importer_uid,
        participant: c.participation!.identity.participant_id,
        colors: c.participation!.getSnapshot().color_registry,
      };
    });
    expect(state).toMatchObject({ task: a.task, viewer: b.uid, importer: a.user.uid });
    await fs.writeFile(
      testInfo.outputPath('普通双窗口形态.json'),
      JSON.stringify(
        { ...windows.evidence, source_uid: a.user.uid, viewer_uid: b.uid, shared: state },
        null,
        2
      )
    );
    const aId = await windows.a.evaluate(
      () =>
        (window as unknown as NativeWindow).services.businessServices.localCollaboration!
          .participation!.identity.participant_id
    );
    await activateChromeWindow(windows.a);
    const first = await point(windows.a);
    await windows.a.mouse.move(first.x, first.y);
    const aMark = windows.b.locator(`[data-remote-cursor="${aId}"]`);
    await expect(aMark).toHaveCount(1);
    await expect(aMark.locator('[data-cursor-username]')).toHaveText(a.user.username);
    await windows.b.screenshot({ path: testInfo.outputPath('普通B窗口看到A.png') });
    // 此双窗口驱动使用真实pointerleave交接鼠标；真实blur另由G4有头焦点用例取证。
    await windows.a.mouse.move(0, 0);
    await expect(aMark).toHaveCount(0);
    await activateChromeWindow(windows.b);
    const second = await point(windows.b);
    await windows.b.mouse.move(second.x, second.y);
    const bMark = windows.a.locator(`[data-remote-cursor="${state.participant}"]`);
    await expect(bMark).toHaveCount(1);
    await expect(bMark.locator('[data-cursor-username]')).toHaveText(b.username);
    await windows.a.screenshot({ path: testInfo.outputPath('普通A窗口看到B.png') });
    expect(await windows.b.locator(`[data-remote-cursor="${state.participant}"]`).count()).toBe(0);
    await windows.b.mouse.move(0, 0);
    await windows.b.reload();
    await expect(windows.b.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
    const reentry = await windows.b.evaluate(() => {
      const p = (window as unknown as NativeWindow).services.businessServices.localCollaboration!
        .participation!;
      return { id: p.identity.participant_id, colors: p.getSnapshot().color_registry };
    });
    expect(reentry.id).not.toBe(state.participant);
    expect(reentry.colors).toEqual(state.colors);
    await windows.a.close();
    await expect(windows.b.getByRole('status').filter({ hasText: '源窗口已离开' })).toBeVisible();
    expect(
      await windows.b.evaluate(() =>
        (
          window as unknown as NativeWindow
        ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!.scope_handle!
          .isActive!()
      )
    ).toBe(true);
    expect(creates).toBe(1);
    expect(writes).toEqual([]);
    await windows.b.reload();
    await expect(windows.b.getByRole('alert').filter({ hasText: '本地共享不可用' })).toBeVisible({
      timeout: 25000,
    });
    expect(writes).toEqual([]);
  } finally {
    await windows.close();
    expect(
      await fs.access(windows.evidence.profile).then(
        () => true,
        () => false
      )
    ).toBe(false);
  }
});

for (const closeBeforeFrame of [true, false]) {
  test(`S5真实慢初始化：active心跳超过15秒，首帧前关闭=${closeBeforeFrame}`, async ({
    request,
  }) => {
    test.setTimeout(90000);
    const windows = await openChromeWindows();
    try {
      const a = await source(windows.a, request);
      await windows.b.addInitScript(() => {
        const w = window as unknown as NativeWindow;
        let core: unknown;
        const gate = new Promise<void>(resolve => {
          w.releaseNativeStack = resolve;
        });
        Object.defineProperty(window, 'cornerstone', {
          configurable: true,
          get: () => core,
          set: value => {
            core = value;
            const prototype = (
              value as {
                StackViewport: { prototype: { setStack(...args: unknown[]): Promise<unknown> } };
              }
            ).StackViewport.prototype;
            const original = prototype.setStack;
            prototype.setStack = async function (...args: unknown[]) {
              w.nativeStackPending = true;
              await gate;
              return original.apply(this, args);
            };
          },
        });
      });
      await login(windows.b, request, 'native-slow');
      await windows.b.goto(a.href);
      await expect
        .poll(() =>
          windows.b.evaluate(() => (window as unknown as NativeWindow).nativeStackPending === true)
        )
        .toBe(true);
      await windows.b.waitForTimeout(16050);
      const waiting = await windows.b.evaluate(() => {
        const c = (window as unknown as NativeWindow).services.businessServices.localCollaboration!;
        return {
          phase: c.participation!.getSnapshot().phase,
          ready: c.sharedView!.getSnapshot()!.view_ready,
        };
      });
      expect(waiting).toEqual({ phase: 'active', ready: false });
      if (!closeBeforeFrame) {
        await dismiss(windows.b);
        await windows.b.evaluate(() => (window as unknown as NativeWindow).releaseNativeStack!());
        await expect
          .poll(() =>
            windows.b.evaluate(
              () =>
                (
                  window as unknown as NativeWindow
                ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!
                  .view_ready
            )
          )
          .toBe(true);
        await windows.a.close();
        await expect(
          windows.b.getByRole('status').filter({ hasText: '源窗口已离开' })
        ).toBeVisible();
        return;
      }
      await windows.a.close();
      await expect
        .poll(() =>
          windows.b.evaluate(
            () =>
              (
                window as unknown as NativeWindow
              ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!.phase
          )
        )
        .toBe('disposed');
      await windows.b.evaluate(() => (window as unknown as NativeWindow).releaseNativeStack!());
      expect(await windows.b.locator('.cornerstone-viewport-element').count()).toBe(0);
    } finally {
      await windows.close();
    }
  });
}

test('S5普通双窗：缺失原生Blob拒绝整次进入，恢复后显式重试不重登记', async ({
  request,
}, testInfo) => {
  const windows = await openChromeWindows();
  try {
    await testInfo.attach('普通双窗口形态', {
      body: Buffer.from(JSON.stringify(windows.evidence)),
      contentType: 'application/json',
    });
    const a = await source(windows.a, request);
    await login(windows.b, request, 'native-retry');
    await windows.a.evaluate(async () => {
      const w = window as unknown as NativeWindow;
      const c = w.services.businessServices.localCollaboration!,
        source = c.identities.getSource()!;
      const bundle = await c.files!.read(
        source.task_id,
        source.batch_id,
        source.identity.participant_id,
        new AbortController().signal
      );
      w.savedSharedFile = bundle.files[0];
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('colla.local-shared.v1:/', 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').delete([source.batch_id, bundle.files[0].selection_index]);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
        open.onerror = () => reject(open.error);
      });
    });
    const writes: string[] = [];
    windows.b.on('request', req => {
      if (taskPath(req.url())) {
        writes.push(req.method());
      }
    });
    await windows.b.goto(a.href);
    await expect(windows.b.getByRole('alert').filter({ hasText: '本地共享不可用' })).toBeVisible();
    expect(await windows.b.locator('.cornerstone-viewport-element').count()).toBe(0);
    expect(
      await windows.a.evaluate(
        () =>
          (
            window as unknown as NativeWindow
          ).services.businessServices.projectRuntime!.getCurrent()!.phase
      )
    ).toBe('registered');
    await windows.a.evaluate(async () => {
      const w = window as unknown as NativeWindow;
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('colla.local-shared.v1:/', 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put(w.savedSharedFile!);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
        open.onerror = () => reject(open.error);
      });
      delete w.savedSharedFile;
    });
    await windows.b.getByRole('button', { name: '重试共享加载' }).click();
    await expect(windows.b.getByRole('status').filter({ hasText: '已进入共享' })).toBeVisible();
    expect(
      await windows.b.evaluate(
        () =>
          (
            window as unknown as NativeWindow
          ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!.task_id
      )
    ).toBe(a.task);
    expect(writes).toEqual([]);
  } finally {
    await windows.close();
  }
});

test('S5真实频道静默：15秒失联后关闭参与，保留已ready画面且B零Task', async ({ request }) => {
  const windows = await openChromeWindows();
  try {
    const a = await source(windows.a, request);
    await login(windows.b, request, 'native-timeout');
    const writes: string[] = [];
    windows.b.on('request', req => {
      if (taskPath(req.url())) {
        writes.push(req.method());
      }
    });
    await enter(windows.b, a.href);
    await expect
      .poll(() =>
        windows.b.evaluate(
          () =>
            (
              window as unknown as NativeWindow
            ).services.businessServices.localCollaboration!.sharedView!.getSnapshot()!.view_ready
        )
      )
      .toBe(true);
    // 仅丢弃本次合成源窗口的共享频道发包；不冒称操作系统崩溃或网络断开。
    await windows.a.evaluate(() => {
      const original = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (value: unknown) {
        if (!this.name.startsWith('colla.local-shared.v1:')) {
          original.call(this, value);
        }
      };
    });
    await expect(windows.b.getByRole('status').filter({ hasText: '源窗口已离开' })).toBeVisible({
      timeout: 20000,
    });
    expect(
      await windows.b.evaluate(() => {
        const c = (window as unknown as NativeWindow).services.businessServices.localCollaboration!;
        return {
          phase: c.participation!.getSnapshot().phase,
          scope: c.sharedView!.getSnapshot()!.scope_handle!.isActive!(),
        };
      })
    ).toEqual({ phase: 'closed', scope: true });
    await expect(windows.b.locator('canvas').first()).toBeVisible();
    expect(writes).toEqual([]);
  } finally {
    await windows.close();
  }
});

test('S5客户端受控404：合法旧广播关闭同一源实例，B保留画面且后续零写', async ({ request }) => {
  const windows = await openChromeWindows();
  try {
    const a = await source(windows.a, request);
    await login(windows.b, request, 'native-404');
    const writes: string[] = [];
    windows.b.on('request', req => {
      if (taskPath(req.url())) {
        writes.push(req.method());
      }
    });
    await enter(windows.b, a.href);
    const original = await windows.a.evaluate(() => {
      const p = (window as unknown as NativeWindow).services.businessServices.localCollaboration!
        .participation!;
      return { id: p.identity.participant_id, phase: p.getSnapshot().phase };
    });
    expect(original.phase).toBe('active');
    let attempts = 0;
    // 这是客户端失效组合注入；后端重启的真实401/404在独立实例中另行取证。
    await windows.a.route('**/tasks/*/updated-at', async route => {
      attempts++;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'NOT_FOUND', message: '合成旧任务失效', details: {} },
        }),
      });
    });
    const denied = windows.a.waitForResponse(
      response => response.url().endsWith('/updated-at') && response.status() === 404
    );
    await windows.a.evaluate(() =>
      (window as unknown as NativeWindow).services.measurementService.clearMeasurements()
    );
    await denied;
    await expect
      .poll(() =>
        windows.a.evaluate(() => {
          const b = (window as unknown as NativeWindow).services.businessServices;
          const p = b.localCollaboration!.participation!;
          return {
            id: p.identity.participant_id,
            phase: p.getSnapshot().phase,
            project: b.projectRuntime!.getCurrent()!.phase,
          };
        })
      )
      .toEqual({ id: original.id, phase: 'closed', project: 'invalid' });
    await expect(windows.b.getByRole('status').filter({ hasText: '源窗口已离开' })).toBeVisible();
    await expect(windows.b.locator('canvas').first()).toBeVisible();
    await windows.a.evaluate(() =>
      (window as unknown as NativeWindow).services.measurementService.clearMeasurements()
    );
    await windows.a.waitForTimeout(300);
    expect(attempts).toBe(1);
    expect(writes).toEqual([]);
  } finally {
    await windows.close();
  }
});

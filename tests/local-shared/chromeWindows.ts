import { chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type NativeWindowsEvidence = {
  browser: string;
  profile: string;
  contextId: string;
  nonDefaultContexts: string[];
  windows: Array<{ targetId: string; windowId: number; state: string }>;
  headless: false;
  incognito: false;
  focusEmulationDisableRequested: true;
};
export type ChromeWindows = {
  context: BrowserContext;
  a: Page;
  b: Page;
  evidence: NativeWindowsEvidence;
  close(): Promise<void>;
};

/** 只创建和清理自己的合成测试个人资料；默认context＋真实windowId证明普通双窗。 */
export async function openChromeWindows(baseURL = 'http://localhost:3336'): Promise<ChromeWindows> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'colla-shared-chrome-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: false,
      baseURL,
      viewport: { width: 1440, height: 900 },
      args: ['--enable-unsafe-swiftshader'],
    });
    const browser = context.browser();
    if (!browser) {
      throw new Error('缺少持久Chrome浏览器实例');
    }
    const a = context.pages()[0] ?? (await context.newPage());
    for (const extra of context.pages().filter(page => page !== a)) {
      await extra.close();
    }
    const browserCDP = await browser.newBrowserCDPSession();
    const aCDP = await context.newCDPSession(a);
    const aInfo = (await aCDP.send('Target.getTargetInfo')).targetInfo;
    const nextPage = context.waitForEvent('page');
    const created = await browserCDP.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: false,
    });
    const b = await nextPage;
    const bCDP = await context.newCDPSession(b);
    const bInfo = (await bCDP.send('Target.getTargetInfo')).targetInfo;
    if (bInfo.targetId !== created.targetId || a.context() !== b.context()) {
      throw new Error('新窗口不属于同一持久context');
    }
    const contextIds = (await browserCDP.send('Target.getBrowserContexts')).browserContextIds;
    const firstContext = aInfo.browserContextId ?? 'default';
    if (
      firstContext !== (bInfo.browserContextId ?? 'default') ||
      contextIds.includes(firstContext)
    ) {
      throw new Error('两个页面不是同一普通默认个人资料');
    }
    const args = (await browserCDP.send('Browser.getBrowserCommandLine')).arguments;
    const actualProfile = args
      .find(arg => arg.startsWith('--user-data-dir='))
      ?.slice('--user-data-dir='.length);
    if (
      !actualProfile ||
      (await fs.realpath(actualProfile)) !== (await fs.realpath(profile)) ||
      args.some(arg => arg === '--incognito' || arg.startsWith('--headless'))
    ) {
      throw new Error('Chrome个人资料或普通有头启动参数不匹配');
    }
    const windows: NativeWindowsEvidence['windows'] = [];
    for (const targetId of [aInfo.targetId, bInfo.targetId]) {
      const { windowId } = await browserCDP.send('Browser.getWindowForTarget', { targetId });
      await browserCDP.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      });
      const { bounds } = await browserCDP.send('Browser.getWindowBounds', { windowId });
      windows.push({ targetId, windowId, state: bounds.windowState ?? 'normal' });
    }
    if (
      windows[0].windowId === windows[1].windowId ||
      windows.some(value => value.state !== 'normal')
    ) {
      throw new Error('未取得两个不同的普通原生窗口');
    }
    await aCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await bCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const evidence: NativeWindowsEvidence = {
      browser: browser.version(),
      profile,
      contextId: firstContext,
      nonDefaultContexts: contextIds,
      windows,
      headless: false,
      incognito: false,
      focusEmulationDisableRequested: true,
    };
    let closed = false;
    const owned = context;
    return {
      context,
      a,
      b,
      evidence,
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await owned.close();
        } finally {
          await fs.rm(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      await fs.rm(profile, { recursive: true, force: true });
    }
    throw error;
  }
}

/** 激活目标窗口后，从视口外开始新的移动；本方法不证明其他窗口收到blur。 */
export async function activateChromeWindow(page: Page): Promise<void> {
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  await page.mouse.move(0, 0);
  await page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

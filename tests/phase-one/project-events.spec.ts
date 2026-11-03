import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  BusinessServices,
  BusinessTask,
  ProjectEventService,
  LocalProject,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from './syntheticDicom';

export type ProjectTestWindow = Window & {
  eventAudit?: {
    count: number;
    events?: Array<{ event: string; task_id?: string }>;
    stop(): void;
  };
  oldProject?: LocalProject;
  services: {
    businessServices: BusinessServices;
    measurementService: Omit<ProjectEventService, 'getMeasurements'> & {
      getMeasurements(): Array<{ uid: string }>;
      jumpToMeasurement(viewportId: string, uid: string): void;
    };
    segmentationService: Omit<ProjectEventService, 'getSegmentations'> & {
      getSegmentations(): Array<{ segmentationId: string }>;
      getSegmentationRepresentations(
        viewportId: string,
        value: { segmentationId: string; type: string }
      ): Array<{ visible: boolean; segments: Record<string, { visible: boolean }> }>;
      toggleSegmentationRepresentationVisibility(
        viewportId: string,
        value: { segmentationId: string; type: string }
      ): void;
    };
    viewportGridService: { getActiveViewportId(): string };
    toolGroupService: {
      getToolGroupForViewport(id: string):
        | {
            id: string;
            hasTool(name: string): boolean;
            addTool(name: string): void;
            getActivePrimaryMouseButtonTool(): string;
          }
        | undefined;
    };
    cornerstoneViewportService: {
      getCornerstoneViewport(id: string): {
        type: string;
        element: HTMLElement;
        getImageData(): { imageData: unknown } | undefined;
      };
    };
  };
  commandsManager: { run(command: string, options?: Record<string, unknown>): unknown };
};
const touchPath = (url: string) =>
  /^\/api\/v1\/teams\/[^/]+\/tasks\/[^/]+\/updated-at$/.test(new URL(url).pathname);
async function enter(page: Page, request: APIRequestContext): Promise<BusinessTask> {
  const username = `events-${randomUUID().slice(0, 8)}`,
    password = 'synthetic-password';
  expect((await request.post('/api/v1/users', { data: { username, password } })).status()).toBe(
    201
  );
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/team\/tasks$/);
  await page.goto('/local-mask');
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  const registered = page.waitForResponse(
    response =>
      response.request().method() === 'POST' && /\/tasks$/.test(new URL(response.url()).pathname)
  );
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(syntheticSeries().files);
  const response = await registered;
  expect(response.status()).toBe(201);
  const task: BusinessTask = (await response.json()).data;
  await expect(page.locator('.cornerstone-viewport-element').first()).toBeVisible();
  return task;
}
async function measure(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as ProjectTestWindow).services;
        const id = s.viewportGridService.getActiveViewportId();
        const viewport = s.cornerstoneViewportService.getCornerstoneViewport(id);
        return Boolean(
          viewport?.getImageData()?.imageData && s.toolGroupService.getToolGroupForViewport(id)
        );
      })
    )
    .toBe(true);
  const before = await page.evaluate(() => {
    const w = window as unknown as ProjectTestWindow;
    const s = w.services;
    const group = s.toolGroupService.getToolGroupForViewport(
      s.viewportGridService.getActiveViewportId()
    );
    // 测试会话夹具：Length已由生产初始化全局注册，仅加入当前segmentation工具组。
    // 保持生产模式配置、原生annotation事件映射和业务响应原样。
    if (!group.hasTool('Length')) {
      group.addTool('Length');
    }
    w.commandsManager.run('setToolActiveToolbar', {
      toolName: 'Length',
      toolGroupIds: [group.id],
    });
    return s.measurementService.getMeasurements().length;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as ProjectTestWindow).services;
        const group = s.toolGroupService.getToolGroupForViewport(
          s.viewportGridService.getActiveViewportId()
        );
        return {
          registered: group?.hasTool('Length'),
          active: group?.getActivePrimaryMouseButtonTool(),
        };
      })
    )
    .toEqual({ registered: true, active: 'Length' });
  const box = await page.evaluate(() => {
    const s = (window as unknown as ProjectTestWindow).services;
    const rect = s.cornerstoneViewportService
      .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
      .element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as ProjectTestWindow).services.measurementService.getMeasurements()
            .length
      )
    )
    .toBeGreaterThan(before);
}
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

async function startEventAudit(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as ProjectTestWindow;
    const audit: ProjectTestWindow['eventAudit'] = { count: 0, events: [], stop: () => {} };
    const subscriptions = [w.services.measurementService, w.services.segmentationService].flatMap(
      service =>
        [...new Set(Object.values(service.EVENTS))].map(event =>
          service.subscribe(event, () => {
            audit.count++;
            audit.events.push({
              event,
              task_id: w.services.businessServices.projectRuntime.getCurrent()?.task_id,
            });
          })
        )
    );
    audit.stop = () => subscriptions.forEach(item => item.unsubscribe());
    w.eventAudit = audit;
  });
}

test('真实测量／分割与展示动作逐事件写时间，退出无销毁写入，再导入不叠加旧桥接', async ({
  page,
  request,
}) => {
  const task = await enter(page, request);
  const written: Array<{ task_id: string; updated_at: string }> = [];
  const touchRequests: string[] = [];
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  await startEventAudit(page);
  page.on('request', request => {
    if (touchPath(request.url())) {
      touchRequests.push(new URL(request.url()).pathname);
    }
  });
  page.on('response', response => {
    if (!touchPath(response.url())) {
      return;
    }
    const reading = (async () => {
      expect(response.request().method()).toBe('PATCH');
      expect(response.request().postDataJSON()).toEqual({});
      expect(response.status()).toBe(200);
      written.push((await response.json()).data);
    })();
    pending.add(reading);
    void reading.catch(error => failures.push(error)).finally(() => pending.delete(reading));
  });
  await measure(page);
  await expect.poll(() => written.length).toBeGreaterThan(0);
  const beforeJump = written.length;
  await page.evaluate(() => {
    const s = (window as unknown as ProjectTestWindow).services;
    s.measurementService.jumpToMeasurement(
      s.viewportGridService.getActiveViewportId(),
      s.measurementService.getMeasurements()[0].uid
    );
  });
  await expect.poll(() => written.length).toBeGreaterThan(beforeJump);
  await page.locator('[data-cy="addSegmentation"]').click();
  await expect(page.getByRole('button', { name: '应用阈值到整组切片', exact: true })).toBeEnabled();
  const beforeMask = written.length;
  await page.getByRole('button', { name: '应用阈值到整组切片', exact: true }).click();
  await expect(page.locator('section[aria-label="Mask 编辑"]').getByRole('status')).toContainText(
    '阈值选区完成'
  );
  await expect.poll(() => written.length).toBeGreaterThan(beforeMask);
  const beforeDisplay = written.length;
  await page.evaluate(() => {
    const s = (window as unknown as ProjectTestWindow).services;
    s.segmentationService.toggleSegmentationRepresentationVisibility(
      s.viewportGridService.getActiveViewportId(),
      {
        segmentationId: s.segmentationService.getSegmentations()[0].segmentationId,
        type: 'Labelmap',
      }
    );
  });
  await expect.poll(() => written.length).toBeGreaterThan(beforeDisplay);
  await expect
    .poll(
      async () =>
        written.length ===
        (await page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.count))
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await page.evaluate(
          () =>
            (
              window as unknown as ProjectTestWindow
            ).services.businessServices.projectRuntime.getCurrent().updated_at
        )) === written.at(-1)?.updated_at
    )
    .toBe(true);
  expect(failures).toEqual([]);
  const current = await page.evaluate(() => {
    const p = (
      window as unknown as ProjectTestWindow
    ).services.businessServices.projectRuntime.getCurrent();
    return { id: p.task_id, title: p.title };
  });
  expect(current).toEqual({ id: task.task_id, title: task.title });
  for (let n = 0; n < written.length; n++) {
    expect(written[n].task_id).toBe(task.task_id);
    expect(Date.parse(written[n].updated_at)).toBeGreaterThan(
      Date.parse(n ? written[n - 1].updated_at : task.updated_at)
    );
  }
  await Promise.all([...pending]);
  await page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.stop());
  const beforeExit = written.length;
  const requestsBeforeExit = touchRequests.length;
  await page.goBack();
  await expect(page).toHaveURL(/\/local-mask$/);
  await frames(page);
  expect(written).toHaveLength(beforeExit);
  expect(touchRequests).toHaveLength(requestsBeforeExit);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProjectTestWindow).services.businessServices.projectRuntime.getCurrent()
    )
  ).toBeNull();
  // 同页面再次真实导入产生新task，旧task不再接收请求。
  // 在选择文件前订阅，覆盖beginMode之后的初始化清空／加载广播；网络审计持续保留。
  await startEventAudit(page);
  const second = page.waitForResponse(
    response =>
      response.request().method() === 'POST' && /\/tasks$/.test(new URL(response.url()).pathname)
  );
  await page.getByLabel('导入文件', { exact: true }).setInputFiles(syntheticSeries().files);
  const secondResponse = await second;
  expect(secondResponse.status()).toBe(201);
  const next: BusinessTask = (await secondResponse.json()).data;
  expect(next.task_id).toBeTruthy();
  expect(next.task_id).not.toBe(task.task_id);
  await expect(page.locator('.cornerstone-viewport-element').first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = (window as unknown as ProjectTestWindow).services;
        return Boolean(
          s.cornerstoneViewportService
            .getCornerstoneViewport(s.viewportGridService.getActiveViewportId())
            ?.getImageData()?.imageData
        );
      })
    )
    .toBe(true);
  const expectNextUpdates = async (eventsBefore: number) => {
    await expect
      .poll(async () => {
        const count = await page.evaluate(
          () => (window as unknown as ProjectTestWindow).eventAudit.count
        );
        return (
          count > eventsBefore &&
          touchRequests.length - requestsBeforeExit === count &&
          written.length - beforeExit === count &&
          pending.size === 0
        );
      })
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const p = (
            window as unknown as ProjectTestWindow
          ).services.businessServices.projectRuntime.getCurrent();
          return { id: p.task_id, title: p.title, time: p.updated_at };
        })
      )
      .toEqual({ id: next.task_id, title: next.title, time: written.at(-1).updated_at });
    expect(failures).toEqual([]);
    const events = await page.evaluate(
      () => (window as unknown as ProjectTestWindow).eventAudit.events
    );
    const nextWrites = written.slice(beforeExit);
    expect(events).toHaveLength(touchRequests.length - requestsBeforeExit);
    expect(events).toHaveLength(nextWrites.length);
    expect(events.every(item => item.task_id === next.task_id)).toBe(true);
    for (let n = 0; n < nextWrites.length; n++) {
      expect(nextWrites[n].task_id).toBe(next.task_id);
      expect(Date.parse(nextWrites[n].updated_at)).toBeGreaterThan(
        Date.parse(n ? nextWrites[n - 1].updated_at : next.updated_at)
      );
    }
    expect(
      touchRequests
        .slice(requestsBeforeExit)
        .every(path => path === `/api/v1/teams/${next.team_id}/tasks/${next.task_id}/updated-at`)
    ).toBe(true);
    return events;
  };
  // 原生初始化不产生标注更新时间写入；就绪后重新建立动作审计基线。
  await frames(page);
  expect(written).toHaveLength(beforeExit);
  expect(touchRequests).toHaveLength(requestsBeforeExit);
  await page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.stop());
  await startEventAudit(page);
  // 再导入用现有分割／展示能力验桥接；不激活Length或复位原生交互状态。
  await page.locator('[data-cy="addSegmentation"]').click();
  await expect(page.getByRole('button', { name: '应用阈值到整组切片', exact: true })).toBeEnabled();
  const created = await expectNextUpdates(0);
  expect(created.slice(0)).toContainEqual({
    event: await page.evaluate(
      () =>
        (window as unknown as ProjectTestWindow).services.segmentationService.EVENTS
          .SEGMENTATION_ADDED
    ),
    task_id: next.task_id,
  });
  const segmentationIds = await page.evaluate(() =>
    (window as unknown as ProjectTestWindow).services.segmentationService
      .getSegmentations()
      .map(segmentation => segmentation.segmentationId)
  );
  expect(segmentationIds).toHaveLength(1);
  let auditedCount = created.length;
  for (const visible of [false, true]) {
    const result = await page.evaluate(segmentationId => {
      const w = window as unknown as ProjectTestWindow;
      const s = w.services;
      const viewportId = s.viewportGridService.getActiveViewportId();
      const specifier = { segmentationId, type: 'Labelmap' };
      const before = s.segmentationService.getSegmentationRepresentations(viewportId, specifier)[0];
      const previousVisibility = before.visible;
      const eventsBefore = w.eventAudit.count;
      // 与面板显隐按钮相同的原生服务动作，由Cornerstone真实状态变更发出事件。
      s.segmentationService.toggleSegmentationRepresentationVisibility(viewportId, specifier);
      const after = s.segmentationService.getSegmentationRepresentations(viewportId, specifier)[0];
      return {
        previousVisibility,
        visible: after.visible,
        segments: Object.values(after.segments).map(segment => segment.visible),
        events: w.eventAudit.count - eventsBefore,
      };
    }, segmentationIds[0]);
    expect(result.previousVisibility).toBe(!visible);
    expect(result.visible).toBe(visible);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments.every(value => value === visible)).toBe(true);
    expect(result.events).toBe(1);
    const displayed = await expectNextUpdates(auditedCount);
    expect(displayed).toHaveLength(auditedCount + 1);
    expect(displayed.at(-1)).toEqual({
      event: await page.evaluate(
        () =>
          (window as unknown as ProjectTestWindow).services.segmentationService.EVENTS
            .SEGMENTATION_REPRESENTATION_MODIFIED
      ),
      task_id: next.task_id,
    });
    auditedCount = displayed.length;
  }
  await page.evaluate(() => (window as unknown as ProjectTestWindow).eventAudit.stop());
  const afterReentry = { requests: touchRequests.length, responses: written.length };
  await page.goBack();
  await expect(page).toHaveURL(/\/local-mask$/);
  await frames(page);
  expect(touchRequests).toHaveLength(afterReentry.requests);
  expect(written).toHaveLength(afterReentry.responses);
  expect(failures).toEqual([]);
  expect(
    await page.evaluate(() =>
      (window as unknown as ProjectTestWindow).services.businessServices.projectRuntime.getCurrent()
    )
  ).toBeNull();
});

test('真实touch已提交后延迟交付，退出中止且晚响应不更新旧project', async ({ page, request }) => {
  await enter(page, request);
  const oldTime = await page.evaluate(() => {
    const w = window as unknown as ProjectTestWindow;
    w.oldProject = w.services.businessServices.projectRuntime.getCurrent();
    return w.oldProject.updated_at;
  });
  let committed: () => void,
    deliver: () => void,
    attempts = 0;
  const accepted = new Promise<void>(resolve => {
    committed = resolve;
  });
  const delayed = new Promise<void>(resolve => {
    deliver = resolve;
  });
  await page.route('**/tasks/*/updated-at', async route => {
    attempts++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed();
    await delayed;
    await route.fulfill({ response }).catch(() => {}); // 退出Abort后浏览器可能已关闭这次请求。
  });
  try {
    await measure(page);
    await accepted;
    await page.goBack();
    await expect(page).toHaveURL(/\/local-mask$/);
    deliver();
    await frames(page);
    expect(attempts).toBe(1);
    expect(
      await page.evaluate(() => {
        const w = window as unknown as ProjectTestWindow;
        return {
          phase: w.oldProject.phase,
          time: w.oldProject.updated_at,
          current: w.services.businessServices.projectRuntime.getCurrent(),
        };
      })
    ).toEqual({ phase: 'registered', time: oldTime, current: null });
  } finally {
    deliver();
  }
});

test('真实撤销业务会话后touch401清身份和桥接，标注页保留且不强跳', async ({ page, request }) => {
  await enter(page, request);
  const token = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('colla.phaseOne.session')!).token as string
  );
  expect(
    (
      await request.delete('/api/v1/auth/sessions/current', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status()
  ).toBe(204);
  const denied = page.waitForResponse(
    response => touchPath(response.url()) && response.status() === 401
  );
  const before = page.url();
  await measure(page);
  await denied;
  await expect(page.getByRole('alert').filter({ hasText: '业务身份已失效' })).toBeVisible();
  expect(page.url()).toBe(before);
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as ProjectTestWindow).services.businessServices.projectRuntime.getCurrent()
    )
  ).toBeNull();
});

for (const status of [403, 404]) {
  test(`客户端注入${status}后旧project停止桥接，刷新不伪恢复`, async ({ page, request }) => {
    await enter(page, request);
    let attempts = 0;
    await page.route('**/tasks/*/updated-at', async route => {
      attempts++;
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'DENIED', message: '合成失效边界', details: {} } }),
      });
    });
    const url = page.url();
    await measure(page);
    await expect(page.getByRole('status').filter({ hasText: '当前项目已失效' })).toBeVisible();
    expect(attempts).toBe(1);
    expect(page.url()).toBe(url);
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: '请重新导入' })).toBeVisible();
    await frames(page);
    expect(attempts).toBe(1);
  });
}

test('A联合B：读取真实成员及发送合成协作邀请不触发项目时间', async ({ page, request }) => {
  await enter(page, request);
  let touches = 0;
  page.on('request', req => {
    if (touchPath(req.url())) {
      touches++;
    }
  });
  await expect(page.getByRole('button', { name: '通知', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '任务成员', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '任务成员', exact: true }).getByText('Owner', { exact: true })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '邀请', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '邀请他人协作' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: /^邀请.+/ })
    .filter({ hasText: '邀请他' })
    .first()
    .click();
  await expect(
    dialog.getByRole('button', { name: /^邀请.+/ }).filter({ hasText: '已邀请' })
  ).toHaveCount(1);
  await frames(page);
  expect(touches).toBe(0);
});

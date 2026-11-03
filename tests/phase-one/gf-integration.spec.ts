import { test, expect, chromium, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  BusinessServices,
  BusinessTask,
  IssuedBusinessSession,
  InvitationView,
  MemberView,
  ProjectEventService,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from './syntheticDicom';

type GFWindow = Window & {
  gfAudit: { events: Array<{ event: string; task_id?: string }>; stop(): void };
  services: {
    businessServices: BusinessServices;
    measurementService: ProjectEventService;
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
  };
};
const password = 'phase-one-gf-synthetic';
const storageKey = 'colla.phaseOne.session';
const touchPath = (url: string) =>
  /^\/api\/v1\/teams\/[^/]+\/tasks\/[^/]+\/updated-at$/.test(new URL(url).pathname);
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
async function credentials(page: Page, username: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
}
async function identity(page: Page): Promise<IssuedBusinessSession> {
  const token: string = await page.evaluate(
    key => JSON.parse(sessionStorage.getItem(key)!).token,
    storageKey
  );
  const current = await page.request.get('/api/v1/auth/sessions/current', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(current.status()).toBe(200);
  return { ...(await current.json()).data, token };
}

test('GF：两个独立Chromium进程完成真实邀请→导入→事件更新，验证隔离、mock与退出', async ({
  page,
  request,
  baseURL,
}) => {
  // 第二次launch创建独立浏览器进程；两个进程使用同一个专用后端，没有多引擎替代声明。
  const otherBrowser = await chromium.launch();
  try {
    const receiver = await otherBrowser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
    });
    const receiverPage = await receiver.newPage();
    const ownerName = `gf-owner-${randomUUID()}`;
    const recipientName = `gf-recipient-${randomUUID()}`;
    const register = async (username: string): Promise<IssuedBusinessSession> => {
      const response = await request.post('/api/v1/users', { data: { username, password } });
      expect(response.status()).toBe(201);
      return (await response.json()).data;
    };
    const recipient = await register(recipientName);
    const outsider = await register(`gf-outsider-${randomUUID()}`);
    await page.goto('/account/register');
    await credentials(page, ownerName);
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page).toHaveURL(/\/account\/invite$/);
    await expect(page.getByText(/邀请入队：/)).toBeVisible();
    const owner = await identity(page);
    const members = async (): Promise<MemberView[]> => {
      const response = await request.get(`/api/v1/teams/${owner.default_team_id}/members`, {
        headers: { Authorization: `Bearer ${owner.token}` },
        params: { page: 1, page_size: 100 },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data;
    };
    await page.getByLabel('输入他的用户名').fill(recipientName);
    const sent = page.waitForResponse(
      r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/invitations')
    );
    await page.getByRole('button', { name: '完成', exact: true }).click();
    const invitationResponse = await sent;
    expect(invitationResponse.status()).toBe(201);
    const invitation: InvitationView = (await invitationResponse.json()).data;
    await expect(page).toHaveURL(/\/team\/tasks$/);
    await page.goto('/local-mask');
    expect((await members()).some(item => item.uid === recipient.user.uid)).toBe(false);

    await receiverPage.goto('/account/login');
    expect(await receiverPage.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
    await credentials(receiverPage, recipientName);
    await receiverPage.getByRole('button', { name: '登录', exact: true }).click();
    await expect(receiverPage).toHaveURL(/\/team\/tasks$/);
    await receiverPage.goto('/local-mask');
    const recipientSession = await identity(receiverPage);
    expect(recipientSession.user.uid).toBe(recipient.user.uid);
    expect(recipientSession.token === owner.token).toBe(false);
    await receiverPage.getByRole('button', { name: '通知', exact: true }).click();
    const row = receiverPage.getByRole('article', { name: `入队邀请 ${invitation.team_name}` });
    await expect(row).toContainText(ownerName);
    await row.getByRole('button', { name: '接受', exact: true }).click();
    await expect(row).toContainText('已接受');
    expect((await members()).filter(item => item.uid === recipient.user.uid)).toEqual([
      expect.objectContaining({ role: 'annotator', uid: recipient.user.uid }),
    ]);
    expect((await identity(receiverPage)).memberships).toContainEqual(
      expect.objectContaining({ team_id: owner.default_team_id, role: 'annotator' })
    );
    expect((await identity(page)).user.uid).toBe(owner.user.uid);

    const touches: string[] = [];
    const written: Array<{ task_id: string; updated_at: string }> = [];
    const pending = new Set<Promise<void>>();
    const errors: unknown[] = [];
    let otherWrites = 0;
    page.on('request', r => {
      if (touchPath(r.url())) {
        touches.push(new URL(r.url()).pathname);
      } else if (/^\/api\/v1\//.test(new URL(r.url()).pathname) && r.method() !== 'GET') {
        otherWrites++;
      }
    });
    page.on('response', r => {
      if (!touchPath(r.url())) {
        return;
      }
      const reading = (async () => {
        expect(r.status()).toBe(200);
        expect(r.request().method()).toBe('PATCH');
        expect(r.request().postDataJSON()).toEqual({});
        written.push((await r.json()).data);
      })();
      pending.add(reading);
      void reading.catch(error => errors.push(error)).finally(() => pending.delete(reading));
    });
    // 从选文件之前开始，初始化广播也是新Task的合法事件。
    await page.evaluate(() => {
      const w = window as unknown as GFWindow;
      const audit: GFWindow['gfAudit'] = { events: [], stop: () => {} };
      const subscriptions = [w.services.measurementService, w.services.segmentationService].flatMap(
        service =>
          [...new Set(Object.values(service.EVENTS))].map(event =>
            service.subscribe(event, () => {
              audit.events.push({
                event,
                task_id: w.services.businessServices.projectRuntime.getCurrent()?.task_id,
              });
            })
          )
      );
      audit.stop = () => subscriptions.forEach(subscription => subscription.unsubscribe());
      w.gfAudit = audit;
    });
    await page.addLocatorHandler(
      page.getByRole('button', { name: 'Confirm and hide', exact: true }),
      l => l.click()
    );
    const sample = syntheticSeries();
    sample.files[0].name = 'GF首个成功.dcm';
    const registered = page.waitForResponse(
      r => r.request().method() === 'POST' && /\/tasks$/.test(new URL(r.url()).pathname)
    );
    const files = [
      ...sample.files,
      {
        name: 'GF坏.dcm',
        mimeType: 'application/dicom',
        buffer: Buffer.from('invalid-synthetic-dicom'),
      },
    ];
    await page.getByLabel('导入文件', { exact: true }).setInputFiles(files);
    const response = await registered;
    expect(response.status()).toBe(201);
    const task: BusinessTask = (await response.json()).data;
    expect(task).toEqual(
      expect.objectContaining({
        task_id: expect.any(String),
        team_id: owner.default_team_id,
        assignee_uid: owner.user.uid,
        title: 'GF首个成功.dcm',
        metadata: {},
      })
    );
    expect(task.task_id).toBeTruthy();
    expect(response.request().postDataJSON()).toEqual({ title: 'GF首个成功.dcm' });
    await expect(page).toHaveURL(new RegExp(`StudyInstanceUIDs=${sample.study}`));
    await expect(page.locator('.cornerstone-viewport-element').first()).toBeVisible();
    const auditUpdates = async (minimum: number) => {
      await expect
        .poll(async () => {
          const events = await page.evaluate(() => (window as unknown as GFWindow).gfAudit.events);
          return (
            events.length > minimum &&
            events.length === touches.length &&
            events.length === written.length &&
            pending.size === 0
          );
        })
        .toBe(true);
      expect(errors).toEqual([]);
      const events = await page.evaluate(() => (window as unknown as GFWindow).gfAudit.events);
      expect(events.every(event => event.task_id === task.task_id)).toBe(true);
      expect(
        touches.every(
          path => path === `/api/v1/teams/${task.team_id}/tasks/${task.task_id}/updated-at`
        )
      ).toBe(true);
      for (let n = 0; n < written.length; n++) {
        expect(written[n].task_id).toBe(task.task_id);
        expect(Date.parse(written[n].updated_at)).toBeGreaterThan(
          Date.parse(n ? written[n - 1].updated_at : task.updated_at)
        );
      }
      await expect
        .poll(() =>
          page.evaluate(() => {
            const p = (
              window as unknown as GFWindow
            ).services.businessServices.projectRuntime.getCurrent();
            return { task_id: p.task_id, title: p.title, time: p.updated_at };
          })
        )
        .toEqual({ task_id: task.task_id, title: task.title, time: written.at(-1).updated_at });
      return events.length;
    };
    // 模式初始化和恢复不再是用户编辑；只审计就绪后的真实动作。
    await frames(page);
    await page.evaluate(() => {
      (window as unknown as GFWindow).gfAudit.events = [];
    });
    let count = 0;
    await page.locator('[data-cy="addSegmentation"]').click();
    await expect(
      page.getByRole('button', { name: '应用阈值到整组切片', exact: true })
    ).toBeEnabled();
    count = await auditUpdates(count);
    for (const visible of [false, true]) {
      const actual = await page.evaluate(() => {
        const s = (window as unknown as GFWindow).services;
        const viewportId = s.viewportGridService.getActiveViewportId();
        const value = {
          segmentationId: s.segmentationService.getSegmentations()[0].segmentationId,
          type: 'Labelmap',
        };
        s.segmentationService.toggleSegmentationRepresentationVisibility(viewportId, value);
        const state = s.segmentationService.getSegmentationRepresentations(viewportId, value)[0];
        return {
          visible: state.visible,
          segments: Object.values(state.segments).map(item => item.visible),
        };
      });
      expect(actual.visible).toBe(visible);
      expect(actual.segments.length).toBeGreaterThan(0);
      expect(actual.segments.every(value => value === visible)).toBe(true);
      count = await auditUpdates(count);
    }
    const before = {
      requests: touches.length,
      responses: written.length,
      otherWrites,
      url: page.url(),
    };
    await expect(page.getByRole('button', { name: '通知', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '任务成员', exact: true }).click();
    await expect(
      page
        .getByRole('dialog', { name: '任务成员', exact: true })
        .getByText('Owner', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '邀请', exact: true }).click();
    const mock = page.getByRole('dialog', { name: '邀请他人协作' });
    await mock
      .getByRole('button', { name: /^邀请.+/ })
      .filter({ hasText: '邀请他' })
      .first()
      .click();
    await expect(
      mock.getByRole('button', { name: /^邀请.+/ }).filter({ hasText: '已邀请' })
    ).toHaveCount(1);
    await frames(page);
    expect({
      requests: touches.length,
      responses: written.length,
      otherWrites,
      url: page.url(),
    }).toEqual(before);
    expect((await members()).filter(item => item.uid === recipient.user.uid)).toHaveLength(1);
    await page.evaluate(() => (window as unknown as GFWindow).gfAudit.stop());
    await page.goBack();
    await expect(page).toHaveURL(/\/local-mask$/);
    await frames(page);
    expect(touches).toHaveLength(before.requests);
    expect(written).toHaveLength(before.responses);
    expect(
      await page.evaluate(() =>
        (window as unknown as GFWindow).services.businessServices.projectRuntime.getCurrent()
      )
    ).toBeNull();

    const path = `/api/v1/teams/${task.team_id}/tasks/${task.task_id}/updated-at`;
    const patch = (token: string) =>
      request.patch(path, { headers: { Authorization: `Bearer ${token}` }, data: {} });
    expect((await patch(recipientSession.token)).status()).toBe(403);
    expect((await patch(outsider.token)).status()).toBe(404);
    // 同一账号在第二浏览器重新真实登录，新Token可访问同实例Task；不复制任何浏览器存储。
    const sameOwner = await otherBrowser.newContext({ baseURL });
    const sameOwnerPage = await sameOwner.newPage();
    await sameOwnerPage.goto('/account/login');
    expect(await sameOwnerPage.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
    await credentials(sameOwnerPage, ownerName);
    await sameOwnerPage.getByRole('button', { name: '登录', exact: true }).click();
    await expect(sameOwnerPage).toHaveURL(/\/team\/tasks$/);
    const secondOwner = await identity(sameOwnerPage);
    expect(secondOwner.user.uid).toBe(owner.user.uid);
    expect(secondOwner.default_team_id).toBe(owner.default_team_id);
    expect(secondOwner.token === owner.token).toBe(false);
    const shared = await sameOwnerPage.request.patch(path, {
      headers: { Authorization: `Bearer ${secondOwner.token}` },
      data: {},
    });
    expect(shared.status()).toBe(200);
    const changed = (await shared.json()).data;
    expect(changed.task_id).toBe(task.task_id);
    expect(Date.parse(changed.updated_at)).toBeGreaterThan(Date.parse(written.at(-1).updated_at));
  } finally {
    await otherBrowser.close();
  }
});

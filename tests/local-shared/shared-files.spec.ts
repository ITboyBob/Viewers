import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import type {
  BusinessServices,
  SharedFileBundle,
} from '../../platform/core/src/types/BusinessContracts';
import { syntheticSeries } from '../phase-one/syntheticDicom';

type SharedWindow = Window & { services: { businessServices: BusinessServices } };

test('G1/G2：真实登记、原生IDB事务与BC两阶段参与、配色及失效', async ({ page, request }) => {
  const username = `shared-${randomUUID().slice(0, 8)}`,
    password = 'local-shared-synthetic';
  expect((await request.post('/api/v1/users', { data: { username, password } })).status()).toBe(
    201
  );
  await page.goto('/account/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/local-mask$/);
  await page.addLocatorHandler(
    page.getByRole('button', { name: 'Confirm and hide', exact: true }),
    locator => locator.click()
  );
  const sample = syntheticSeries(3);
  const registered = page.waitForResponse(
    response =>
      response.request().method() === 'POST' && /\/tasks$/.test(new URL(response.url()).pathname)
  );
  await page
    .getByLabel('导入文件', { exact: true })
    .setInputFiles([
      sample.files[0],
      { name: '坏.dcm', mimeType: 'application/dicom', buffer: Buffer.from('invalid') },
      ...sample.files.slice(1),
    ]);
  const response = await registered;
  expect(response.status()).toBe(201);
  const task = (await response.json()).data;
  await expect(page.locator('.cornerstone-viewport-element').first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as SharedWindow
          ).services.businessServices.localCollaboration?.identities
            .getSource()
            ?.getSnapshot().publication_phase
      )
    )
    .toBe('ready');
  const actual = await page.evaluate(async () => {
    const shared = (window as unknown as SharedWindow).services.businessServices
      .localCollaboration!;
    const source = shared.identities.getSource()!;
    const bundle = await shared.files!.read(
      source.task_id,
      source.batch_id,
      source.identity.participant_id,
      new AbortController().signal
    );
    const digests = await Promise.all(
      bundle.files.map(async file =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer()))
        )
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('')
      )
    );
    return { manifest: bundle.manifest, digests };
  });
  expect(actual.manifest.task_id).toBe(task.task_id);
  expect(actual.manifest.title).toBe(sample.files[0].name);
  expect(actual.manifest.files.map(file => file.selection_index)).toEqual([0, 2, 3]);
  expect(actual.digests).toEqual(
    sample.files.map(file => createHash('sha256').update(file.buffer).digest('hex'))
  );
  expect(Object.keys(actual.manifest).sort()).toEqual([
    'batch_id',
    'cache_state',
    'cache_version',
    'files',
    'importer_uid',
    'mode_path',
    'source_participant_id',
    'task_id',
    'team_id',
    'title',
  ]);

  const native = await page.evaluate(async () => {
    const shared = (window as unknown as SharedWindow).services.businessServices
      .localCollaboration!;
    const source = shared.identities.getSource()!;
    const store = shared.files!;
    const original = await store.read(
      source.task_id,
      source.batch_id,
      source.identity.participant_id,
      new AbortController().signal
    );
    const fixture = (suffix: string): SharedFileBundle => ({
      manifest: {
        ...original.manifest,
        task_id: `transaction-${suffix}`,
        batch_id: `batch-${suffix}`,
      },
      files: original.files.map(file => ({ ...file, batch_id: `batch-${suffix}` })),
    });
    const code = async (operation: Promise<unknown>) => {
      try {
        await operation;
        return 'resolved';
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    const controller = new AbortController();
    const nativeAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      const result = nativeAdd.apply(this, args);
      if (this.name === 'manifests') {
        controller.abort();
      }
      return result;
    };
    let aborted: string;
    try {
      aborted = await code(store.publish(fixture('aborted'), controller.signal));
    } finally {
      IDBObjectStore.prototype.add = nativeAdd;
    }
    const absent = await code(
      store.read(
        'transaction-aborted',
        'batch-aborted',
        source.identity.participant_id,
        new AbortController().signal
      )
    );
    const conflict = await code(
      store.publish(
        { ...original, manifest: { ...original.manifest, source_participant_id: 'other-source' } },
        new AbortController().signal
      )
    );
    const again = await store.publish(original, new AbortController().signal);
    IDBObjectStore.prototype.add = function () {
      throw new DOMException('受控配额错误', 'QuotaExceededError');
    };
    let quota: string;
    try {
      quota = await code(store.publish(fixture('quota'), new AbortController().signal));
    } finally {
      IDBObjectStore.prototype.add = nativeAdd;
    }
    return {
      aborted,
      absent,
      conflict,
      quota,
      same: again.task_id === source.task_id,
      phase: shared.identities.getSource()!.getSnapshot().publication_phase,
      projectPhase: (
        window as unknown as SharedWindow
      ).services.businessServices.projectRuntime!.getCurrent()!.phase,
    };
  });
  expect(native).toEqual({
    aborted: 'cancelled',
    absent: 'cache_invalid',
    conflict: 'context_conflict',
    quota: 'quota_exceeded',
    same: true,
    phase: 'ready',
    projectPhase: 'registered',
  });

  const viewer = await page.context().newPage();
  const viewerName = `viewer-${randomUUID().slice(0, 8)}`;
  expect(
    (await request.post('/api/v1/users', { data: { username: viewerName, password } })).status()
  ).toBe(201);
  await viewer.goto('/account/login');
  await viewer.getByLabel('用户名').fill(viewerName);
  await viewer.getByLabel('密码', { exact: true }).fill(password);
  await viewer.getByRole('button', { name: '登录', exact: true }).click();
  await expect(viewer).toHaveURL(/\/local-mask$/);
  const viewerWrites: string[] = [];
  viewer.on('request', req => {
    if (/\/tasks(?:\/|$)/.test(new URL(req.url()).pathname)) {
      viewerWrites.push(req.method());
    }
  });
  let sourceChecks = 0;
  page.on('response', res => {
    if (new URL(res.url()).pathname.endsWith('/auth/sessions/current')) {
      sourceChecks++;
    }
  });
  const joined = await viewer.evaluate(async taskId => {
    const shared = (window as unknown as SharedWindow).services.businessServices
      .localCollaboration!;
    const participation = shared.createViewerParticipation!(taskId);
    const loading = await participation.join('loading');
    const bundle = await shared.files!.read(
      taskId,
      loading.batch_id,
      loading.source_participant_id,
      new AbortController().signal
    );
    const active = await participation.join('active');
    return {
      source: loading.source_participant_id,
      batch: bundle.manifest.batch_id,
      loadingMembers: loading.members.length,
      members: active.members.length,
      self: participation.identity.user.uid,
      participant: participation.identity.participant_id,
      colors: active.color_registry,
      phase: participation.getSnapshot().phase,
    };
  }, task.task_id);
  expect(joined.source).toBe(actual.manifest.source_participant_id);
  expect(joined.batch).toBe(actual.manifest.batch_id);
  expect(joined.loadingMembers).toBe(1);
  expect(joined.members).toBe(2);
  expect(joined.self).not.toBe(actual.manifest.importer_uid);
  expect(joined.phase).toBe('active');
  expect(joined.colors.assignments.map(value => value.color_value)).toEqual(['#2563EB', '#C2410C']);
  // 故意保持view_ready=false超过15秒：active必须已经开始真实心跳。
  await viewer.waitForTimeout(16050);
  expect(
    await viewer.evaluate(
      () =>
        (
          window as unknown as SharedWindow
        ).services.businessServices.localCollaboration!.participation!.getSnapshot().phase
    )
  ).toBe('active');
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as SharedWindow
        ).services.businessServices.localCollaboration!.participation!.getSnapshot().members.length
    )
  ).toBe(2);
  const rejoined = await viewer.evaluate(async taskId => {
    const shared = (window as unknown as SharedWindow).services.businessServices
      .localCollaboration!;
    shared.participation!.close();
    const next = shared.createViewerParticipation!(taskId);
    await next.join('loading');
    const state = await next.join('active');
    return { participant: next.identity.participant_id, colors: state.color_registry };
  }, task.task_id);
  expect(rejoined.participant).not.toBe(joined.participant);
  expect(rejoined.colors).toEqual(joined.colors);
  expect(sourceChecks).toBe(4);
  expect(viewerWrites).toEqual([]);
  await page.goto('/local-mask');
  await expect
    .poll(() =>
      viewer.evaluate(
        () =>
          (
            window as unknown as SharedWindow
          ).services.businessServices.localCollaboration!.participation!.getSnapshot().phase
      )
    )
    .toBe('closed');
  await viewer.close();
});

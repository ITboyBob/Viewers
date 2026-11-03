import ServicesManager from '../../../core/src/services/ServicesManager';
import type PublicServices from '../../../core/src/types/Services';
import type { BusinessServices } from '@ohif/core';
import type { BusinessServices as TypesExport } from '../../../core/src/types';
import { createBusinessServices, businessServicesRegistration } from './createBusinessServices';
jest.mock('@ohif/core', () => ({ useSystem: jest.fn() }), { virtual: true });

test('OHIF用真实描述符工厂注册，并使两个Services类型面共享同一公共实体', () => {
  const manager = new ServicesManager(undefined);
  manager.registerService(businessServicesRegistration, { enabled: true });
  const container = manager.services.businessServices!;
  const fromRoot: BusinessServices = container;
  const fromTypes: TypesExport = container;
  const standalone: Pick<PublicServices, 'businessServices'> = { businessServices: container };
  const globalServices: Pick<AppTypes.Services, 'businessServices'> = {
    businessServices: container,
  };
  expect(fromRoot).toBe(fromTypes);
  expect(standalone.businessServices).toBe(globalServices.businessServices);
  expect(manager.registeredServiceNames).toContain('businessServices');
  expect(container.session.getSnapshot().status).toBe('unknown');
  expect(Object.hasOwn(container, 'runtime')).toBe(false);
  expect(container.localProjects!.getCurrent()).toBeNull();
  expect(container.tasks).toBeDefined();
  expect(container.projectRuntime!.phaseOneMask).toBe(false);
  expect(container.projectRuntime!.getCurrent()).toBeNull();
});

test('共享容器仅在业务开启时装配，缺身份不能创建源或参与协议', () => {
  const manager = new ServicesManager(undefined);
  manager.registerService(businessServicesRegistration, { enabled: true });
  const shared = manager.services.businessServices!.localCollaboration;
  expect(shared).toBeDefined();
  expect(shared!.identities.getSource()).toBeNull();
  expect(() => shared!.identities.source({} as never)).toThrow();
  expect(shared!.participation).toBeUndefined();
  expect(shared!.createViewerParticipation).toEqual(expect.any(Function));
  expect(() => shared!.createViewerParticipation!('task')).toThrow();
});

test('团队页可选读取能力只在开关开启时装配，并复用原 API 客户端', async () => {
  const transport = jest
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [], total: 0, mock: true } }),
    });
  const enabled = createBusinessServices({ enabled: true }, { fetch: transport, storage: null });
  expect(enabled.teamPage).toBeDefined();
  const request = jest.spyOn(enabled.api, 'request');
  await expect(enabled.teamPage!.listRecentTasks()).resolves.toEqual({
    items: [],
    total: 0,
    mock: true,
  });
  expect(request).toHaveBeenCalledWith('/tasks/recent', { signal: undefined });
  expect(transport).toHaveBeenCalledWith(
    '/api/v1/tasks/recent',
    expect.objectContaining({ method: 'GET', body: undefined })
  );
  expect(enabled.tasks).toBeDefined();
  expect(enabled.localCollaboration).toBeDefined();
  expect(enabled.ui!.renderHeader({ page: 'import' })).toBeTruthy();
  const disabled = createBusinessServices({ enabled: false }, { storage: null });
  expect(disabled.teamPage).toBeUndefined();
  expect(disabled.localCollaboration).toBeUndefined();
  expect(disabled.tasks).toBeDefined();
});

import ServicesManager from '../../../core/src/services/ServicesManager';
import type PublicServices from '../../../core/src/types/Services';
import type { BusinessServices } from '@ohif/core';
import type { BusinessServices as TypesExport } from '../../../core/src/types';
import { businessServicesRegistration } from './createBusinessServices';
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

test('共享容器仅在业务开启时装配，缺身份不能创建源且不冒称存储或协议已经实现', () => {
  const manager = new ServicesManager(undefined);
  manager.registerService(businessServicesRegistration, { enabled: true });
  const shared = manager.services.businessServices!.localCollaboration;
  expect(shared).toBeDefined();
  expect(shared!.identities.getSource()).toBeNull();
  expect(() => shared!.identities.source({} as never)).toThrow();
  expect(shared!.participation).toBeUndefined();
});

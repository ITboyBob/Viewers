import { canCreateSegmentation } from './SegmentationCreationPermission';
test('非业务模式保留原行为；业务工作台权限未知或读取失败时不放行新增', () => {
  expect(canCreateSegmentation({})).toBe(true);
  const runtime: any = {
    phaseOneMask: true,
    getCurrent: () => ({ task_id: 'task', can_edit: true }),
  };
  expect(canCreateSegmentation({ businessServices: { projectRuntime: runtime } })).toBe(false);
  runtime.getCurrent = () => ({ task_id: 'task', can_edit: true, can_add_segmentation: false });
  expect(canCreateSegmentation({ businessServices: { projectRuntime: runtime } })).toBe(false);
  runtime.getCurrent = () => ({ task_id: 'task', can_edit: true, can_add_segmentation: true });
  expect(canCreateSegmentation({ businessServices: { projectRuntime: runtime } })).toBe(true);
  runtime.getCurrent = () => null;
  expect(canCreateSegmentation({ businessServices: { projectRuntime: runtime } })).toBe(false);
});

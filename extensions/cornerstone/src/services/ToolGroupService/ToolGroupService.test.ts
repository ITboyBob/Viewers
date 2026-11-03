import ToolGroupService from './ToolGroupService';
import { getEnabledElements } from '@cornerstonejs/core';
import { ToolGroupManager, cancelActiveManipulations, state } from '@cornerstonejs/tools';
jest.mock(
  '@cornerstonejs/core',
  () => ({
    getEnabledElements: jest.fn(),
    eventTarget: { addEventListener: jest.fn(), removeEventListener: jest.fn() },
  }),
  { virtual: true }
);
jest.mock(
  '@cornerstonejs/tools',
  () => ({
    ToolGroupManager: { destroy: jest.fn() },
    cancelActiveManipulations: jest.fn(),
    state: { isInteractingWithTool: true, isMultiPartToolActive: true },
    Enums: { Events: { TOOL_ACTIVATED: 'activated' } },
  }),
  { virtual: true }
);
jest.mock('@ohif/core', () => ({ pubSubServiceInterface: {} }), { virtual: true });
jest.mock('../../utils/getActiveViewportEnabledElement', () => jest.fn());
test('销毁旧工具组先结束交互，再清理全局交互锁，后续任务可继续绘制', () => {
  const element = document.createElement('div');
  (getEnabledElements as jest.Mock).mockReturnValue([{ viewport: { element } }]);
  const service = new ToolGroupService({ services: {} } as any);
  service.destroy();
  expect(cancelActiveManipulations).toHaveBeenCalledWith(element);
  expect((cancelActiveManipulations as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (ToolGroupManager.destroy as jest.Mock).mock.invocationCallOrder[0]
  );
  expect(state.isInteractingWithTool).toBe(false);
  expect(state.isMultiPartToolActive).toBe(false);
});

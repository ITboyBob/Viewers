import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { canCreateSegmentation } from './SegmentationCreationPermission';

// 执行完整生产工厂及 definitions 包装器，不复制权限正则；仅隔离渲染依赖和底层动作。
const compiled = transpileModule(readFileSync(resolve(__dirname, '../commandsModule.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
}).outputText;

function fixture(project: { can_edit?: boolean; can_add_segmentation?: boolean } | null) {
  const result = { changed: 3, message: '已应用精修' };
  const maskActions = {
    thresholdMaskSlice: jest.fn(),
    thresholdMaskSeries: jest.fn(),
    fillMaskHoles: jest.fn(),
    fillMaskHolesSeries: jest.fn(),
    growMaskFromSeed: jest.fn(),
    splitMaskComponents: jest.fn(),
    applyMaskRefinement: jest.fn().mockResolvedValue(result),
    previewMaskRefinement: jest.fn().mockResolvedValue(result),
    getMaskRefinementPreviewData: jest.fn().mockReturnValue(result),
    exportMaskSegmentation: jest.fn().mockResolvedValue(result),
    saveMaskProject: jest.fn().mockResolvedValue(result),
    saveMaskWorkspace: jest.fn().mockResolvedValue(result),
  };
  const getCurrent = jest.fn(() => project);
  const segmentationService = {
    getSegmentations: jest.fn(() => []),
    createLabelmapForDisplaySet: jest.fn().mockResolvedValue('new-mask'),
    addSegmentationRepresentation: jest.fn().mockResolvedValue(undefined),
    setActiveSegmentation: jest.fn(),
    remove: jest.fn(),
  };
  const services: any = {
    businessServices: { projectRuntime: { getCurrent } },
    viewportGridService: {
      getState: () => ({
        viewports: new Map([['viewport', { displaySetInstanceUIDs: ['display-set'] }]]),
      }),
    },
    displaySetService: { getDisplaySetByUID: () => ({ imageIds: ['image'] }) },
    segmentationService,
  };
  const dependencies: Record<string, unknown> = {
    '@cornerstonejs/core': { utilities: { HistoryMemo: { DefaultHistoryMemo: {} } } },
    '@cornerstonejs/tools': {
      utilities: {},
      Enums: { SegmentationRepresentations: { Labelmap: 'Labelmap' } },
    },
    '@cornerstonejs/ai': { ONNXSegmentationController: class {} },
    './utils/SegmentationCreationPermission': { canCreateSegmentation },
    './utils/maskEditing/createMaskCommands': { default: () => ({}) },
    './utils/maskEditing/createVolumeMaskCommands': { default: () => maskActions },
  };
  const loaded = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)(
    dependency => dependencies[dependency] ?? {},
    loaded,
    loaded.exports
  );
  const { definitions } = loaded.exports.default({
    servicesManager: { services },
    commandsManager: {},
    extensionManager: {},
  });
  return { definitions, maskActions, result, getCurrent, services, segmentationService };
}

test('只读任务通过注册命令执行精修时，不调用底层实际动作', async () => {
  const f = fixture({ can_edit: false });
  const result = await f.definitions.applyMaskRefinement({ previewId: 'preview' });
  expect(f.maskActions.applyMaskRefinement).not.toHaveBeenCalled();
  expect(result).toBeUndefined();
});

test('允许编辑但禁止新建分割的任务仍可应用精修，并保留参数和返回值', async () => {
  const f = fixture({ can_edit: true, can_add_segmentation: false });
  const options = { previewId: 'preview' };
  expect(await f.definitions.applyMaskRefinement(options)).toBe(f.result);
  expect(f.maskActions.applyMaskRefinement).toHaveBeenCalledTimes(1);
  expect(f.maskActions.applyMaskRefinement).toHaveBeenCalledWith(options);
});

test('同一个已注册命令在任务权限动态切换时，每次调用都读取最新权限', async () => {
  const project = { can_edit: true };
  const f = fixture(project);
  const execute = f.definitions.applyMaskRefinement;
  await execute({ previewId: 'editable' });
  project.can_edit = false;
  expect(await execute({ previewId: 'read-only' })).toBeUndefined();
  expect(f.maskActions.applyMaskRefinement).toHaveBeenCalledTimes(1);
  project.can_edit = true;
  expect(await execute({ previewId: 'editable-again' })).toBe(f.result);
  expect(f.maskActions.applyMaskRefinement.mock.calls).toEqual([
    [{ previewId: 'editable' }],
    [{ previewId: 'editable-again' }],
  ]);
});

test('切换当前任务对象后，已注册命令不能沿用上一个任务的可编辑权限', async () => {
  const f = fixture({ can_edit: true });
  const execute = f.definitions.applyMaskRefinement;
  f.getCurrent.mockReturnValue({ can_edit: false });
  expect(await execute({ previewId: 'other-task' })).toBeUndefined();
  expect(f.maskActions.applyMaskRefinement).not.toHaveBeenCalled();
});

test.each([null, {}])('没有显式只读限制时保持既有行为：%p', async project => {
  const f = fixture(project);
  expect(await f.definitions.applyMaskRefinement({ previewId: 'preview' })).toBe(f.result);
  expect(f.maskActions.applyMaskRefinement).toHaveBeenCalledTimes(1);
});

test('非业务模式没有 projectRuntime 时，精修行为保持不变', async () => {
  const f = fixture(null);
  delete f.services.businessServices;
  expect(await f.definitions.applyMaskRefinement({ previewId: 'preview' })).toBe(f.result);
  expect(f.maskActions.applyMaskRefinement).toHaveBeenCalledTimes(1);
});

test.each([
  'previewMaskRefinement',
  'getMaskRefinementPreviewData',
  'exportMaskSegmentation',
  'saveMaskProject',
  'saveMaskWorkspace',
])('只读任务的预览和导出入口不新增权限包装：%s', async name => {
  const f = fixture({ can_edit: false });
  expect(f.definitions[name]).toBe(f.maskActions[name]);
  expect(await f.definitions[name]({ previewId: 'preview' })).toBe(f.result);
  expect(f.maskActions[name]).toHaveBeenCalledTimes(1);
});

test('现有创建入口继续拒绝只读或没有新增分割权限的任务', async () => {
  for (const project of [
    { can_edit: false, can_add_segmentation: true },
    { can_edit: true, can_add_segmentation: false },
  ]) {
    const f = fixture(project);
    await f.definitions.createLabelmapForViewport.commandFn({ viewportId: 'viewport' });
    expect(f.segmentationService.createLabelmapForDisplaySet).not.toHaveBeenCalled();
  }
});

test('具备现有创建权限的任务仍经过原创建及表示挂载路径', async () => {
  const f = fixture({ can_edit: true, can_add_segmentation: true });
  const result = await f.definitions.createLabelmapForViewport.commandFn({
    viewportId: 'viewport',
    options: { segmentationId: 'new-mask', label: '测试分割' },
  });
  expect(result).toBe('new-mask');
  expect(f.segmentationService.createLabelmapForDisplaySet).toHaveBeenCalledTimes(1);
  expect(f.segmentationService.addSegmentationRepresentation).toHaveBeenCalledWith(
    'viewport',
    expect.objectContaining({ segmentationId: 'new-mask' })
  );
});

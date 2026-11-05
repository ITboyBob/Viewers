import customization from './layoutSelectorCustomization';
const generate = customization['layoutSelector.advancedPresetGenerator'];
function setup(values: Record<string, unknown>) {
  const selectors = jest.fn().mockReturnValue(true);
  return {
    selectors,
    servicesManager: {
      services: {
        hangingProtocolService: {
          protocols: new Map([
            ['mpr', { id: 'mpr', name: 'MPR', isPreset: true, displaySetSelectors: { ct: {} } }],
          ]),
          areRequiredSelectorsValid: selectors,
        },
        viewportGridService: {
          getActiveViewportId: () => 'vp',
          getDisplaySetsUIDsForViewport: () => ['source'],
        },
        displaySetService: { getDisplaySetByUID: (id: string) => values[id] },
      },
    },
  } as any;
}
test('显示集异步注册未完成时不读取undefined.Modality或把部分数据冒充就绪', () => {
  const f = setup({});
  expect(generate(f)).toEqual([]);
  expect(f.selectors).not.toHaveBeenCalled();
});
test('SR引用的显示集未就绪时等待，补齐后恢复真实协议校验', () => {
  const values: any = {
    source: { Modality: 'SR', measurements: [{ displaySetInstanceUID: 'ct' }] },
  };
  const f = setup(values);
  expect(generate(f)).toEqual([]);
  values.ct = { Modality: 'CT' };
  expect(generate(f)).toEqual([
    expect.objectContaining({ disabled: false, commandOptions: { protocolId: 'mpr' } }),
  ]);
  expect(f.selectors).toHaveBeenCalledWith([{}], values.ct);
});

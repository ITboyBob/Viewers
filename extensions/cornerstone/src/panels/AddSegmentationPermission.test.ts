import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddSegmentationRow } from '../../../../platform/ui-next/src/components/SegmentationTable/AddSegmentationRow';
let mockContext: any;
jest.mock('../../../../platform/ui-next/src/components/SegmentationTable/contexts', () => ({
  useSegmentationTableContext: () => mockContext,
}));
jest.mock('../../../../platform/ui-next/src/components/Icons', () => ({
  Icons: { Add: () => null, Info: () => null },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (v: string) => v }) }));
afterEach(cleanup);
test('权限禁用保留 Add Segmentation，不冒充影像不支持；鼠标与键盘均不能触发', () => {
  const add = jest.fn();
  mockContext = {
    data: [],
    mode: 'expanded',
    disableEditing: false,
    disabled: false,
    addSegmentationDisabled: true,
    onSegmentationAdd: add,
  };
  render(React.createElement(AddSegmentationRow));
  const button = screen.getByRole('button', { name: 'Add Segmentation' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.className).toContain('cursor-not-allowed');
  expect(screen.queryByText('Segmentation Not Supported')).toBeNull();
  fireEvent.click(button);
  fireEvent.keyDown(button, { key: 'Enter' });
  fireEvent.keyDown(button, { key: ' ' });
  expect(add).not.toHaveBeenCalled();
});
test('可编辑及非业务默认行为不变；既有影像不支持状态仍单独显示', () => {
  const add = jest.fn();
  mockContext = {
    data: [],
    mode: 'expanded',
    disableEditing: false,
    disabled: false,
    onSegmentationAdd: add,
  };
  const view = render(React.createElement(AddSegmentationRow));
  fireEvent.click(screen.getByRole('button', { name: 'Add Segmentation' }));
  expect(add).toHaveBeenCalledWith('');
  mockContext.disabled = true;
  view.rerender(React.createElement(AddSegmentationRow));
  expect(
    (screen.getByRole('button', { name: 'Segmentation Not Supported' }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
});

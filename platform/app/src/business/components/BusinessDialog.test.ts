import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import BusinessDialog from './BusinessDialog';

const h = React.createElement;
afterEach(cleanup);

test.each([
  ['invite', '内容'],
  ['invite', '遮罩'],
  ['notifications', '内容'],
  ['notifications', '遮罩'],
] as const)('%s 弹窗%s阻止文件拖入、悬停和投放冒泡', (variant, surface) => {
  const outerDrag = jest.fn();
  render(
    h(
      'div',
      { onDragEnter: outerDrag, onDragOver: outerDrag, onDrop: outerDrag },
      h(BusinessDialog, {
        title: '文件投放隔离',
        variant,
        open: true,
        onOpenChange: jest.fn(),
        trigger: h('button', null, '入口'),
      })
    )
  );
  const target =
    surface === '内容'
      ? screen.getByRole('dialog', { name: '文件投放隔离' })
      : document.querySelector('.business-dialog-backdrop')!;
  const dataTransfer = { files: [new File(['synthetic'], 'synthetic.dcm')] };
  expect(fireEvent.drop(target, { dataTransfer })).toBe(false);
  expect(fireEvent.dragEnter(target, { dataTransfer })).toBe(false);
  expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false);
  expect(outerDrag).not.toHaveBeenCalled();
});

test('弹窗与遮罩隔离外层点击／指针／文件投放，关闭使用现有 overlay 生命周期', () => {
  const outside = jest.fn(),
    drop = jest.fn(),
    pointer = jest.fn(),
    change = jest.fn();
  const view = render(
    h(
      'div',
      { onClick: outside, onDrop: drop, onPointerDown: pointer },
      h(
        BusinessDialog,
        {
          title: '通知',
          variant: 'notifications',
          open: true,
          onOpenChange: change,
          trigger: h('button', null, '入口'),
        },
        h('p', null, '内容')
      )
    )
  );
  const dialog = screen.getByRole('dialog', { name: '通知' });
  fireEvent.click(dialog);
  fireEvent.pointerDown(dialog);
  expect(fireEvent.drop(dialog)).toBe(false);
  const backdrop = document.querySelector('.business-dialog-backdrop')!;
  fireEvent.click(backdrop);
  expect(outside).not.toHaveBeenCalled();
  expect(pointer).not.toHaveBeenCalled();
  expect(drop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭通知弹窗' }));
  expect(change).toHaveBeenCalledWith(false);
  view.rerender(
    h(
      BusinessDialog,
      {
        title: '邀请他人协作',
        variant: 'invite',
        open: true,
        onOpenChange: change,
        trigger: h('button', null, '入口'),
      },
      h('p', null, '内容')
    )
  );
  expect(screen.getByRole('button', { name: '关闭邀请弹窗' })).toBeTruthy();
});

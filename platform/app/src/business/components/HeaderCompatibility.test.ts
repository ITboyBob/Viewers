import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Header from '../../../../ui-next/src/components/Header/Header';

jest.mock('../../../../ui-next/src/components', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Icons: {
      ArrowLeft: () => React.createElement('span', null, '箭头'),
      OHIFLogo: () => React.createElement('span', null, '默认品牌'),
      GearSettings: () => null,
    },
    ToolButton: 'span',
    Button: 'button',
    DropdownMenu: ({ children }) => children,
    DropdownMenuTrigger: ({ children }) => children,
    DropdownMenuContent: () => null,
    DropdownMenuItem: 'span',
  };
});
jest.mock('@ohif/ui-next', () => ({ IconPresentationProvider: ({ children }) => children }), {
  virtual: true,
});
const h = React.createElement;
afterEach(cleanup);

test('未传 Branding 保留原 Logo 和原白标回退', () => {
  const view = render(h(Header, { menuOptions: [] }));
  expect(screen.getByText('默认品牌')).toBeTruthy();
  view.rerender(
    h(Header, { menuOptions: [], WhiteLabeling: { createLogoComponentFn: () => null } })
  );
  expect(screen.getByText('默认品牌')).toBeTruthy();
  view.rerender(
    h(Header, {
      menuOptions: [],
      WhiteLabeling: { createLogoComponentFn: () => h('span', null, '白标') },
    })
  );
  expect(screen.getByText('白标')).toBeTruthy();
});

test('显式 null 隐藏品牌，动作与返回是独立兄弟命中区', () => {
  const back = jest.fn(),
    member = jest.fn();
  render(
    h(Header, {
      menuOptions: [],
      Branding: null,
      onClickReturnButton: back,
      LeftActions: h('button', { onClick: member }, '成员'),
    })
  );
  expect(screen.queryByText('默认品牌')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  expect(member).toHaveBeenCalledTimes(1);
  expect(back).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '返回工作列表' }));
  expect(back).toHaveBeenCalledTimes(1);
});

test('自定义 Branding 不触发白标，原返回禁用仍有效', () => {
  const white = jest.fn(),
    back = jest.fn();
  render(
    h(Header, {
      menuOptions: [],
      Branding: h('span', null, '新品牌'),
      isReturnEnabled: false,
      WhiteLabeling: { createLogoComponentFn: white },
      onClickReturnButton: back,
    })
  );
  expect(screen.getByText('新品牌')).toBeTruthy();
  fireEvent.click(screen.getByText('新品牌'));
  expect(white).not.toHaveBeenCalled();
  expect(back).not.toHaveBeenCalled();
  expect(screen.queryByText('箭头')).toBeNull();
});

test('保留旧品牌容器对交互式白标的兼容，不把按钮嵌进新的返回按钮', () => {
  render(
    h(Header, {
      menuOptions: [],
      WhiteLabeling: { createLogoComponentFn: () => h('button', null, '交互白标') },
    })
  );
  expect(
    screen.getByRole('button', { name: '交互白标' }).parentElement!.closest('button')
  ).toBeNull();
});

test('独立返回命中区支持 Enter／空格，其他键和禁用时不导航', () => {
  const back = jest.fn();
  const view = render(h(Header, { menuOptions: [], Branding: null, onClickReturnButton: back }));
  const root = screen.getByRole('button', { name: '返回工作列表' });
  fireEvent.keyDown(root, { key: 'Enter' });
  fireEvent.keyDown(root, { key: ' ' });
  fireEvent.keyDown(root, { key: 'a' });
  expect(back).toHaveBeenCalledTimes(2);
  view.rerender(
    h(Header, {
      menuOptions: [],
      Branding: null,
      onClickReturnButton: back,
      isReturnEnabled: false,
    })
  );
  fireEvent.keyDown(screen.getByRole('button', { name: '返回工作列表' }), { key: 'Enter' });
  expect(back).toHaveBeenCalledTimes(2);
});

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SharedLinkButton from './SharedLinkButton';
const h = React.createElement;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup();
  if (descriptor) {
    Object.defineProperty(navigator, 'clipboard', descriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test.each([false, true])(
  '复制未完成时禁用重复点击，卸载=%s后迟到结果不更新旧组件',
  async unmount => {
    let resolve: () => void;
    const writeText = jest.fn().mockReturnValue(
      new Promise<void>(done => {
        resolve = done;
      })
    );
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = render(
      h(MemoryRouter, null, h(SharedLinkButton, { taskId: '12345678-1234-1234-1234-123456789abc' }))
    );
    const button = screen.getByRole('button', { name: '共享链接' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('正在复制…');
    if (unmount) {
      view.unmount();
    }
    await act(async () => {
      resolve!();
    });
    if (!unmount) {
      expect(screen.getByRole('status').textContent).toBe('已复制');
    }
  }
);

test('卸载后复制失败不显示迟到错误，手动地址聚焦时可全选', async () => {
  let reject: (error: Error) => void;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        }),
    },
  });
  const view = render(
    h(MemoryRouter, null, h(SharedLinkButton, { taskId: '12345678-1234-1234-1234-123456789abc' }))
  );
  fireEvent.click(screen.getByRole('button', { name: '共享链接' }));
  await act(async () => {
    reject!(new Error('denied'));
  });
  const input = screen.getByLabelText('共享地址（手动复制）') as HTMLInputElement;
  fireEvent.focus(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.click(screen.getByRole('button', { name: '共享链接' }));
  view.unmount();
  await act(async () => {
    reject!(new Error('denied'));
  });
});

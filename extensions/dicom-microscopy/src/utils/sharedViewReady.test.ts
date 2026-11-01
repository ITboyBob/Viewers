import { observeSharedViewReady } from './sharedViewReady';

function setup() {
  const container = document.createElement('div');
  let render: () => void;
  const map = {
    on: jest.fn((_event, fn) => {
      render = fn;
    }),
    un: jest.fn(),
  };
  const ready = jest.fn();
  const stop = observeSharedViewReady({ [Symbol.for('map')]: map }, container, ready);
  const load = (payload?: object) =>
    container.dispatchEvent(
      new CustomEvent('dicommicroscopyviewer_frame_loading_ended', { detail: { payload } })
    );
  return { container, render: () => render!(), map, ready, stop, load };
}
test('空画面、错误同名事件和空像素不能ready；成功像素后的完整渲染只完成一次', () => {
  const s = setup();
  s.render();
  s.load();
  s.render();
  s.load({ pixelArray: [] });
  s.render();
  s.load({ pixelArray: new Uint8Array(0) });
  s.render();
  expect(s.ready).not.toHaveBeenCalled();
  s.load({ pixelArray: new Uint8Array([1]) });
  expect(s.ready).not.toHaveBeenCalled();
  s.render();
  s.render();
  expect(s.ready).toHaveBeenCalledTimes(1);
  expect(s.map.un).toHaveBeenCalledWith('rendercomplete', expect.any(Function));
});
test('清理后迟到像素或渲染不能激活旧窗口', () => {
  const s = setup();
  s.stop();
  s.load({ pixelArray: new Uint8Array([1]) });
  s.render();
  expect(s.ready).not.toHaveBeenCalled();
  s.stop();
  expect(() => observeSharedViewReady({}, s.container, s.ready)()).not.toThrow();
});

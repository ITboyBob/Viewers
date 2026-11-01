type RenderMap = {
  on(event: string, listener: () => void): unknown;
  un(event: string, listener: () => void): void;
};

/** 在原生render前订阅；只有成功像素及随后完整渲染才算画面完成。 */
export function observeSharedViewReady(
  viewer: object,
  container: HTMLElement,
  ready: () => void
): () => void {
  const map = (viewer as Record<symbol, RenderMap | undefined>)[Symbol.for('map')];
  if (!map) {
    return () => {};
  }
  let decoded = false;
  let stopped = false;
  const loaded = (event: Event) => {
    const pixels = (event as CustomEvent<{ payload?: { pixelArray?: ArrayBufferView } }>).detail
      ?.payload?.pixelArray;
    // SDK错误事件与结束事件同名；缺少成功像素不能当作加载完成。
    if (pixels && ArrayBuffer.isView(pixels) && pixels.byteLength > 0) {
      decoded = true;
    }
  };
  const stop = () => {
    stopped = true;
    container.removeEventListener('dicommicroscopyviewer_frame_loading_ended', loaded);
    map.un('rendercomplete', rendered);
  };
  const rendered = () => {
    if (!stopped && decoded) {
      stop();
      ready();
    }
  };
  container.addEventListener('dicommicroscopyviewer_frame_loading_ended', loaded);
  map.on('rendercomplete', rendered);
  return stop;
}

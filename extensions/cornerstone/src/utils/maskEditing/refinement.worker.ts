import { refineMask } from './refinementAlgorithms';
self.onmessage = (event: MessageEvent) => {
  try {
    const result = refineMask(
      event.data.state,
      event.data.dimensions,
      event.data.spacing,
      event.data.options,
      (completed, total) => self.postMessage({ type: 'progress', completed, total })
    );
    self.postMessage(result, { transfer: [result.mask.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Mask 精修计算失败。' });
  }
};

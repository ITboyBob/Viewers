import { markSeedComponent, analyzeMaskComponents } from './volumeAlgorithms';

self.onmessage = (event: MessageEvent) => {
  try {
    const result =
      event.data.task === 'split'
        ? analyzeMaskComponents(event.data.mask, event.data.dimensions, event.data.minimumVoxels)
        : markSeedComponent(event.data.mask, event.data.dimensions, event.data.seed);
    self.postMessage(result, { transfer: [result.mask.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '区域生长失败。' });
  }
};

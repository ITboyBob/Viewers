import { encodeMaskProject, decodeMaskProject, maskProjectFingerprint } from './maskProjectCodec';

self.onmessage = async (event: MessageEvent) => {
  try {
    const result =
      event.data.task === 'save'
        ? { archive: await encodeMaskProject(event.data.manifest, event.data.labels) }
        : await decodeMaskProject(event.data.archive);
    const bytes = 'archive' in result ? result.archive : result.labels;
    const manifest = 'archive' in result ? event.data.manifest : result.manifest;
    const labels = 'archive' in result ? event.data.labels : result.labels;
    const fingerprint = await maskProjectFingerprint(manifest, labels);
    self.postMessage({ ...result, fingerprint }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '标注文件处理失败。' });
  }
};

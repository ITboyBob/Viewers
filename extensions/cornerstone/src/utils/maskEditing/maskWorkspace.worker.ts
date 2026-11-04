import { encodeMaskWorkspace, decodeMaskWorkspace } from './maskWorkspaceCodec';
self.onmessage = async (event: MessageEvent) => {
  try {
    const result =
      event.data.task === 'save'
        ? await encodeMaskWorkspace(event.data.collections, event.data.activeKey)
        : await decodeMaskWorkspace(event.data.archive);
    const transfer =
      'archive' in result
        ? [result.archive.buffer]
        : result.collections.map(item => item.labels.buffer);
    self.postMessage(result, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '完整项目文件处理失败。' });
  }
};

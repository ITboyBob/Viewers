import type { LocalProject, ResultArtifact } from '@ohif/core';

const arrays = {
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
};
/** 业务成果包不是DICOM文件：复用原生采集/回载，按SR/SEG/RTSTRUCT业务对象分组，像素保持二进制。 */
export function stableImageReference(
  project: LocalProject,
  value: string,
  restore = false
): string {
  for (const item of project.successes) {
    const stable = `urn:colla:image:${item.study_uid}/${item.series_uid}/${item.sop_uid}`;
    const from = restore ? stable : item.image_id,
      to = restore ? item.image_id : stable;
    if (value === from) {
      return to;
    }
    if (value.startsWith(from + '&frame=')) {
      const frame = value.slice(from.length + 7);
      if (/^[1-9]\d*$/.test(frame) && Number(frame) <= Number(item.dataset.NumberOfFrames)) {
        return to + '&frame=' + frame;
      }
      throw new Error('成果引用了非法帧');
    }
  }
  if (restore && value.startsWith('urn:colla:image:')) {
    throw new Error('成果引用不属于该任务');
  }
  return value;
}
function referenceKey(project: LocalProject, key: string, restore = false): string {
  if (key.startsWith('volumeId:')) {
    return 'stored-volume-stats';
  }
  for (const prefix of ['', 'stack:', 'imageId:']) {
    const value = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    const mapped = stableImageReference(project, value, restore);
    if (mapped !== value) {
      return prefix + mapped;
    }
  }
  return key;
}
export function encodeResult(
  project: LocalProject,
  type: ResultArtifact['type'],
  state: unknown
): Blob {
  const chunks: ArrayBuffer[] = [];
  const header = JSON.stringify(
    { version: 1, task_id: project.task_id, type, state },
    (key, value) => {
      if (['volumeId', 'referencedVolumeId', 'viewportId', 'renderingEngineId'].includes(key)) {
        return undefined;
      }
      if (typeof value === 'string') {
        return stableImageReference(project, value);
      }
      if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const index = chunks.length;
        chunks.push(
          (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
            ? value.buffer
            : value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength
              )) as ArrayBuffer
        );
        return { $array: value.constructor.name, index, bytes: value.byteLength };
      }
      if (value instanceof Map) {
        return { $map: [...value] };
      }
      if (value instanceof Set) {
        return { $set: [...value] };
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.some(([name]) => referenceKey(project, name) !== name)) {
          return Object.fromEntries(
            entries.map(([name, item]) => [referenceKey(project, name), item])
          );
        }
      }
      return value;
    }
  );
  if (header.length > 16 * 1024 * 1024) {
    throw new Error('成果结构超过运行期限额');
  }
  const data = new TextEncoder().encode(header),
    length = new Uint8Array(4);
  if (data.byteLength > 16 * 1024 * 1024) {
    throw new Error('成果结构超过运行期限额');
  }
  new DataView(length.buffer).setUint32(0, data.byteLength, true);
  return new Blob([length, data, ...chunks], { type: 'application/vnd.colla.task-result' });
}
export async function decodeResult(
  project: LocalProject,
  artifact: ResultArtifact
): Promise<unknown> {
  return decodeResultState(
    project.task_id!,
    artifact,
    value => stableImageReference(project, value, true),
    key => referenceKey(project, key, true)
  );
}

/** 纯二进制解码：只读消费者保持稳定引用，不建立原生imageId或导入工作台。 */
export async function decodeResultState(
  taskId: string,
  artifact: ResultArtifact,
  mapValue: (value: string) => string = value => value,
  mapKey: (key: string) => string = key => key
): Promise<unknown> {
  const buffer = await artifact.blob.arrayBuffer();
  if (buffer.byteLength < 4) {
    throw new Error('成果包损坏');
  }
  const length = new DataView(buffer).getUint32(0, true);
  if (length > 16 * 1024 * 1024 || 4 + length > buffer.byteLength) {
    throw new Error('成果包头无效');
  }
  let offset = 4 + length;
  const value = JSON.parse(new TextDecoder().decode(buffer.slice(4, offset)), (_key, v) => {
    if (typeof v === 'string') {
      return mapValue(v);
    }
    if (v && typeof v === 'object' && v.$array) {
      const Constructor = arrays[v.$array as keyof typeof arrays];
      if (
        !Constructor ||
        !Number.isSafeInteger(v.bytes) ||
        v.bytes < 0 ||
        offset + v.bytes > buffer.byteLength ||
        v.bytes % Constructor.BYTES_PER_ELEMENT
      ) {
        throw new Error('成果像素数据无效');
      }
      const bytes = buffer.slice(offset, offset + v.bytes);
      offset += v.bytes;
      return new Constructor(bytes);
    }
    if (v?.$map) {
      return new Map(v.$map);
    }
    if (v?.$set) {
      return new Set(v.$set);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).map(([name, item]) => [mapKey(name), item]));
    }
    return v;
  });
  if (
    value.version !== 1 ||
    value.task_id !== taskId ||
    value.type !== artifact.type ||
    offset !== buffer.byteLength
  ) {
    throw new Error('成果身份或格式不匹配');
  }
  return value.state;
}

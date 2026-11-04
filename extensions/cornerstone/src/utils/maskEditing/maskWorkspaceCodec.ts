import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  encodeMaskProject,
  decodeMaskProject,
  maskProjectFingerprint,
  matchProjectFrames,
  validateProjectSource,
  MAX_PROJECT_FILE_BYTES,
} from './maskProjectCodec';
import type { MaskProjectManifest, ProjectSource } from './maskProjectCodec';
import { validateRoi } from './maskRoi';
import type { MaskRoi } from './maskRoi';

export const MAX_WORKSPACE_LABEL_BYTES = 256 * 1024 * 1024;
export const MAX_WORKSPACE_FILE_BYTES = MAX_WORKSPACE_LABEL_BYTES + 12 * 1024 * 1024;
export const MAX_WORKSPACE_COLLECTIONS = 32;
type WorkspaceManifest = {
  format: 'OHIF_MASK_WORKSPACE';
  version: 1;
  createdAt: string;
  source: ProjectSource;
  roi?: MaskRoi;
  activeKey: string;
  collections: { key: string; bytes: number; labelBytes: number; sha256: string }[];
};
export type WorkspaceCollection = {
  key: string;
  manifest: MaskProjectManifest;
  labels: Uint8Array;
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function hash(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v =>
    v.toString(16).padStart(2, '0')
  ).join('');
}
function validate(value: WorkspaceManifest) {
  check(value?.format === 'OHIF_MASK_WORKSPACE' && value.version === 1, '不是支持的完整项目文件。');
  check(
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)),
    '项目时间无效。'
  );
  const sourceBytes = validateProjectSource(value.source);
  if (value.roi !== undefined) {
    validateRoi(value.roi);
    check(
      value.roi.seriesInstanceUID === value.source.seriesInstanceUID,
      '项目 ROI 与源序列不匹配。'
    );
  }
  check(
    Array.isArray(value.collections) &&
      value.collections.length > 0 &&
      value.collections.length <= MAX_WORKSPACE_COLLECTIONS,
    '完整项目需包含 1 至 32 个标注集。'
  );
  const keys = new Set<string>();
  let bytes = 0;
  for (const item of value.collections) {
    check(
      item && typeof item.key === 'string' && /^set-\d{3}$/.test(item.key) && !keys.has(item.key),
      '标注集编号无效或重复。'
    );
    check(
      Number.isInteger(item.bytes) &&
        item.bytes > 0 &&
        item.bytes <= MAX_PROJECT_FILE_BYTES &&
        item.labelBytes === sourceBytes &&
        /^[a-f0-9]{64}$/.test(item.sha256),
      '标注集的长度或校验描述无效。'
    );
    keys.add(item.key);
    bytes += item.labelBytes;
    check(
      bytes <= MAX_WORKSPACE_LABEL_BYTES,
      '完整项目的标签数据总量超过 256 MiB，请分别保存标注集。'
    );
  }
  check(keys.has(value.activeKey), '项目选中的标注集不存在。');
}

/** Each independent labelmap is preserved, including overlapping masks and empty collections. */
export async function encodeMaskWorkspace(collections: WorkspaceCollection[], activeKey: string) {
  check(
    collections.length > 0 && collections.length <= MAX_WORKSPACE_COLLECTIONS,
    '完整项目需包含 1 至 32 个标注集。'
  );
  const source = collections[0].manifest.source,
    roi = collections[0].manifest.roi;
  let labelBytes = 0;
  for (const item of collections) {
    labelBytes += item.labels.length;
    check(labelBytes <= MAX_WORKSPACE_LABEL_BYTES, '完整项目的标签数据总量超过 256 MiB。');
    matchProjectFrames(source, item.manifest.source);
    check(
      JSON.stringify(item.manifest.roi || null) === JSON.stringify(roi || null),
      '同一项目的 ROI 状态不一致。'
    );
  }
  const manifest: WorkspaceManifest = {
    format: 'OHIF_MASK_WORKSPACE',
    version: 1,
    createdAt: new Date().toISOString(),
    source,
    roi,
    activeKey,
    collections: [],
  };
  const files: Record<string, Uint8Array> = {},
    fingerprints: Record<string, string> = {};
  for (const item of collections) {
    const archive = await encodeMaskProject(item.manifest, item.labels);
    manifest.collections.push({
      key: item.key,
      bytes: archive.length,
      labelBytes: item.labels.length,
      sha256: await hash(archive),
    });
    files[`collections/${item.key}.ohifmask`] = archive;
    fingerprints[item.key] = await maskProjectFingerprint(item.manifest, item.labels);
  }
  validate(manifest);
  files['workspace.json'] = strToU8(JSON.stringify(manifest));
  check(files['workspace.json'].length <= 4 * 1024 * 1024, '项目描述信息过大。');
  const archive = zipSync(files, { level: 0 });
  check(archive.length <= MAX_WORKSPACE_FILE_BYTES, '项目文件过大，请分别保存标注集。');
  return { archive, fingerprints };
}

export async function decodeMaskWorkspace(bytes: Uint8Array) {
  check(bytes.length > 0 && bytes.length <= MAX_WORKSPACE_FILE_BYTES, '完整项目文件为空或过大。');
  const names = new Set<string>();
  let total = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      check(
        (file.name === 'workspace.json' || /^collections\/set-\d{3}\.ohifmask$/.test(file.name)) &&
          !names.has(file.name),
        '项目包含无效或重复条目。'
      );
      check(names.size < MAX_WORKSPACE_COLLECTIONS + 1, '项目包含过多标注集。');
      names.add(file.name);
      total += file.originalSize;
      check(
        file.originalSize > 0 &&
          file.originalSize <=
            (file.name === 'workspace.json' ? 4 * 1024 * 1024 : MAX_PROJECT_FILE_BYTES) &&
          total <= MAX_WORKSPACE_FILE_BYTES,
        '项目解压后的文件过大。'
      );
      return true;
    },
  });
  check(files['workspace.json'], '项目缺少描述信息。');
  const manifest: WorkspaceManifest = JSON.parse(strFromU8(files['workspace.json']));
  validate(manifest);
  check(names.size === manifest.collections.length + 1, '项目的标注集条目数不匹配。');
  const collections: (WorkspaceCollection & { fingerprint: string })[] = [];
  for (const item of manifest.collections) {
    const archive = files[`collections/${item.key}.ohifmask`];
    check(
      archive && archive.length === item.bytes && (await hash(archive)) === item.sha256,
      '项目中的标注集校验失败。'
    );
    const decoded = await decodeMaskProject(archive);
    matchProjectFrames(manifest.source, decoded.manifest.source);
    check(
      decoded.labels.length === item.labelBytes &&
        JSON.stringify(decoded.manifest.roi || null) === JSON.stringify(manifest.roi || null),
      '项目中的像素长度或 ROI 不一致。'
    );
    collections.push({
      key: item.key,
      ...decoded,
      fingerprint: await maskProjectFingerprint(decoded.manifest, decoded.labels),
    });
  }
  return { manifest, collections };
}

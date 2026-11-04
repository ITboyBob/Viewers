import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { validateRoi } from './maskRoi';
import type { MaskRoi } from './maskRoi';

export const MAX_PROJECT_VOXELS = 128 * 1024 * 1024;
export const MAX_PROJECT_FILE_BYTES = MAX_PROJECT_VOXELS + 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export type ProjectFrame = {
  sopInstanceUID: string;
  rows: number;
  columns: number;
  position: number[];
  orientation: number[];
  spacing: number[];
};
export type ProjectSource = {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  frameOfReferenceUID: string;
  frames: ProjectFrame[];
};
export type ProjectSegment = {
  index: number;
  label: string;
  color: [number, number, number, number];
  visible: boolean;
  locked: boolean;
  style: { fillAlpha: number; outlineWidth: number; renderFill: boolean; renderOutline: boolean };
};
export type MaskProjectManifest = {
  format: 'OHIF_MASK_PROJECT';
  version: 1 | 2;
  roi?: MaskRoi;
  createdAt: string;
  label: string;
  source: ProjectSource;
  segments: ProjectSegment[];
  activeSegmentIndex: number | null;
  representationVisible?: boolean;
  labelmap: { encoding: 'uint8'; byteLength: number; sha256: string };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function numbers(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(Number.isFinite);
}
function uid(value: unknown) {
  return typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)*$/.test(value) && value.length <= 64;
}
function text(value: unknown) {
  return typeof value === 'string' && value.length <= 512;
}

export function validateProjectSource(source: ProjectSource): number {
  check(
    source &&
      uid(source.studyInstanceUID) &&
      uid(source.seriesInstanceUID) &&
      uid(source.frameOfReferenceUID),
    '原始影像的检查、序列或空间标识不完整。'
  );
  check(
    Array.isArray(source.frames) && source.frames.length > 0 && source.frames.length <= 8192,
    '切片数量无效或超过本地标注文件限制。'
  );
  const ids = new Set<string>();
  let bytes = 0;
  for (const frame of source.frames) {
    check(
      frame && uid(frame.sopInstanceUID) && !ids.has(frame.sopInstanceUID),
      '切片标识无效或重复；暂不支持增强多帧影像。'
    );
    ids.add(frame.sopInstanceUID);
    check(
      Number.isInteger(frame.rows) &&
        frame.rows > 0 &&
        frame.rows <= 16384 &&
        Number.isInteger(frame.columns) &&
        frame.columns > 0 &&
        frame.columns <= 16384,
      '切片尺寸无效。'
    );
    check(
      numbers(frame.position, 3) &&
        numbers(frame.orientation, 6) &&
        numbers(frame.spacing, 2) &&
        frame.spacing.every(v => v > 0),
      '切片空间信息无效。'
    );
    const o = frame.orientation;
    check(
      Math.abs(Math.hypot(...o.slice(0, 3)) - 1) < 0.0001 &&
        Math.abs(Math.hypot(...o.slice(3)) - 1) < 0.0001 &&
        Math.abs(o[0] * o[3] + o[1] * o[4] + o[2] * o[5]) < 0.0001,
      '切片方向信息无效。'
    );
    bytes += frame.rows * frame.columns;
    check(bytes <= MAX_PROJECT_VOXELS, '当前标注超过 128 MiB 标签数据限制，请使用 DICOM SEG。');
  }
  return bytes;
}

export function validateManifest(value: MaskProjectManifest): void {
  check(
    value?.format === 'OHIF_MASK_PROJECT' && [1, 2].includes(value.version),
    '不是受支持的 OHIF 标注文件（支持版本 1 和 2）。'
  );
  check(
    text(value.label) &&
      typeof value.createdAt === 'string' &&
      Number.isFinite(Date.parse(value.createdAt)),
    '标注文件的名称或时间无效。'
  );
  const bytes = validateProjectSource(value.source);
  check(
    value.representationVisible === undefined || typeof value.representationVisible === 'boolean',
    '标注集显隐状态无效。'
  );
  if (value.roi !== undefined) {
    check(value.version === 2, '含 ROI 的标注文件需要版本 2。');
    validateRoi(value.roi);
    check(value.roi.seriesInstanceUID === value.source.seriesInstanceUID, 'ROI 与源序列不匹配。');
  }
  check(
    value.labelmap?.encoding === 'uint8' &&
      value.labelmap.byteLength === bytes &&
      /^[a-f0-9]{64}$/.test(value.labelmap.sha256),
    '标注像素描述无效。'
  );
  check(Array.isArray(value.segments) && value.segments.length <= 254, 'Mask 数量无效。');
  const indices = new Set<number>();
  for (const segment of value.segments) {
    check(
      segment &&
        Number.isInteger(segment.index) &&
        segment.index >= 1 &&
        segment.index <= 254 &&
        !indices.has(segment.index),
      'Mask 编号无效或重复（支持 1–254）。'
    );
    indices.add(segment.index);
    check(
      text(segment.label) &&
        numbers(segment.color, 4) &&
        segment.color.every(v => Number.isInteger(v) && v >= 0 && v <= 255) &&
        typeof segment.visible === 'boolean' &&
        typeof segment.locked === 'boolean',
      'Mask 名称、颜色或状态无效。'
    );
    const style = segment.style;
    check(
      style &&
        Number.isFinite(style.fillAlpha) &&
        style.fillAlpha >= 0 &&
        style.fillAlpha <= 1 &&
        Number.isFinite(style.outlineWidth) &&
        style.outlineWidth >= 0 &&
        style.outlineWidth <= 10 &&
        typeof style.renderFill === 'boolean' &&
        typeof style.renderOutline === 'boolean',
      'Mask 外观设置无效。'
    );
  }
  check(
    value.activeSegmentIndex === null ? indices.size === 0 : indices.has(value.activeSegmentIndex),
    '选中的 Mask 不存在。'
  );
}

/** Map by DICOM identity, never by file names, import order or runtime image IDs. */
export function matchProjectFrames(saved: ProjectSource, current: ProjectSource): number[] {
  validateProjectSource(saved);
  validateProjectSource(current);
  check(
    saved.studyInstanceUID === current.studyInstanceUID &&
      saved.seriesInstanceUID === current.seriesInstanceUID &&
      saved.frameOfReferenceUID === current.frameOfReferenceUID &&
      saved.frames.length === current.frames.length,
    '标注文件与当前影像序列不匹配，请先导入同一组完整的原始 DICOM。'
  );
  const indices = new Map(current.frames.map((frame, index) => [frame.sopInstanceUID, index]));
  return saved.frames.map(frame => {
    const index = indices.get(frame.sopInstanceUID);
    const other = index === undefined ? undefined : current.frames[index];
    check(
      other &&
        frame.rows === other.rows &&
        frame.columns === other.columns &&
        ['position', 'orientation', 'spacing'].every(key =>
          frame[key].every((v: number, i: number) => Math.abs(v - other[key][i]) <= 0.0001)
        ),
      '原始切片标识、尺寸或空间位置不匹配，未载入标注。'
    );
    return index;
  });
}

function validatePixels(manifest: MaskProjectManifest, labels: Uint8Array) {
  check(
    labels instanceof Uint8Array && labels.length === manifest.labelmap.byteLength,
    '标注像素长度不正确。'
  );
  const valid = new Uint8Array(256);
  valid[0] = 1;
  manifest.segments.forEach(segment => {
    valid[segment.index] = 1;
  });
  for (const value of labels)
    check(
      valid[value],
      value === 255 ? '存在未提交的笔刷预览，请先确认或取消预览。' : '标注像素引用了不存在的 Mask。'
    );
}
async function sha256(labels: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', labels);
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
}

export async function encodeMaskProject(manifest: MaskProjectManifest, labels: Uint8Array) {
  manifest.labelmap.sha256 = await sha256(labels);
  validateManifest(manifest);
  validatePixels(manifest, labels);
  const json = strToU8(JSON.stringify(manifest));
  check(json.length <= MAX_MANIFEST_BYTES, '标注文件的描述信息过大。');
  return zipSync({ 'manifest.json': json, 'labels.bin': labels }, { level: 1 });
}

/** Logical content identity remains stable when Stack/MPR stores frames in a different order. */
export async function maskProjectFingerprint(manifest: MaskProjectManifest, labels: Uint8Array) {
  let offset = 0;
  const frames = [];
  for (const frame of manifest.source.frames) {
    const count = frame.rows * frame.columns;
    frames.push([
      frame.sopInstanceUID,
      frame.rows,
      frame.columns,
      frame.position,
      frame.orientation,
      frame.spacing,
      await sha256(labels.subarray(offset, offset + count)),
    ]);
    offset += count;
  }
  frames.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const segments = [...manifest.segments]
    .sort((a, b) => a.index - b.index)
    .map(segment => [
      segment.index,
      segment.label,
      segment.color,
      segment.visible,
      segment.locked,
      segment.style.fillAlpha,
      segment.style.outlineWidth,
      segment.style.renderFill,
      segment.style.renderOutline,
    ]);
  return sha256(
    strToU8(
      JSON.stringify([
        manifest.label,
        manifest.source.studyInstanceUID,
        manifest.source.seriesInstanceUID,
        manifest.source.frameOfReferenceUID,
        frames,
        segments,
        manifest.roi || null,
        manifest.representationVisible ?? true,
      ])
    )
  );
}

export async function decodeMaskProject(bytes: Uint8Array) {
  check(bytes.length > 0 && bytes.length <= MAX_PROJECT_FILE_BYTES, '标注文件为空或过大。');
  const seen = new Set<string>();
  const files = unzipSync(bytes, {
    filter(file) {
      check(
        ['manifest.json', 'labels.bin'].includes(file.name) && !seen.has(file.name),
        '标注文件包含多余或重复条目。'
      );
      seen.add(file.name);
      check(
        file.originalSize > 0 &&
          file.originalSize <=
            (file.name === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_PROJECT_VOXELS),
        '标注文件解压后过大或条目为空。'
      );
      return true;
    },
  });
  check(files['manifest.json'] && files['labels.bin'], '标注文件缺少描述信息或像素。');
  const manifest: MaskProjectManifest = JSON.parse(strFromU8(files['manifest.json']));
  const labels = files['labels.bin'];
  validateManifest(manifest);
  validatePixels(manifest, labels);
  check(
    (await sha256(labels)) === manifest.labelmap.sha256,
    '标注文件像素校验失败，文件可能已损坏。'
  );
  return { manifest, labels };
}

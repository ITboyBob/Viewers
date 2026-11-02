// Independent raw-file reference for real-data regression; deliberately does not import app algorithms.
const fs = require('node:fs');
const path = require('node:path');
const dicomParser = require('dicom-parser');

function rawFrames(folder) {
  const files = fs
    .readdirSync(folder)
    .filter(f => f.endsWith('.dcm'))
    .map(f => path.join(folder, f));
  const frames = files.map(file => {
    const bytes = fs.readFileSync(file),
      ds = dicomParser.parseDicom(new Uint8Array(bytes));
    const syntax = ds.string('x00020010');
    if (!['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'].includes(syntax))
      throw Error('Independent reference requires uncompressed samples');
    const numbers = tag => ds.string(tag).split('\\').map(Number);
    const frame = {
      file,
      uid: ds.string('x00080018'),
      rows: ds.uint16('x00280010'),
      columns: ds.uint16('x00280011'),
      modality: ds.string('x00080060'),
      orientation: numbers('x00200037'),
      position: numbers('x00200032'),
      spacing: numbers('x00280030'),
      bitsAllocated: ds.uint16('x00280100'),
      bitsStored: ds.uint16('x00280101'),
      highBit: ds.uint16('x00280102'),
      signed: ds.uint16('x00280103') === 1,
      slope: Number(ds.string('x00281053') || 1),
      intercept: Number(ds.string('x00281052') || 0),
      offset: ds.elements.x7fe00010.dataOffset,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      little: syntax !== '1.2.840.10008.1.2.2',
    };
    return frame;
  });
  const o = frames[0].orientation,
    n = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
  const dot = f => f.position.reduce((sum, v, i) => sum + v * n[i], 0);
  frames.sort((a, b) => dot(a) - dot(b));
  frames.forEach((f, index) => {
    f.index = index;
    f.distance = dot(f);
  });
  return frames;
}
function intensity(frame, index) {
  const raw =
    frame.bitsAllocated === 8
      ? frame.view.getUint8(frame.offset + index)
      : frame.view.getUint16(frame.offset + index * 2, frame.little);
  const shift = frame.highBit + 1 - frame.bitsStored,
    levels = 2 ** frame.bitsStored;
  let value = (raw >>> shift) & (levels - 1);
  if (frame.signed && value >= levels / 2) value -= levels;
  return value * frame.slope + frame.intercept;
}
function summarize(binary, frames) {
  const plane = frames[0].rows * frames[0].columns;
  return frames
    .map((frame, k) => {
      let count = 0,
        hash = 2166136261;
      for (let i = 0; i < plane; i++) {
        const v = binary[k * plane + i];
        count += v;
        hash = Math.imul(hash ^ v, 16777619) >>> 0;
      }
      return { uid: frame.uid, count, hash };
    })
    .sort((a, b) => a.uid.localeCompare(b.uid));
}
function components(binary, width, height, depth) {
  const count = binary.reduce((sum, v) => sum + v, 0),
    copy = binary.slice(),
    queue = new Uint32Array(count),
    plane = width * height;
  const sizes = [];
  let largest = new Uint32Array(0);
  for (let start = 0; start < copy.length; start++) {
    if (!copy[start]) continue;
    let head = 0,
      tail = 1;
    queue[0] = start;
    copy[start] = 0;
    while (head < tail) {
      const i = queue[head++],
        x = i % width,
        y = Math.floor(i / width) % height,
        z = Math.floor(i / plane);
      const candidates = [];
      if (x) candidates.push(i - 1);
      if (x + 1 < width) candidates.push(i + 1);
      if (y) candidates.push(i - width);
      if (y + 1 < height) candidates.push(i + width);
      if (z) candidates.push(i - plane);
      if (z + 1 < depth) candidates.push(i + plane);
      for (const j of candidates)
        if (copy[j]) {
          copy[j] = 0;
          queue[tail++] = j;
        }
    }
    sizes.push(tail);
    if (tail > largest.length) largest = queue.slice(0, tail);
  }
  const largestMask = new Uint8Array(binary.length);
  for (const i of largest) largestMask[i] = 1;
  let seedIndex = largest[0],
    best = Infinity;
  for (const i of largest) {
    const x = i % width,
      y = Math.floor(i / width) % height,
      z = Math.floor(i / plane);
    if (x < 1 || x + 1 >= width || y < 1 || y + 1 >= height || z < 1 || z + 1 >= depth) continue;
    if (![i - 1, i + 1, i - width, i + width, i - plane, i + plane].every(j => largestMask[j]))
      continue;
    const score =
      ((x - width / 2) / width) ** 2 +
      ((y - height / 2) / height) ** 2 +
      ((z - depth / 2) / depth) ** 2;
    if (score < best) {
      best = score;
      seedIndex = i;
    }
  }
  sizes.sort((a, b) => b - a);
  return { sizes, largestMask, seedIndex };
}
function buildReference(folder) {
  const frames = rawFrames(folder),
    first = frames[0],
    plane = first.rows * first.columns;
  let lower = 150,
    upper = 2000,
    min = Infinity,
    max = -Infinity;
  const histogram = new Map();
  for (const frame of frames)
    for (let i = 0; i < plane; i++) {
      const value = intensity(frame, i);
      min = Math.min(min, value);
      max = Math.max(max, value);
      if (i % 16 === 0) histogram.set(value, (histogram.get(value) || 0) + 1);
    }
  if (first.modality !== 'CT') {
    const entries = [...histogram].sort((a, b) => a[0] - b[0]),
      total = entries.reduce((s, e) => s + e[1], 0);
    let n = 0;
    lower = entries[0][0];
    upper = max;
    for (const [value, count] of entries) {
      n += count;
      if (n >= total * 0.75) {
        lower = value;
        break;
      }
    }
  }
  const binary = new Uint8Array(plane * frames.length);
  frames.forEach((frame, k) => {
    for (let i = 0; i < plane; i++) {
      const value = intensity(frame, i);
      binary[k * plane + i] = Number(value >= lower && value <= upper);
    }
  });
  const regions = components(binary, first.columns, first.rows, frames.length);
  const minimumVoxels = Math.min(
    regions.sizes[0],
    Math.max(
      first.modality === 'CT' ? 1000 : 100,
      regions.sizes.length > 32 ? regions.sizes[31] + 1 : 1
    )
  );
  return {
    frames,
    binary,
    lower,
    upper,
    min,
    max,
    regions,
    minimumVoxels,
    summary: summarize(binary, frames),
    largestSummary: summarize(regions.largestMask, frames),
  };
}
module.exports = { buildReference, summarize };

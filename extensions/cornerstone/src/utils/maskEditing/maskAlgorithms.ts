/** Pixel operations work on image-space labels, never on windowed display pixels. */
export type SliceLabels = ArrayLike<number>;

function validateSlice(labels: SliceLabels, width: number, height: number, segmentIndex: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height !== labels.length
  ) {
    throw new Error('切片尺寸与 Mask 数据不一致。');
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 1 || segmentIndex > 65535) {
    throw new Error('请先选择一个有效的 Mask。');
  }
}

export function thresholdSlice(
  labels: SliceLabels,
  intensities: ArrayLike<number>,
  width: number,
  height: number,
  segmentIndex: number,
  lower: number,
  upper: number,
  replace = true,
  selection?: ArrayLike<number>
) {
  validateSlice(labels, width, height, segmentIndex);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
    throw new Error('阈值下限不能大于上限，且必须是有效数字。');
  }
  if (intensities.length !== labels.length) {
    throw new Error('原始影像与 Mask 的切片尺寸不一致。');
  }
  if (selection && selection.length !== labels.length) throw new Error('ROI 尺寸与切片不一致。');
  const result = Uint32Array.from(labels);
  for (let index = 0; index < labels.length; index++) {
    if (selection && !selection[index]) continue;
    // Another segment is never overwritten, including locked segments.
    if (labels[index] !== 0 && labels[index] !== segmentIndex) {
      continue;
    }
    const intensity = intensities[index];
    if (Number.isFinite(intensity) && intensity >= lower && intensity <= upper) {
      result[index] = segmentIndex;
    } else if (replace && labels[index] === segmentIndex) {
      result[index] = 0;
    }
  }
  return result;
}

export function fillHolesSlice(
  labels: SliceLabels,
  width: number,
  height: number,
  segmentIndex: number
) {
  validateSlice(labels, width, height, segmentIndex);
  const outside = new Uint8Array(labels.length);
  const queue = new Uint32Array(labels.length);
  let head = 0;
  let tail = 0;
  const visit = (index: number) => {
    // Traverse other labels too: only the selected mask defines the boundary.
    if (!outside[index] && labels[index] !== segmentIndex) {
      outside[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  // Eight-connected background avoids filling a space open diagonally.
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) {
          visit((y + dy) * width + x + dx);
        }
      }
    }
  }
  const result = Uint32Array.from(labels);
  for (let index = 0; index < labels.length; index++) {
    if (labels[index] === 0 && !outside[index]) {
      result[index] = segmentIndex;
    }
  }
  return result;
}

/** A cut is made with the eraser first. Each disconnected component becomes a segment. */
export function splitMaskSlice(
  labels: SliceLabels,
  width: number,
  height: number,
  segmentIndex: number,
  usedSegmentIndices: number[],
  maxSegmentIndex = 255,
  maxComponents = 32
) {
  validateSlice(labels, width, height, segmentIndex);
  const visited = new Uint8Array(labels.length);
  const queue = new Uint32Array(labels.length);
  const components: Uint32Array[] = [];
  for (let seed = 0; seed < labels.length; seed++) {
    if (visited[seed] || labels[seed] !== segmentIndex) {
      continue;
    }
    let head = 0;
    let tail = 0;
    const visit = (index: number) => {
      if (!visited[index] && labels[index] === segmentIndex) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };
    visit(seed);
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (index >= width) visit(index - width);
      if (index + width < labels.length) visit(index + width);
    }
    components.push(queue.slice(0, tail));
    if (components.length > maxComponents) {
      throw new Error(`区域超过 ${maxComponents} 个，请先清理零散噪点后再拆分。`);
    }
  }
  // Keep the largest component under the original label; never discard small regions.
  components.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const result = Uint32Array.from(labels);
  const created: { segmentIndex: number; pixelCount: number }[] = [];
  const used = new Set([...usedSegmentIndices, ...labelsToIndices(labels), segmentIndex]);
  let next = 1;
  for (const component of components.slice(1)) {
    while (used.has(next) && next <= maxSegmentIndex) next++;
    if (next > maxSegmentIndex) {
      throw new Error('可用的 Mask 编号不足，未修改原始数据。');
    }
    for (const index of component) result[index] = next;
    created.push({ segmentIndex: next, pixelCount: component.length });
    used.add(next++);
  }
  return { pixels: result, created, componentCount: components.length };
}

function labelsToIndices(labels: SliceLabels) {
  const indices = new Set<number>();
  for (let index = 0; index < labels.length; index++) indices.add(labels[index]);
  return indices;
}

export function createSliceMapping(
  dimensions: readonly number[],
  axis: number,
  sliceIndex: number
) {
  if (
    dimensions.length !== 3 ||
    dimensions.some(value => !Number.isInteger(value) || value < 1) ||
    !Number.isInteger(axis) ||
    axis < 0 ||
    axis > 2 ||
    !Number.isInteger(sliceIndex) ||
    sliceIndex < 0 ||
    sliceIndex >= dimensions[axis]
  ) {
    throw new Error('当前切片超出影像范围。');
  }
  const axes = [0, 1, 2].filter(value => value !== axis);
  const width = dimensions[axes[0]];
  const height = dimensions[axes[1]];
  const strides = [1, dimensions[0], dimensions[0] * dimensions[1]];
  return {
    width,
    height,
    toIndex(index: number) {
      return (
        sliceIndex * strides[axis] +
        (index % width) * strides[axes[0]] +
        Math.floor(index / width) * strides[axes[1]]
      );
    },
  };
}

export function getAlignedPlaneAxis(direction: ArrayLike<number>, normal: ArrayLike<number>) {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  for (let axis = 0; axis < 3; axis++) {
    const dot = Math.abs(
      (direction[axis * 3] * normal[0] +
        direction[axis * 3 + 1] * normal[1] +
        direction[axis * 3 + 2] * normal[2]) /
        length
    );
    if (dot > 0.9999) return axis;
  }
  throw new Error('请切换到与影像体素轴对齐的切片；暂不支持斜切面。');
}

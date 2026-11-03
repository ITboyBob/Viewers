export type RefinementOperation =
  | 'dilate'
  | 'erode'
  | 'open'
  | 'close'
  | 'smooth'
  | 'largest'
  | 'removeSmall'
  | 'removeSeed';
export type RefinementOptions = {
  operation: RefinementOperation;
  radiusMm?: number;
  minimumVolumeMm3?: number;
  seed?: number[];
};
export type RefinementProgress = (completed: number, total: number) => void;
export const MAX_REFINEMENT_VOXELS = 64 * 1024 * 1024;
const INF = 1e15;

function validate(state: Uint8Array, dimensions: readonly number[], spacing: readonly number[]) {
  if (
    dimensions.length !== 3 ||
    dimensions.some(v => !Number.isInteger(v) || v < 1) ||
    dimensions.reduce((a, b) => a * b, 1) !== state.length
  )
    throw new Error('Mask 体数据尺寸不一致。');
  if (state.length > MAX_REFINEMENT_VOXELS)
    throw new Error('当前 Mask 超出本地精修处理上限，请缩小影像范围。');
  if (spacing.length !== 3 || spacing.some(v => !Number.isFinite(v) || v <= 0))
    throw new Error('影像体素间距无效，无法按毫米执行操作。');
  for (const value of state) if (value > 2) throw new Error('精修快照包含无效状态。');
}

/** Exact separable squared Euclidean distance in physical units; one full float volume. */
function distanceTransform(
  mask: Uint8Array,
  dimensions: number[],
  spacing: readonly number[],
  foreground: boolean,
  distance: Float32Array,
  progress?: (axis: number) => void
) {
  for (let i = 0; i < mask.length; i++) distance[i] = Boolean(mask[i]) === foreground ? 0 : INF;
  const maximum = Math.max(...dimensions),
    f = new Float64Array(maximum),
    sites = new Int32Array(maximum),
    edges = new Float64Array(maximum + 1);
  const [w, h, d] = dimensions,
    strides = [1, w, w * h];
  for (let axis = 0; axis < 3; axis++) {
    const length = dimensions[axis],
      stride = strides[axis],
      weight = spacing[axis] ** 2;
    if (length === 1) {
      progress?.(axis + 1);
      continue;
    }
    const lineCount = mask.length / length;
    for (let line = 0; line < lineCount; line++) {
      const start =
        axis === 0 ? line * w : axis === 1 ? (line % w) + Math.floor(line / w) * w * h : line;
      for (let q = 0; q < length; q++) f[q] = distance[start + q * stride];
      let k = 0;
      sites[0] = 0;
      edges[0] = -Infinity;
      edges[1] = Infinity;
      for (let q = 1; q < length; q++) {
        let crossing: number;
        do {
          const previous = sites[k];
          crossing =
            ((f[q] - f[previous]) / weight + q * q - previous * previous) / (2 * (q - previous));
          if (crossing > edges[k]) break;
          k--;
        } while (k >= 0);
        k++;
        sites[k] = q;
        edges[k] = crossing;
        edges[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < length; q++) {
        while (edges[k + 1] < q) k++;
        distance[start + q * stride] = weight * (q - sites[k]) ** 2 + f[sites[k]];
      }
    }
    progress?.(axis + 1);
  }
}

function morphology(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
) {
  const radius = options.radiusMm;
  if (!Number.isFinite(radius) || radius < 0.1 || radius > 10)
    throw new Error('形态学半径应为 0.1 至 10 mm。');
  const padding = dimensions.map((size, axis) =>
    size === 1 ? 0 : Math.ceil(radius / spacing[axis])
  );
  const dims = dimensions.map((size, axis) => size + 2 * padding[axis]);
  const count = dims.reduce((a, b) => a * b, 1);
  if (count > MAX_REFINEMENT_VOXELS)
    throw new Error('当前体积与半径超出本地精修处理上限，请减小半径或影像范围。');
  const [w, h, d] = dims,
    plane = w * h;
  let mask = new Uint8Array(count);
  const distance = new Float32Array(count);
  const offset = (i: number) =>
    (i % dimensions[0]) +
    padding[0] +
    w *
      ((Math.floor(i / dimensions[0]) % dimensions[1]) +
        padding[1] +
        h * (Math.floor(i / (dimensions[0] * dimensions[1])) + padding[2]));
  for (let i = 0; i < state.length; i++) {
    mask[offset(i)] = state[i] === 1 ? 1 : 0;
  }
  const operations = {
    dilate: ['dilate'],
    erode: ['erode'],
    open: ['erode', 'dilate'],
    close: ['dilate', 'erode'],
    smooth: ['erode', 'dilate', 'dilate', 'erode'],
  }[options.operation];
  const r2 = radius * radius,
    tolerance = Math.max(1e-7, r2 * 2e-7);
  for (let step = 0; step < operations.length; step++) {
    const operation = operations[step];
    const dilation = operation === 'dilate';
    distanceTransform(mask, dims, spacing, dilation, distance, axis =>
      progress?.(step * 4 + axis, operations.length * 4)
    );
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      let squared = distance[i];
      if (!dilation) {
        const x = i % w,
          y = Math.floor(i / w) % h,
          z = Math.floor(i / plane);
        if (dimensions[0] > 1)
          squared = Math.min(squared, ((x + 1) * spacing[0]) ** 2, ((w - x) * spacing[0]) ** 2);
        if (dimensions[1] > 1)
          squared = Math.min(squared, ((y + 1) * spacing[1]) ** 2, ((h - y) * spacing[1]) ** 2);
        if (dimensions[2] > 1)
          squared = Math.min(squared, ((z + 1) * spacing[2]) ** 2, ((d - z) * spacing[2]) ** 2);
      }
      result[i] = (dilation ? squared <= r2 + tolerance : squared > r2 + tolerance) ? 1 : 0;
    }
    mask = result;
    progress?.((step + 1) * 4, operations.length * 4);
  }
  const result = new Uint8Array(state.length);
  // Clip only the final private result: standard closing stays extensive at protected borders.
  for (let i = 0; i < result.length; i++) result[i] = state[i] === 2 ? 0 : mask[offset(i)];
  return {
    mask: result,
    components: undefined as number | undefined,
    removedComponents: undefined as number | undefined,
  };
}

/** Reusable ring frontier avoids a full uint32 queue and supports unlimited component counts. */
function componentCleaner(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
) {
  const mask = Uint8Array.from(state, v => (v === 1 ? 1 : 0)),
    [w, h, d] = dimensions,
    plane = w * h;
  let queue = new Uint32Array(Math.min(mask.length, 65536)),
    head = 0,
    size = 0;
  function flood(seed: number, from: number, to: number) {
    head = 0;
    size = 0;
    let count = 0;
    const visit = (index: number) => {
      if (mask[index] !== from) return;
      mask[index] = to;
      count++;
      if (size === queue.length) {
        const larger = new Uint32Array(Math.min(mask.length, queue.length * 2));
        for (let i = 0; i < size; i++) larger[i] = queue[(head + i) % queue.length];
        queue = larger;
        head = 0;
      }
      queue[(head + size++) % queue.length] = index;
    };
    visit(seed);
    while (size) {
      const i = queue[head];
      head = (head + 1) % queue.length;
      size--;
      const x = i % w,
        y = Math.floor(i / w) % h,
        z = Math.floor(i / plane);
      if (x > 0) visit(i - 1);
      if (x + 1 < w) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y + 1 < h) visit(i + w);
      if (z > 0) visit(i - plane);
      if (z + 1 < d) visit(i + plane);
    }
    return count;
  }
  if (options.operation === 'removeSeed') {
    const seed = options.seed;
    if (
      seed?.length !== 3 ||
      seed.some((v, axis) => !Number.isInteger(v) || v < 0 || v >= dimensions[axis])
    )
      throw new Error('点击位置超出当前影像范围。');
    const index = seed[0] + w * seed[1] + plane * seed[2];
    if (mask[index] !== 1) throw new Error('请点击当前 Mask 已着色区域内要删除的区域。');
    flood(index, 1, 0);
    progress?.(mask.length, mask.length);
    return { mask, components: undefined as number | undefined, removedComponents: 1 };
  }
  let minimum = 1;
  if (options.operation === 'removeSmall') {
    const value = options.minimumVolumeMm3;
    if (!Number.isFinite(value) || value <= 0 || value > 1e9)
      throw new Error('碎片体积门槛应大于 0，且不超过 1000000000 mm³。');
    minimum = Math.max(1, Math.ceil(value / (spacing[0] * spacing[1] * spacing[2]) - 1e-9));
  }
  let components = 0,
    removedComponents = 0,
    largest = 0,
    largestSeed = -1;
  for (let seed = 0; seed < mask.length; seed++) {
    if (seed % plane === 0) progress?.(seed, mask.length);
    if (mask[seed] !== 1) continue;
    const count = flood(seed, 1, 2);
    components++;
    if (count > largest) {
      largest = count;
      largestSeed = seed;
    }
    if (options.operation === 'removeSmall' && count < minimum) {
      flood(seed, 2, 0);
      removedComponents++;
    }
  }
  if (options.operation === 'largest' && largestSeed >= 0) {
    for (let i = 0; i < mask.length; i++) if (mask[i] === 2) mask[i] = 1;
    flood(largestSeed, 1, 3);
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 3 ? 1 : 0;
    removedComponents = components - 1;
  } else for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 2 ? 1 : 0;
  progress?.(mask.length, mask.length);
  return { mask, components, removedComponents };
}

/** Snapshot state: 0 background, 1 selected Mask, 2 protected other Masks. */
export function refineMask(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
) {
  validate(state, dimensions, spacing);
  if (
    ![
      'dilate',
      'erode',
      'open',
      'close',
      'smooth',
      'largest',
      'removeSmall',
      'removeSeed',
    ].includes(options?.operation)
  )
    throw new Error('未知的 Mask 精修操作。');
  if (
    ['dilate', 'erode', 'open', 'close', 'smooth'].includes(options.operation) &&
    (!Number.isFinite(options.radiusMm) || options.radiusMm < 0.1 || options.radiusMm > 10)
  )
    throw new Error('形态学半径应为 0.1 至 10 mm。');
  if (
    options.operation === 'removeSmall' &&
    (!Number.isFinite(options.minimumVolumeMm3) ||
      options.minimumVolumeMm3 <= 0 ||
      options.minimumVolumeMm3 > 1e9)
  )
    throw new Error('碎片体积门槛应大于 0，且不超过 1000000000 mm³。');
  if (state.every(value => value !== 1) && options.operation !== 'removeSeed') {
    progress?.(1, 1);
    return { mask: new Uint8Array(state.length), components: 0, removedComponents: 0 };
  }
  return ['largest', 'removeSmall', 'removeSeed'].includes(options.operation)
    ? componentCleaner(state, dimensions, spacing, options, progress)
    : morphology(state, dimensions, spacing, options, progress);
}

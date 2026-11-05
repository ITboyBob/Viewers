export type RefinementOperation =
  | 'dilate'
  | 'erode'
  | 'open'
  | 'close'
  | 'smooth'
  | 'largest'
  | 'removeSmall'
  | 'removeSeed'
  | 'fillCavities'
  | 'huGrow'
  | 'interpolate'
  | 'boolean'
  | 'cut';
// Boolean outputs are edited only in a dedicated single-Mask labelmap.
export type RefinementOptions = {
  operation: RefinementOperation;
  radiusMm?: number;
  minimumVolumeMm3?: number;
  maximumCavityVolumeMm3?: number;
  seed?: number[];
  useRoi?: boolean;
  replace?: boolean;
  lower?: number;
  upper?: number;
  startSlice?: number;
  endSlice?: number;
  keyframes?: number[];
  replaceIntermediate?: boolean;
  eligibility?: Uint8Array;
  booleanOperation?: 'union' | 'intersection' | 'difference';
  operandMask?: Uint8Array;
  operandSegmentationId?: string;
  operandSegmentIndex?: number;
  cutPlane?: { normal: number[]; offset: number; keepPositive: boolean };
};
export type RefinementProgress = (completed: number, total: number) => void;
export type RefinementResult = {
  mask: Uint8Array;
  components?: number;
  removedComponents?: number;
  cavities?: number;
  eligibleCavities?: number;
  interpolatedSlices?: number;
  skippedSlices?: number;
};
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
export function distanceTransform(
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

/**
 * Fill only enclosed 3D background components. Background uses 26-connectivity:
 * even diagonal routes to any image face stay open. Other Masks are traversable
 * background for topology/volume, but can never be written into the result.
 */
function fillCavities(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
): RefinementResult {
  const maximum = options.maximumCavityVolumeMm3;
  if (maximum !== undefined && (!Number.isFinite(maximum) || maximum <= 0 || maximum > 1e9))
    throw new Error('空腔最大体积应大于 0，且不超过 1000000000 mm³，或选择不限制体积。');
  const [w, h, d] = dimensions,
    plane = w * h,
    voxelVolume = spacing[0] * spacing[1] * spacing[2],
    maximumVoxels = maximum === undefined ? Infinity : Math.floor(maximum / voxelVolume + 1e-9),
    marks = Uint8Array.from(state, value => (value === 1 ? 1 : 0));
  // A ring frontier bounds memory by the current wave rather than all visited voxels.
  let queue = new Uint32Array(Math.min(state.length, 65536)),
    head = 0,
    size = 0,
    work = 0,
    cavities = 0,
    eligibleCavities = 0;
  const totalWork = state.length * 3;
  function tick() {
    if (++work % 32768 === 0) progress?.(work, totalWork);
  }
  function flood(seed: number, from: number, to: number) {
    head = 0;
    size = 0;
    let count = 0,
      writable = 0,
      exterior = false;
    function visit(index: number) {
      if (marks[index] !== from) return;
      marks[index] = to;
      count++;
      writable += Number(state[index] === 0);
      if (size === queue.length) {
        const larger = new Uint32Array(Math.min(state.length, queue.length * 2));
        for (let i = 0; i < size; i++) larger[i] = queue[(head + i) % queue.length];
        queue = larger;
        head = 0;
      }
      queue[(head + size++) % queue.length] = index;
    }
    visit(seed);
    while (size) {
      const i = queue[head];
      head = (head + 1) % queue.length;
      size--;
      const x = i % w,
        y = Math.floor(i / w) % h,
        z = Math.floor(i / plane);
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1 || z === 0 || z === d - 1)
        exterior = true;
      for (let c = Math.max(0, z - 1); c <= Math.min(d - 1, z + 1); c++)
        for (let b = Math.max(0, y - 1); b <= Math.min(h - 1, y + 1); b++)
          for (let a = Math.max(0, x - 1); a <= Math.min(w - 1, x + 1); a++)
            visit(a + w * b + plane * c);
      tick();
    }
    return { count, writable, exterior };
  }
  progress?.(0, totalWork);
  for (let seed = 0; seed < marks.length; seed++) {
    if (marks[seed] === 0) {
      const region = flood(seed, 0, 2);
      if (!region.exterior && region.writable) {
        cavities++;
        if (region.count <= maximumVoxels) {
          eligibleCavities++;
          // Revisit just this component; no dense queue or component-ID volume is needed.
          flood(seed, 2, 3);
        }
      }
    }
    tick();
  }
  for (let i = 0; i < marks.length; i++)
    marks[i] = state[i] === 1 || (state[i] === 0 && marks[i] === 3) ? 1 : 0;
  progress?.(totalWork, totalWork);
  return { mask: marks, cavities, eligibleCavities };
}

/** Snapshot state: 0 background, 1 selected Mask, 2 protected other Masks. */
export function refineMask(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
): RefinementResult {
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
      'fillCavities',
      'huGrow',
      'interpolate',
      'boolean',
      'cut',
    ].includes(options?.operation)
  )
    throw new Error('未知的 Mask 精修操作。');
  if (options.operation === 'fillCavities')
    return fillCavities(state, dimensions, spacing, options, progress);
  if (options.operation === 'huGrow') {
    const candidates = options.eligibility;
    if (
      !(candidates instanceof Uint8Array) ||
      candidates.length !== state.length ||
      candidates.some(v => v > 1)
    )
      throw new Error('HU 区域生长候选数据无效。');
    const eligible = Uint8Array.from(candidates, (value, i) => (state[i] === 2 ? 0 : value));
    const grown = componentCleaner(
      eligible,
      dimensions,
      spacing,
      { operation: 'removeSeed', seed: options.seed },
      progress
    );
    // Seed deletion is used only on the private candidate copy to identify exactly the connected voxels.
    const mask = Uint8Array.from(eligible, (value, i) =>
      state[i] !== 2 &&
      ((value === 1 && grown.mask[i] === 0) || (!options.replace && state[i] === 1))
        ? 1
        : 0
    );
    return {
      mask,
      components: undefined as number | undefined,
      removedComponents: undefined as number | undefined,
    };
  }
  if (options.operation === 'boolean') {
    const other = options.operandMask;
    if (
      !(other instanceof Uint8Array) ||
      other.length !== state.length ||
      other.some(v => v > 1) ||
      !['union', 'intersection', 'difference'].includes(options.booleanOperation)
    )
      throw new Error('布尔运算参数或源 Mask 无效。');
    const mask = new Uint8Array(state.length),
      plane = dimensions[0] * dimensions[1];
    for (let i = 0; i < mask.length; i++) {
      const a = state[i] === 1,
        b = other[i] === 1;
      mask[i] =
        state[i] !== 2 &&
        (options.booleanOperation === 'union'
          ? a || b
          : options.booleanOperation === 'intersection'
            ? a && b
            : a && !b)
          ? 1
          : 0;
      if (i % plane === 0) progress?.(i, state.length);
    }
    progress?.(1, 1);
    return {
      mask,
      components: undefined as number | undefined,
      removedComponents: undefined as number | undefined,
    };
  }
  if (options.operation === 'cut') {
    const plane = options.cutPlane;
    if (
      plane?.normal?.length !== 3 ||
      !plane.normal.every(Number.isFinite) ||
      !Number.isFinite(plane.offset) ||
      Math.hypot(...plane.normal) < 1e-9 ||
      typeof plane.keepPositive !== 'boolean'
    )
      throw new Error('三维切面参数无效。');
    const [w, h] = dimensions,
      mask = new Uint8Array(state.length);
    for (let i = 0; i < mask.length; i++) {
      const value =
        (i % w) * plane.normal[0] +
        (Math.floor(i / w) % h) * plane.normal[1] +
        Math.floor(i / (w * h)) * plane.normal[2] -
        plane.offset;
      mask[i] = state[i] === 1 && (plane.keepPositive ? value >= -1e-6 : value <= 1e-6) ? 1 : 0;
      if (i % (w * h) === 0) progress?.(i, state.length);
    }
    progress?.(1, 1);
    return {
      mask,
      components: undefined as number | undefined,
      removedComponents: undefined as number | undefined,
    };
  }
  if (options.operation === 'interpolate')
    return interpolateSlices(state, dimensions, spacing, options, progress);
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

export const MAX_INTERPOLATION_KEYFRAMES = 64;

/** Explicit layer numbers, rather than inferred or previously interpolated contours. */
export function parseInterpolationKeyframes(text: string): number[] {
  const values = text.trim().split(/[,，;；\s]+/);
  if (!text.trim() || values.some(value => !/^\d+$/.test(value)))
    throw new Error('关键层列表应为整数层号，用逗号或空格分隔，例如 1, 5, 10。');
  if (values.length > MAX_INTERPOLATION_KEYFRAMES)
    throw new Error(`一次最多选择 ${MAX_INTERPOLATION_KEYFRAMES} 张关键层，请分段处理。`);
  return values.map(Number);
}

export function interpolationKeyframes(options: RefinementOptions, depth: number): number[] {
  const keys =
    options.keyframes === undefined ? [options.startSlice, options.endSlice] : options.keyframes;
  if (
    !Array.isArray(keys) ||
    keys.length < 2 ||
    keys.length > MAX_INTERPOLATION_KEYFRAMES ||
    keys.some(
      (value, i) =>
        !Number.isInteger(value) || value < 1 || value > depth || (i > 0 && value <= keys[i - 1])
    )
  )
    throw new Error(
      `请选择 2 至 ${MAX_INTERPOLATION_KEYFRAMES} 张有效关键层，按层号递增且不能重复。`
    );
  if (!keys.some((value, i) => i > 0 && value - keys[i - 1] >= 2))
    throw new Error('关键层之间至少需要一张可插值的中间层。');
  return [...keys];
}

/** Blend signed in-plane distances piecewise; retain only the current pair in memory. */
function interpolateSlices(
  state: Uint8Array,
  dimensions: readonly number[],
  spacing: readonly number[],
  options: RefinementOptions,
  progress?: RefinementProgress
) {
  const keys = interpolationKeyframes(options, dimensions[2]).map(value => value - 1);
  const [w, h] = dimensions,
    plane = w * h,
    dims = [w + 2, h + 2, 1];
  const count = dims[0] * dims[1];
  if (count > MAX_REFINEMENT_VOXELS) throw new Error('关键层尺寸超出插值上限。');
  for (const layer of keys)
    if (!state.subarray(layer * plane, (layer + 1) * plane).some(value => value === 1))
      throw new Error(`第 ${layer + 1} 张关键层没有当前 Mask 的选区，请重新选择。`);
  function signed(layer: number) {
    const binary = new Uint8Array(count);
    let selected = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (state[layer * plane + y * w + x] === 1) {
          binary[(y + 1) * dims[0] + x + 1] = 1;
          selected++;
        }
      }
    if (!selected) throw new Error('起始和结束关键层都必须有当前 Mask 的选区。');
    const inside = new Float32Array(count),
      outside = new Float32Array(count);
    distanceTransform(binary, dims, spacing, false, inside);
    distanceTransform(binary, dims, spacing, true, outside);
    const result = new Float32Array(plane);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const index = (y + 1) * dims[0] + x + 1;
        result[y * w + x] = Math.sqrt(inside[index]) - Math.sqrt(outside[index]);
      }
    return result;
  }
  const mask = Uint8Array.from(state, value => (value === 1 ? 1 : 0));
  const total = keys[keys.length - 1] - keys[0] - keys.length + 1;
  let cached: { layer: number; distances: Float32Array },
    interpolatedSlices = 0,
    skippedSlices = 0;
  progress?.(0, total);
  for (let pair = 0; pair < keys.length - 1; pair++) {
    const start = keys[pair],
      end = keys[pair + 1];
    if (end - start === 1) continue;
    const first = cached?.layer === start ? cached.distances : signed(start),
      last = signed(end);
    cached = { layer: end, distances: last };
    for (let z = start + 1; z < end; z++) {
      const offset = z * plane;
      if (
        !options.replaceIntermediate &&
        state.subarray(offset, offset + plane).some(value => value === 1)
      ) {
        skippedSlices++;
      } else {
        const weight = (z - start) / (end - start);
        for (let i = 0; i < plane; i++)
          if (state[offset + i] !== 2)
            mask[offset + i] = first[i] * (1 - weight) + last[i] * weight > 0 ? 1 : 0;
        interpolatedSlices++;
      }
      progress?.(interpolatedSlices + skippedSlices, total);
    }
  }
  return {
    mask,
    components: undefined as number | undefined,
    removedComponents: undefined as number | undefined,
    interpolatedSlices,
    skippedSlices,
  };
}

/** Keep the seed's 6-connected component in a binary 3D mask. Mutates only this copy. */
import type { VolumeSplitAnalysis, VolumeComponent } from './splitMaskTypes';

export function markSeedComponent(
  mask: Uint8Array,
  dimensions: readonly number[],
  seed: readonly number[],
  initialQueueCapacity = 65536
) {
  if (
    dimensions.length !== 3 ||
    dimensions.some(n => !Number.isInteger(n) || n < 1) ||
    dimensions[0] * dimensions[1] * dimensions[2] !== mask.length
  ) {
    throw new Error('Mask 体数据尺寸不一致。');
  }
  if (
    seed.length !== 3 ||
    seed.some((n, axis) => !Number.isInteger(n) || n < 0 || n >= dimensions[axis])
  ) {
    throw new Error('点击位置超出当前影像范围，请重新选择种子点。');
  }
  const [width, height, depth] = dimensions;
  const plane = width * height;
  const start = seed[0] + width * seed[1] + plane * seed[2];
  if (mask[start] !== 1) throw new Error('请点击当前 Mask 已着色区域内要保留的目标。');

  // A ring queue stores the current frontier instead of allocating four bytes per voxel.
  if (!Number.isInteger(initialQueueCapacity) || initialQueueCapacity < 1)
    throw new Error('队列容量无效。');
  let queue = new Uint32Array(Math.min(mask.length, initialQueueCapacity));
  let head = 0;
  let size = 0;
  let kept = 0;
  const visit = (index: number) => {
    if (mask[index] !== 1) return;
    mask[index] = 2;
    kept++;
    if (size === queue.length) {
      const larger = new Uint32Array(Math.min(mask.length, queue.length * 2));
      for (let i = 0; i < size; i++) larger[i] = queue[(head + i) % queue.length];
      queue = larger;
      head = 0;
    }
    queue[(head + size) % queue.length] = index;
    size++;
  };
  visit(start);
  while (size) {
    const index = queue[head];
    head = (head + 1) % queue.length;
    size--;
    const x = index % width;
    const y = Math.floor(index / width) % height;
    const z = Math.floor(index / plane);
    if (x > 0) visit(index - 1);
    if (x + 1 < width) visit(index + 1);
    if (y > 0) visit(index - width);
    if (y + 1 < height) visit(index + width);
    if (z > 0) visit(index - plane);
    if (z + 1 < depth) visit(index + plane);
  }
  return { mask, kept };
}

/** Analyze all 6-connected regions without allocating a full uint32 volume. */
export function analyzeMaskComponents(
  mask: Uint8Array,
  dimensions: readonly number[],
  minimumVoxels = 1,
  maximumComponents = 32,
  initialQueueCapacity = 65536
): VolumeSplitAnalysis {
  if (
    dimensions.length !== 3 ||
    dimensions.some(n => !Number.isInteger(n) || n < 1) ||
    dimensions[0] * dimensions[1] * dimensions[2] !== mask.length
  )
    throw new Error('Mask 体数据尺寸不一致。');
  if (!Number.isInteger(minimumVoxels) || minimumVoxels < 1 || minimumVoxels > 1000000) {
    throw new Error('最小区域大小必须是 1 至 1000000 之间的整数体素数。');
  }
  if (
    !Number.isInteger(maximumComponents) ||
    maximumComponents < 2 ||
    maximumComponents > 253 ||
    !Number.isInteger(initialQueueCapacity) ||
    initialQueueCapacity < 1
  )
    throw new Error('拆分参数无效。');
  const [width, height, depth] = dimensions;
  const plane = width * height;
  const components: VolumeComponent[] = [];
  let ignoredRegions = 0;
  let ignoredVoxels = 0;
  let queue = new Uint32Array(Math.min(mask.length, initialQueueCapacity));
  // Only small regions need their positions retained, to leave them in the original mask.
  const smallRegion = new Uint32Array(Math.min(mask.length, minimumVoxels - 1));
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 1) continue;
    const code = components.length + 2;
    let head = 0;
    let size = 0;
    let voxelCount = 0;
    const visit = (index: number) => {
      if (mask[index] !== 1) return;
      mask[index] = code;
      if (voxelCount < smallRegion.length) smallRegion[voxelCount] = index;
      voxelCount++;
      if (size === queue.length) {
        const larger = new Uint32Array(Math.min(mask.length, queue.length * 2));
        for (let i = 0; i < size; i++) larger[i] = queue[(head + i) % queue.length];
        queue = larger;
        head = 0;
      }
      queue[(head + size) % queue.length] = index;
      size++;
    };
    visit(seed);
    while (size) {
      const index = queue[head];
      head = (head + 1) % queue.length;
      size--;
      const x = index % width;
      const y = Math.floor(index / width) % height;
      const z = Math.floor(index / plane);
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
      if (z > 0) visit(index - plane);
      if (z + 1 < depth) visit(index + plane);
    }
    if (voxelCount < minimumVoxels) {
      for (let i = 0; i < voxelCount; i++) mask[smallRegion[i]] = 255;
      ignoredRegions++;
      ignoredVoxels += voxelCount;
    } else {
      components.push({ code, voxelCount, seedIndex: seed });
      if (components.length > maximumComponents) {
        throw new Error(
          `可拆分区域超过 ${maximumComponents} 个，请提高最小区域体素数后重试；原 Mask 未改变。`
        );
      }
    }
  }
  components.sort((a, b) => b.voxelCount - a.voxelCount || a.seedIndex - b.seedIndex);
  return { mask, components, ignoredRegions, ignoredVoxels };
}

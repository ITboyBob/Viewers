/** Independent direct-neighborhood / dense-queue reference; no production imports. */
function refinementReference(state, dimensions, spacing, options) {
  const { operation, radiusMm: radius = 1, minimumVolumeMm3 = 0, seed } = options;
  const [width, height, depth] = dimensions,
    total = state.length,
    plane = width * height;
  if (['largest', 'removeSmall', 'removeSeed'].includes(operation)) {
    const visited = new Uint8Array(total),
      output = state.slice(),
      queue = new Uint32Array(total),
      regions = [];
    function region(start) {
      let head = 0,
        tail = 1;
      queue[0] = start;
      visited[start] = 1;
      while (head < tail) {
        const i = queue[head++],
          x = i % width,
          y = Math.floor(i / width) % height,
          z = Math.floor(i / plane);
        for (const next of [
          x ? i - 1 : -1,
          x + 1 < width ? i + 1 : -1,
          y ? i - width : -1,
          y + 1 < height ? i + width : -1,
          z ? i - plane : -1,
          z + 1 < depth ? i + plane : -1,
        ])
          if (next >= 0 && state[next] === 1 && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
      }
      return tail;
    }
    if (operation === 'removeSeed') {
      const count = region(seed[0] + width * seed[1] + plane * seed[2]);
      for (let j = 0; j < count; j++) output[queue[j]] = 0;
      return { output, components: undefined, removedComponents: 1 };
    }
    let largestSeed = -1,
      largest = 0,
      removedComponents = 0;
    for (let i = 0; i < total; i++) {
      if (state[i] !== 1 || visited[i]) continue;
      const count = region(i);
      regions.push(count);
      if (count > largest) {
        largest = count;
        largestSeed = i;
      }
      if (
        operation === 'removeSmall' &&
        count * spacing.reduce((a, b) => a * b, 1) < minimumVolumeMm3 - 1e-9
      ) {
        for (let j = 0; j < count; j++) output[queue[j]] = 0;
        removedComponents++;
      }
    }
    if (operation === 'largest' && largestSeed >= 0) {
      visited.fill(0);
      const count = region(largestSeed);
      for (let i = 0; i < total; i++) if (output[i] === 1) output[i] = 0;
      for (let j = 0; j < count; j++) output[queue[j]] = 1;
      removedComponents = regions.length - 1;
    }
    return { output, components: regions.length, removedComponents };
  }
  const pad = dimensions.map((n, i) => (n === 1 ? 0 : Math.ceil(radius / spacing[i]) * 3 + 1));
  const dims = dimensions.map((n, i) => n + 2 * pad[i]),
    count = dims.reduce((a, b) => a * b, 1);
  const offset = (x, y, z) => x + dims[0] * (y + dims[1] * z);
  let mask = new Uint8Array(count);
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const value = state[x + width * (y + height * z)],
          i = offset(x + pad[0], y + pad[1], z + pad[2]);
        mask[i] = value === 1;
      }
  const offsets = [],
    r = dimensions.map((n, i) => (n === 1 ? 0 : Math.floor(radius / spacing[i] + 1e-8)));
  for (let z = -r[2]; z <= r[2]; z++)
    for (let y = -r[1]; y <= r[1]; y++)
      for (let x = -r[0]; x <= r[0]; x++)
        if (
          (x * spacing[0]) ** 2 + (y * spacing[1]) ** 2 + (z * spacing[2]) ** 2 <=
          radius * radius + 1e-7
        )
          offsets.push([x, y, z]);
  const steps = {
    dilate: ['dilate'],
    erode: ['erode'],
    open: ['erode', 'dilate'],
    close: ['dilate', 'erode'],
    smooth: ['erode', 'dilate', 'dilate', 'erode'],
  }[operation];
  for (const step of steps) {
    const next = new Uint8Array(count);
    // Work from selected voxels; dilation visits neighbors, erosion checks its own neighborhood.
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++)
        for (let x = 0; x < dims[0]; x++) {
          const i = offset(x, y, z);
          if (!mask[i]) continue;
          if (step === 'dilate') {
            for (const [dx, dy, dz] of offsets) {
              const a = x + dx,
                b = y + dy,
                c = z + dz;
              if (a >= 0 && a < dims[0] && b >= 0 && b < dims[1] && c >= 0 && c < dims[2])
                next[offset(a, b, c)] = 1;
            }
          } else {
            let keep = true;
            for (const [dx, dy, dz] of offsets) {
              const a = x + dx,
                b = y + dy,
                c = z + dz;
              if (
                a < 0 ||
                a >= dims[0] ||
                b < 0 ||
                b >= dims[1] ||
                c < 0 ||
                c >= dims[2] ||
                !mask[offset(a, b, c)]
              ) {
                keep = false;
                break;
              }
            }
            if (keep) next[i] = 1;
          }
        }
    mask = next;
  }
  const output = state.slice();
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = x + width * (y + height * z);
        if (state[i] !== 2) output[i] = mask[offset(x + pad[0], y + pad[1], z + pad[2])];
      }
  return { output };
}
module.exports = { refinementReference };

/** Independent nearest-point reference for small keyframe contours in any source grid. */
function interpolationReference(state, dimensions, spacing, options) {
  const [w, h] = dimensions,
    plane = w * h;
  const keys = (options.keyframes || [options.startSlice, options.endSlice]).map(v => v - 1);
  const output = state.slice();
  let interpolatedSlices = 0,
    skippedSlices = 0;
  for (let pair = 0; pair < keys.length - 1; pair++) {
    const start = keys[pair],
      end = keys[pair + 1];
    if (end - start === 1) continue;
    const foreground = [[], []];
    let minX = w,
      maxX = -1,
      minY = h,
      maxY = -1;
    for (const [k, layer] of [start, end].entries())
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (state[layer * plane + y * w + x] !== 1) continue;
          foreground[k].push([x, y]);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
    const background = [[], []];
    for (const [k, layer] of [start, end].entries())
      for (let y = minY - 1; y <= maxY + 1; y++)
        for (let x = minX - 1; x <= maxX + 1; x++)
          if (x < 0 || x >= w || y < 0 || y >= h || state[layer * plane + y * w + x] !== 1)
            background[k].push([x, y]);
    const signed = (k, x, y) => {
      const nearest = points => {
        let minimum = Infinity;
        for (const [a, b] of points)
          minimum = Math.min(minimum, ((x - a) * spacing[0]) ** 2 + ((y - b) * spacing[1]) ** 2);
        return Math.sqrt(Math.fround(minimum));
      };
      return Math.fround(nearest(background[k]) - nearest(foreground[k]));
    };
    const first = [],
      last = [];
    for (let y = Math.max(0, minY); y <= Math.min(h - 1, maxY); y++)
      for (let x = Math.max(0, minX); x <= Math.min(w - 1, maxX); x++) {
        first.push(signed(0, x, y));
        last.push(signed(1, x, y));
      }
    for (let z = start + 1; z < end; z++) {
      const base = z * plane;
      if (!options.replaceIntermediate && state.subarray(base, base + plane).some(v => v === 1)) {
        skippedSlices++;
        continue;
      }
      interpolatedSlices++;
      for (let i = 0; i < plane; i++) if (state[base + i] !== 2) output[base + i] = 0;
      const weight = (z - start) / (end - start);
      let k = 0;
      for (let y = Math.max(0, minY); y <= Math.min(h - 1, maxY); y++)
        for (let x = Math.max(0, minX); x <= Math.min(w - 1, maxX); x++, k++)
          if (state[base + y * w + x] !== 2)
            output[base + y * w + x] = Number(first[k] * (1 - weight) + last[k] * weight > 0);
    }
  }
  return { output, interpolatedSlices, skippedSlices };
}
module.exports = { interpolationReference };

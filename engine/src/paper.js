// Prepares the paper scan once at load: flattens its large light/dark patches
// and makes it tile seamlessly, so it can repeat across the stamp at any grain size.

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
}

export function preparePaper(image) {
  const w = image.width;
  const h = image.height;
  const ctx = canvas2d(w, h);
  ctx.drawImage(image, 0, 0);
  const src = ctx.getImageData(0, 0, w, h);

  // Very blurry copy (shrink to ~1/32 then scale back up) = the scan's broad lighting.
  const small = canvas2d(Math.max(2, Math.round(w / 32)), Math.max(2, Math.round(h / 32)));
  small.imageSmoothingQuality = 'high';
  small.drawImage(image, 0, 0, small.canvas.width, small.canvas.height);
  const big = canvas2d(w, h);
  big.imageSmoothingQuality = 'high';
  big.drawImage(small.canvas, 0, 0, w, h);
  const broad = big.getImageData(0, 0, w, h).data;

  // Divide out the broad lighting, keeping only the grain around the average color.
  const mean = [0, 0, 0];
  for (let i = 0; i < src.data.length; i += 4) for (let k = 0; k < 3; k++) mean[k] += src.data[i + k];
  for (let k = 0; k < 3; k++) mean[k] /= w * h;
  const flat = new Float32Array(w * h * 3);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    for (let k = 0; k < 3; k++) flat[p * 3 + k] = (src.data[i + k] / Math.max(broad[i + k], 1)) * mean[k];
  }

  // Seamless tile: blend with a copy shifted by half the size. Near the edges the shifted
  // copy takes over (its middle is continuous there); in the middle the original wins.
  // The blend is divided by its length so the grain keeps its strength where they mix.
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const wy = 1 - Math.abs((2 * y) / (h - 1) - 1);
    const ys = (y + (h >> 1)) % h;
    for (let x = 0; x < w; x++) {
      const wx = 1 - Math.abs((2 * x) / (w - 1) - 1);
      const a = wx * wy;
      const b = 1 - a;
      const norm = 1 / Math.sqrt(a * a + b * b);
      const p1 = (y * w + x) * 3;
      const p2 = (ys * w + ((x + (w >> 1)) % w)) * 3;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = mean[k] + (a * (flat[p1 + k] - mean[k]) + b * (flat[p2 + k] - mean[k])) * norm;
        out.data[o + k] = v;
      }
      out.data[o + 3] = 255;
    }
  }

  // Spread of brightness around the average: lets shaders turn brightness into "bump height".
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < out.data.length; i += 4) {
    const l = (0.299 * out.data[i] + 0.587 * out.data[i + 1] + 0.114 * out.data[i + 2]) / 255;
    sum += l;
    sumSq += l * l;
  }
  const n = w * h;
  const lumStd = Math.sqrt(Math.max(sumSq / n - (sum / n) ** 2, 1e-6));

  return { pixels: out, mean: mean.map((m) => m / 255), lumStd };
}

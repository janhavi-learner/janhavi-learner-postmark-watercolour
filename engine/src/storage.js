// Save format for a painting: dried paint, wet paint and how far each wet tile has dried.
//
// Only tiles with paint are stored, as the exact half-float values the GPU holds (lossless),
// delta-filtered per pixel and gzip-compressed. Layout (little-endian):
//
//   header   'PMWC' (4 bytes), format version (u16), compression (u8: 0 none, 1 gzip), reserved (u8)
//   body     width, height, tile size, dry tile count, wet tile count, reserved (u16 each)
//            dry tile indices (u16 each), wet tile indices (u16 each), padding to 4 bytes,
//            wet tile ages in seconds (f32 each)
//            dry tiles: r, g, b per pixel (u16, delta-filtered), row by row
//            wet tiles: r, g, b, wetness per pixel (u16, delta-filtered)
//            checksum of everything above (u32, FNV-1a)
//
// A tile at the right or bottom edge is cut to the painting's size.

export const FORMAT_VERSION = 1;
const MAGIC = [0x50, 0x4d, 0x57, 0x43]; // 'PMWC'
const HEADER_BYTES = 8;
const DRY_CHANNELS = 3;
const WET_CHANNELS = 4;

// Phones are little-endian; then tile data can be copied as whole 16-bit arrays.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Each value minus the same channel of the previous pixel: smooth paint becomes mostly
// small numbers, which compress far better.
function deltaEncode(values, channels, out) {
  for (let i = 0; i < values.length; i++) out[i] = i < channels ? values[i] : (values[i] - values[i - channels]) & 0xffff;
  return out;
}

function deltaDecode(values, channels) {
  for (let i = channels; i < values.length; i++) values[i] = (values[i] + values[i - channels]) & 0xffff;
  return values;
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function tileSize(index, layout) {
  const tilesX = Math.ceil(layout.width / layout.tile);
  const x = (index % tilesX) * layout.tile;
  const y = Math.floor(index / tilesX) * layout.tile;
  return Math.min(layout.tile, layout.width - x) * Math.min(layout.tile, layout.height - y);
}

// layout: { width, height, tile }
// dryTiles: [{ index, values: Uint16Array (r, g, b per pixel) }]
// wetTiles: [{ index, age, values: Uint16Array (r, g, b, wetness per pixel) }]
export async function encodePainting(layout, dryTiles, wetTiles) {
  const indexBytes = 12 + 2 * (dryTiles.length + wetTiles.length);
  const agesAt = Math.ceil(indexBytes / 4) * 4;
  const dataAt = agesAt + 4 * wetTiles.length;
  const dataBytes = 2 * (dryTiles.reduce((n, t) => n + t.values.length, 0) + wetTiles.reduce((n, t) => n + t.values.length, 0));
  const body = new Uint8Array(dataAt + dataBytes + 4);
  const view = new DataView(body.buffer);
  [layout.width, layout.height, layout.tile, dryTiles.length, wetTiles.length, 0].forEach((v, i) => view.setUint16(i * 2, v, true));
  let at = 12;
  for (const t of dryTiles) { view.setUint16(at, t.index, true); at += 2; }
  for (const t of wetTiles) { view.setUint16(at, t.index, true); at += 2; }
  wetTiles.forEach((t, i) => view.setFloat32(agesAt + i * 4, t.age, true));
  at = dataAt;
  for (const [tiles, channels] of [[dryTiles, DRY_CHANNELS], [wetTiles, WET_CHANNELS]]) {
    for (const t of tiles) {
      if (LITTLE_ENDIAN) {
        deltaEncode(t.values, channels, new Uint16Array(body.buffer, at, t.values.length));
      } else {
        const delta = deltaEncode(t.values, channels, new Uint16Array(t.values.length));
        for (let i = 0; i < delta.length; i++) view.setUint16(at + i * 2, delta[i], true);
      }
      at += t.values.length * 2;
    }
  }
  view.setUint32(at, fnv1a(body.subarray(0, at)), true);

  const compressed = canCompress();
  const payload = compressed ? await pipe(body, new CompressionStream('gzip')) : body;
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  new DataView(header.buffer).setUint16(4, FORMAT_VERSION, true);
  header[6] = compressed ? 1 : 0;
  return new Blob([header, payload], { type: 'application/octet-stream' });
}

const damaged = (why) => new Error(`This saved painting can't be loaded: ${why}`);

// Returns { dryTiles, wetTiles } in the same shape encodePainting takes, or throws a clear error.
export async function decodePainting(data, layout) {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
    : data instanceof ArrayBuffer ? new Uint8Array(data)
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : null;
  if (!bytes || bytes.length < HEADER_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) throw damaged('it is not a Postmark painting.');
  const version = new DataView(bytes.buffer, bytes.byteOffset).getUint16(4, true);
  if (version !== FORMAT_VERSION) throw damaged(`it was saved in format ${version}; this engine reads format ${FORMAT_VERSION}.`);

  let body = bytes.subarray(HEADER_BYTES);
  if (bytes[6] === 1) {
    if (!canCompress()) throw damaged('this browser cannot decompress it.');
    try {
      body = await pipe(body, new DecompressionStream('gzip'));
    } catch {
      throw damaged('the data is damaged.');
    }
  } else if (bytes[6] !== 0) {
    throw damaged('unknown compression.');
  }
  if (body.length < 16) throw damaged('the data is cut short.');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const [width, height, tile, nDry, nWet] = [0, 1, 2, 3, 4].map((i) => view.getUint16(i * 2, true));
  if (width !== layout.width || height !== layout.height || tile !== layout.tile) {
    throw damaged(`it is ${width} × ${height} (tiles ${tile}); this canvas paints ${layout.width} × ${layout.height} (tiles ${layout.tile}).`);
  }
  const tileCount = Math.ceil(width / tile) * Math.ceil(height / tile);
  const indexBytes = 12 + 2 * (nDry + nWet);
  const agesAt = Math.ceil(indexBytes / 4) * 4;
  const dataAt = agesAt + 4 * nWet;
  if (body.length < dataAt + 4) throw damaged('the data is cut short.');
  const readIndices = (from, n) => {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const index = view.getUint16(from + i * 2, true);
      if (index >= tileCount || seen.has(index)) throw damaged('the tile list is damaged.');
      seen.add(index);
      out.push(index);
    }
    return out;
  };
  const dryIdx = readIndices(12, nDry);
  const wetIdx = readIndices(12 + 2 * nDry, nWet);
  const expected = dataAt + 2 * (dryIdx.reduce((n, i) => n + tileSize(i, layout) * DRY_CHANNELS, 0)
    + wetIdx.reduce((n, i) => n + tileSize(i, layout) * WET_CHANNELS, 0)) + 4;
  if (body.length !== expected) throw damaged('the data is the wrong size.');
  if (view.getUint32(expected - 4, true) !== fnv1a(body.subarray(0, expected - 4))) throw damaged('the checksum does not match.');

  let at = dataAt;
  const readTile = (index, channels) => {
    const n = tileSize(index, layout) * channels;
    let values;
    if (LITTLE_ENDIAN) {
      values = new Uint16Array(body.buffer.slice(body.byteOffset + at, body.byteOffset + at + n * 2));
    } else {
      values = new Uint16Array(n);
      for (let i = 0; i < n; i++) values[i] = view.getUint16(at + i * 2, true);
    }
    at += n * 2;
    return deltaDecode(values, channels);
  };
  const dryTiles = dryIdx.map((index) => ({ index, values: readTile(index, DRY_CHANNELS) }));
  const wetTiles = wetIdx.map((index, i) => ({ index, age: view.getFloat32(agesAt + i * 4, true), values: readTile(index, WET_CHANNELS) }));
  for (const t of wetTiles) if (!Number.isFinite(t.age) || t.age < 0) throw damaged('the drying times are damaged.');
  return { dryTiles, wetTiles };
}

// Float -> half-float bits (for GPUs that can only read paint back as 32-bit floats).
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return exp < -10 ? sign : sign | ((((mant | 0x800000) >>> (1 - exp)) + 0x1000) >>> 13);
  if (exp >= 31) return sign | 0x7c00;
  return sign + (exp << 10) + ((mant + 0x1000) >>> 13);
}

// Cuts tiles out of one read-back rectangle (RGBA per pixel, as halves or floats), keeping
// `channels` values per pixel. `rect` is in paint pixels, rows bottom-up like the GPU's.
export function extractTiles(pixels, rect, indices, layout, channels) {
  const tilesX = Math.ceil(layout.width / layout.tile);
  const halves = pixels instanceof Uint16Array;
  return indices.map((index) => {
    const x = (index % tilesX) * layout.tile;
    const y = Math.floor(index / tilesX) * layout.tile;
    const w = Math.min(layout.tile, layout.width - x);
    const h = Math.min(layout.tile, layout.height - y);
    const values = new Uint16Array(w * h * channels);
    let o = 0;
    for (let row = 0; row < h; row++) {
      let s = ((y - rect.y + row) * rect.w + (x - rect.x)) * 4;
      for (let col = 0; col < w; col++, s += 4) {
        for (let c = 0; c < channels; c++) values[o++] = halves ? pixels[s + c] : toHalf(pixels[s + c]);
      }
    }
    return { index, values };
  });
}

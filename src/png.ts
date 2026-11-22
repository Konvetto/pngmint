/**
 * An indexed PNG (colour type 3): IHDR, PLTE, tRNS when a colour is see-through, IDAT, IEND.
 * The smallest bit depth that holds the palette (1, 2, 4 or 8). Rows go unfiltered by default:
 * on palette indices every PNG filter lost on the benchmark set (the adaptive libpng heuristic
 * by 15 percent over 56 files, see bench/filters.md), as the PNG specification warns for colour
 * type 3. The `adaptive` filter is there for callers who want it: per row, the filter (none,
 * sub, up, average or Paeth) with the smallest sum of absolute differences, computed on the
 * packed bytes of the row with a distance of one byte. Deflate is the platform's
 * CompressionStream unless the caller brings a compressor.
 */

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The fewest bits per pixel a PNG allows for this many palette entries. */
export const bitDepth = (colors: number): 1 | 2 | 4 | 8 =>
  colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8;

/**
 * How the rows are filtered before deflate: `none` (the default) writes raw rows, `adaptive`
 * picks one of the five PNG filters per row by the smallest sum of absolute differences (what
 * libpng does).
 */
export type Filter = 'adaptive' | 'none';

/** Packs one row of indices into `out` at `at`, most significant pixel first. */
function pack(
  indices: Uint8Array,
  from: number,
  width: number,
  depth: number,
  out: Uint8Array,
  at: number,
): void {
  const per = 8 / depth;
  let byte = 0,
    filled = 0,
    o = at;
  for (let x = 0; x < width; x++) {
    byte = (byte << depth) | indices[from + x]!;
    if (++filled === per) {
      out[o++] = byte;
      byte = 0;
      filled = 0;
    }
  }
  if (filled) out[o] = byte << (8 - filled * depth);
}

/** libpng's cost of a filtered byte: its distance from zero as a signed value. */
const cost = (v: number) => (v < 128 ? v : 256 - v);

/**
 * Sums the absolute differences each of the five filters would leave on a row of `n` bytes
 * (`cur`), given the row above (`prev`, zeros for the first row). Returns the filter with the
 * smallest sum, the first one on a tie (none, sub, up, average, Paeth).
 */
function pickFilter(cur: Uint8Array, prev: Uint8Array, n: number): number {
  let s0 = 0,
    s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0;
  let a = 0,
    c = 0;
  for (let x = 0; x < n; x++) {
    const v = cur[x]!,
      b = prev[x]!;
    s0 += cost(v);
    s1 += cost((v - a) & 255);
    s2 += cost((v - b) & 255);
    s3 += cost((v - ((a + b) >> 1)) & 255);
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    s4 += cost((v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255);
    a = v;
    c = b;
  }
  let best = 0,
    min = s0;
  for (const [type, sum] of [s1, s2, s3, s4].entries())
    if (sum < min) {
      best = type + 1;
      min = sum;
    }
  return best;
}

/** Writes `cur` filtered with `type` to `out` at `at`. */
function applyFilter(
  type: number,
  cur: Uint8Array,
  prev: Uint8Array,
  n: number,
  out: Uint8Array,
  at: number,
): void {
  let a = 0,
    c = 0;
  for (let x = 0; x < n; x++) {
    const v = cur[x]!,
      b = prev[x]!;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[at + x] = (v - pred) & 255;
    a = v;
    c = b;
  }
}

/** Rows of packed indices, each after its filter byte. */
function rows(
  indices: Uint8Array,
  width: number,
  height: number,
  depth: number,
  filter: Filter,
): Uint8Array {
  const bpl = Math.ceil((width * depth) / 8);
  const out = new Uint8Array((bpl + 1) * height);
  // At 8 bits a row is a slice of the indices; below, it is packed into one of two scratch rows
  // (the current one and the one above).
  const scratch = depth === 8 ? [] : [new Uint8Array(bpl), new Uint8Array(bpl)];
  let prev: Uint8Array = new Uint8Array(bpl);
  for (let y = 0; y < height; y++) {
    const at = y * (bpl + 1);
    let row: Uint8Array;
    if (depth === 8) row = indices.subarray(y * width, (y + 1) * width);
    else pack(indices, y * width, width, depth, (row = scratch[y & 1]!), 0);
    if (filter === 'none') {
      out.set(row, at + 1);
      continue;
    }
    const type = pickFilter(row, prev, bpl);
    out[at] = type;
    if (type === 0) out.set(row, at + 1);
    else applyFilter(type, row, prev, bpl, out, at + 1);
    prev = row;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * Compresses raw scanlines into a zlib stream (RFC 1950, what IDAT holds). The built-in one is
 * {@link nativeDeflate}; a caller may bring a stronger or synchronous one, such as fflate's
 * `zlibSync(raw, { level: 9 })`.
 */
export type Deflate = (raw: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** The platform's `CompressionStream('deflate')`: zlib format at the engine's default level. */
export async function nativeDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Writes an indexed PNG. `palette` is straight (not premultiplied) RGBA, 4 bytes per colour,
 * 1 to 256 colours; `indices` holds one palette index per pixel, row by row. Returns the file
 * synchronously when `deflate` does, a promise otherwise.
 */
export function writePng(
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
  deflate: Deflate,
  filter: Filter = 'none',
): Uint8Array | Promise<Uint8Array> {
  const colors = palette.length / 4;
  const depth = bitDepth(colors);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([depth, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(colors * 3);
  let lastAlpha = -1;
  for (let k = 0; k < colors; k++) {
    plte.set(palette.subarray(k * 4, k * 4 + 3), k * 3);
    if (palette[k * 4 + 3] !== 255) lastAlpha = k;
  }
  const head = [chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (lastAlpha >= 0) {
    const trns = new Uint8Array(lastAlpha + 1);
    for (let k = 0; k <= lastAlpha; k++) trns[k] = palette[k * 4 + 3]!;
    head.push(chunk('tRNS', trns));
  }
  const compressed = deflate(rows(indices, width, height, depth, filter));
  return compressed instanceof Uint8Array
    ? assemble(head, compressed)
    : compressed.then((c) => assemble(head, c));
}

function assemble(head: Uint8Array[], compressed: Uint8Array): Uint8Array {
  if (!(compressed instanceof Uint8Array))
    throw new TypeError('the deflate option must return a Uint8Array');
  const parts = [...head, chunk('IDAT', compressed), chunk('IEND', new Uint8Array())];
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const out = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0));
  out.set(signature);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

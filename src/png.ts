/**
 * An indexed PNG (colour type 3): IHDR, PLTE, tRNS when a colour is see-through, IDAT, IEND.
 * The smallest bit depth that holds the palette (1, 2, 4 or 8). Rows go unfiltered: for palette
 * indices the PNG filters lost on our test set (by 31% on a poster) or won by under 1%, at twice
 * the time. Deflate is the platform's CompressionStream unless the caller brings a compressor.
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

/** Rows of packed indices, each after its filter byte (0, none). */
function rows(indices: Uint8Array, width: number, height: number, depth: number): Uint8Array {
  const bpl = Math.ceil((width * depth) / 8);
  const out = new Uint8Array((bpl + 1) * height);
  const per = 8 / depth;
  for (let y = 0; y < height; y++) {
    const at = y * (bpl + 1) + 1,
      from = y * width;
    if (depth === 8) {
      out.set(indices.subarray(from, from + width), at);
      continue;
    }
    // Pack `per` indices into each byte, most significant first.
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
  const compressed = deflate(rows(indices, width, height, depth));
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

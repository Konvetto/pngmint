/** Test helpers: a tiny PNG reader for our own output, deterministic images, independent decoders. */
import { unzlibSync, zlibSync } from 'fflate';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { crc32 } from '../src/png.js';

/** The deterministic compressor the tests and Konvetto use: fflate at level 9. */
export const deflate = (raw: Uint8Array): Uint8Array => zlibSync(raw, { level: 9 });

export function readPng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const crcOk = view.getUint32(at + 8 + length) === crc32(png, at + 4, at + 8 + length);
    chunks.push({ type, data, crcOk });
    at += 12 + length;
  }
  const get = (t: string) => chunks.find((c) => c.type === t)?.data;
  const ihdrData = get('IHDR')!;
  const ihdr = new DataView(ihdrData.buffer, ihdrData.byteOffset, 13);
  const width = ihdr.getUint32(0),
    height = ihdr.getUint32(4);
  const depth = ihdrData[8]!,
    type = ihdrData[9]!;
  const plte = get('PLTE')!,
    trns = get('tRNS');
  const colors = plte.length / 3;
  const palette = new Uint8Array(colors * 4);
  for (let k = 0; k < colors; k++) {
    palette.set(plte.subarray(k * 3, k * 3 + 3), k * 4);
    palette[k * 4 + 3] = trns && k < trns.length ? trns[k]! : 255;
  }
  const raw = unzlibSync(get('IDAT')!);
  const bpl = Math.ceil((width * depth) / 8);
  const indices = new Uint8Array(width * height);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    filters.push(raw[y * (bpl + 1)]!);
    const line = raw.subarray(y * (bpl + 1) + 1, (y + 1) * (bpl + 1));
    const per = 8 / depth;
    for (let x = 0; x < width; x++) {
      indices[y * width + x] =
        depth === 8
          ? line[x]!
          : (line[Math.floor(x / per)]! >> (8 - depth - (x % per) * depth)) & ((1 << depth) - 1);
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < indices.length; i++)
    rgba.set(palette.subarray(indices[i]! * 4, indices[i]! * 4 + 4), i * 4);
  return {
    chunks,
    width,
    height,
    depth,
    type,
    palette,
    indices,
    filters,
    rgba,
    signature: [...png.subarray(0, 8)],
  };
}

/** Straight RGBA as pngjs decodes it (pure JS, checks CRCs). */
export function decodeWithPngjs(png: Uint8Array) {
  const out = PNG.sync.read(Buffer.from(png), { checkCRC: true });
  return { width: out.width, height: out.height, rgba: new Uint8Array(out.data) };
}

/** Straight RGBA as sharp (libvips) decodes it. */
export async function decodeWithSharp(png: Uint8Array) {
  const { data, info } = await sharp(Buffer.from(png), { failOn: 'error' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data) };
}

/** A seeded generator in [0, 1). */
export const random = (seed: number) => () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/** An image that cycles through `colors` in a scrambled order. */
export function flat(w: number, h: number, colors: number[][]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(colors[(i * 31 + (i >> 3)) % colors.length]!, i * 4);
  return rgba;
}

/** Opaque noise with a seed. */
export function noise(w: number, h: number, seed = 1): Uint8Array {
  const r = random(seed);
  return new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : r() * 256));
}

/** A horizontal gradient from `from` to `to`, opaque. */
export function gradient(w: number, h: number, from: number[], to: number[]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = w === 1 ? 0 : x / (w - 1);
      for (let c = 0; c < 3; c++)
        rgba[(y * w + x) * 4 + c] = Math.round(from[c]! + (to[c]! - from[c]!) * t);
      rgba[(y * w + x) * 4 + 3] = 255;
    }
  return rgba;
}

/** Pixels where alpha is 0 count as equal whatever their colour; everything else must match. */
export function expectSamePixels(want: Uint8Array, got: Uint8Array) {
  if (want.length !== got.length) throw new Error(`length ${got.length}, want ${want.length}`);
  for (let i = 0; i < want.length; i += 4) {
    if (want[i + 3] === 0) {
      if (got[i + 3] !== 0) throw new Error(`pixel ${i / 4}: alpha ${got[i + 3]}, want 0`);
      continue;
    }
    for (let c = 0; c < 4; c++)
      if (want[i + c] !== got[i + c])
        throw new Error(
          `pixel ${i / 4}: [${got.subarray(i, i + 4).join()}], want [${want.subarray(i, i + 4).join()}]`,
        );
  }
}

/** Mean squared error per pixel over the channels where either pixel is visible, straight RGBA. */
export function mse(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const fa = a[i + 3]! / 255,
      fb = b[i + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const d = a[i + c]! * fa - b[i + c]! * fb;
      sum += d * d;
    }
    const d = a[i + 3]! - b[i + 3]!;
    sum += d * d;
  }
  return sum / (a.length / 4);
}

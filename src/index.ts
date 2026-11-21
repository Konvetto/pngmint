/**
 * Palette PNGs in pure TypeScript: histogram, median cut, k-means, selective dithering and an
 * indexed PNG writer. With `minQuality` the palette gets as small as the image allows: a
 * screenshot keeps a few colours, a photo gets up to `maxColors`. Quality is measured against
 * the image's own range of brightness, so a dark or pale photo is not judged as if it used black
 * to white.
 */
import { histogram, type Histogram, type Rgba } from './histogram.js';
import { emptyPalette, finish, fromStraight, medianCut, refine, type Palette } from './palette.js';
import { writePng, type DeflateLevel } from './png.js';
import { remap } from './remap.js';

export type { Rgba } from './histogram.js';
export type { DeflateLevel } from './png.js';

/** Options shared by {@link quantize} and {@link createPalette}. */
export interface PaletteOptions {
  /** Most palette entries, 2 to 256. A fully transparent colour, when needed, counts. Default 256. */
  maxColors?: number;
  /**
   * The least quality to keep, in dB: the palette gets fewer colours while it holds. Measured
   * like PSNR but against the image's own range of brightness (see {@link QuantizeResult.quality}).
   * Undefined (the default) keeps `maxColors`.
   */
  minQuality?: number;
  /** k-means rounds for the final palette. 0 is plain median cut. Default 2. */
  rounds?: number;
}

export interface QuantizeOptions extends PaletteOptions {
  /**
   * 0 to 1: how much quantization error spreads to neighbouring pixels on smooth areas. Edges
   * and text are never dithered, nor is an image with few colours or a palette that already
   * fits well (quality above 42 dB). Default 0.
   */
  dither?: number;
  /** Deflate level 0 to 9. Default 9, or 6 above 4 million pixels (about 0.5% larger, 40% faster). */
  level?: DeflateLevel;
}

export interface PaletteResult {
  /** Straight (not premultiplied) RGBA, 4 bytes per colour. Fully transparent first, then dark to light. */
  palette: Uint8Array;
  /** Number of colours in `palette`. */
  colors: number;
  /** Index of the fully transparent entry, or -1 when the image has no fully transparent pixel. */
  transparentIndex: number;
  /** Standard PSNR of the palette fit, in dB, peak 255: Infinity when every colour is kept. */
  psnr: number;
  /** The same fit measured against the image's own brightness range: what `minQuality` compares with. */
  quality: number;
  /** True when every colour of the image is in the palette (the output is lossless). */
  exact: boolean;
}

export interface QuantizeResult extends PaletteResult {
  /** The indexed PNG file. */
  png: Uint8Array;
  width: number;
  height: number;
  /** One palette index per pixel, row by row. */
  indices: Uint8Array;
}

/** Presets matching the strength steps of the Compress PNG tool on konvetto.com. */
export const presets = {
  /** Up to 256 colours while the fit stays above 42 dB; no dithering (it only added bytes here). */
  quality: { maxColors: 256, minQuality: 42, dither: 0 },
  /** Up to 128 colours while above 38 dB, light dithering on gradients. */
  balanced: { maxColors: 128, minQuality: 38, dither: 0.4 },
  /** Up to 64 colours while above 35 dB. */
  small: { maxColors: 64, minQuality: 35, dither: 0.65 },
  /** Up to 32 colours while above 32 dB. */
  tiny: { maxColors: 32, minQuality: 32, dither: 0.6 },
} as const satisfies Record<string, QuantizeOptions>;

/** Palette quality above which dithering only adds bytes (no banding left to hide). */
const NO_DITHER_ABOVE = 42;
/** Images with fewer colours are flat art or screenshots: never dithered. */
const FLAT = 4096;
/** Above this many pixels deflate runs at level 6 unless told otherwise. */
const BIG = 4_000_000;
/** PNG's limit for width and height. */
const MAX_SIDE = 0x7fffffff;

/**
 * PSNR of a squared error per pixel summed over `channels` (3 for an opaque image, 4 with
 * alpha), against `peak`.
 */
export const psnrOf = (error: number, peak = 255, channels = 4): number =>
  error <= 0 ? Infinity : 10 * Math.log10((peak * peak * channels) / error);

const isInt = (v: unknown): v is number => Number.isInteger(v);

function checkImage(rgba: Rgba, width: number, height: number): void {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray))
    throw new TypeError('rgba must be a Uint8Array or Uint8ClampedArray of RGBA bytes');
  if (!isInt(width) || !isInt(height) || width < 1 || height < 1)
    throw new RangeError(`width and height must be positive integers, got ${width}x${height}`);
  if (width > MAX_SIDE || height > MAX_SIDE)
    throw new RangeError(`width and height must be at most ${MAX_SIDE}`);
  if (rgba.length !== width * height * 4)
    throw new RangeError(
      `rgba has ${rgba.length} bytes, expected ${width * height * 4} for ${width}x${height}`,
    );
}

function checkPaletteOptions(o: PaletteOptions): void {
  if (o.maxColors !== undefined && (!isInt(o.maxColors) || o.maxColors < 2 || o.maxColors > 256))
    throw new RangeError(`maxColors must be an integer from 2 to 256, got ${o.maxColors}`);
  if (
    o.minQuality !== undefined &&
    (typeof o.minQuality !== 'number' || Number.isNaN(o.minQuality))
  )
    throw new RangeError(`minQuality must be a number of dB, got ${o.minQuality}`);
  if (o.rounds !== undefined && (!isInt(o.rounds) || o.rounds < 0))
    throw new RangeError(`rounds must be a non-negative integer, got ${o.rounds}`);
}

function checkDither(dither: number | undefined): void {
  if (dither !== undefined && !(typeof dither === 'number' && dither >= 0 && dither <= 1))
    throw new RangeError(`dither must be a number from 0 to 1, got ${dither}`);
}

function checkLevel(level: number | undefined): void {
  if (level !== undefined && (!isInt(level) || level < 0 || level > 9))
    throw new RangeError(`level must be an integer from 0 to 9, got ${level}`);
}

/**
 * The range of brightness that most pixels use (1st to 99th percentile), at least 32: what a
 * palette error is compared with.
 */
function brightnessRange(h: Histogram): number {
  const bins = new Float64Array(256);
  let total = 0;
  for (let e = 0; e < h.size; e++) {
    const y = h.r[e]! * 0.299 + h.g[e]! * 0.587 + h.b[e]! * 0.114;
    bins[Math.min(255, y | 0)]! += h.count[e]!;
    total += h.count[e]!;
  }
  const at = (share: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += bins[v]!) >= total * share) return v;
    return 255;
  };
  return Math.max(32, at(0.99) - at(0.01) + 1);
}

interface Built extends PaletteResult {
  matched: Palette;
  flat: boolean;
}

function buildPalette(h: Histogram, o: PaletteOptions): Built {
  const maxColors = o.maxColors ?? 256;
  // Fully transparent pixels get a colour of their own; the rest share the others.
  const reserved = h.clear > 0 ? 1 : 0;
  const peak = brightnessRange(h);
  const channels = h.opaque ? 3 : 4;
  const visible = h.pixels - h.clear;
  // Clear pixels are matched exactly; the bucket spread is error no palette removes.
  const perPixel = (error: number) => ((error + h.spread) * visible) / h.pixels;
  const quality = (error: number) => psnrOf(perPixel(error), peak, channels);
  const build = (colors: number, rounds: number) => {
    if (!h.size) return { p: emptyPalette(0), error: 0 };
    const p = medianCut(h, colors);
    return { p, error: refine(h, p, rounds) };
  };

  let colors = Math.max(1, Math.min(maxColors - reserved, h.size));
  // Fewer colours while the quality holds, tried with a quick palette (one k-means round,
  // about 0.3 dB below the final one, which leaves a margin): halve while it holds, then
  // narrow down between the last count that held and the first that did not.
  const holds = (n: number) => quality(build(n, 1).error) >= (o.minQuality ?? -Infinity);
  let passed = false; // `colors` is known to hold
  let failed = 1; // the largest count known not to hold (1: none yet)
  if (o.minQuality !== undefined) {
    while (colors > 2) {
      const fewer = Math.max(2, Math.floor(colors / 2));
      if (!holds(fewer)) {
        failed = fewer;
        break;
      }
      colors = fewer;
      passed = true;
    }
  }
  let best = build(colors, o.rounds ?? 2);
  if (o.minQuality !== undefined && failed > 1 && (passed || quality(best.error) >= o.minQuality)) {
    let lo = failed,
      hi = colors;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (holds(mid)) hi = mid;
      else lo = mid;
    }
    if (hi < colors) {
      colors = hi;
      best = build(colors, o.rounds ?? 2);
    }
  }
  const palette = emptyPalette(best.p.size + reserved);
  for (const ch of ['r', 'g', 'b', 'a'] as const) palette[ch].set(best.p[ch]);
  // The reserved colour is (0, 0, 0, 0): all zeros already, and sorted first by `finish`.
  const { straight, matched } = finish(palette);
  const exact = h.exact && h.size <= best.p.size;
  return {
    palette: straight,
    colors: matched.size,
    transparentIndex: reserved ? 0 : -1,
    psnr: psnrOf(perPixel(best.error), 255, channels),
    quality: quality(best.error),
    exact,
    matched,
    flat: h.exact && h.size < FLAT,
  };
}

/**
 * Builds a palette for an image without writing a file: for a custom pipeline (your own
 * dithering, several images sharing one palette, an APNG) or just to inspect the fit.
 * `rgba` is straight (not premultiplied) RGBA, 4 bytes per pixel, as a canvas gives it.
 */
export function createPalette(rgba: Rgba, options: PaletteOptions = {}): PaletteResult {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray))
    throw new TypeError('rgba must be a Uint8Array or Uint8ClampedArray of RGBA bytes');
  if (rgba.length === 0 || rgba.length % 4 !== 0)
    throw new RangeError(`rgba must hold whole RGBA pixels, got ${rgba.length} bytes`);
  checkPaletteOptions(options);
  const b = buildPalette(histogram(rgba), options);
  const { palette, colors, transparentIndex, psnr, quality, exact } = b;
  return { palette, colors, transparentIndex, psnr, quality, exact };
}

export interface ApplyOptions {
  /** 0 to 1: Floyd-Steinberg error diffusion on smooth areas only. Default 0. */
  dither?: number;
  /**
   * Index of the palette entry every fully transparent pixel takes. Default: the entry
   * nearest to transparent black.
   */
  transparentIndex?: number;
}

/**
 * Maps every pixel to the nearest colour of a palette (straight RGBA, 4 bytes per colour, 1 to
 * 256 colours), with optional dithering. Returns one index per pixel, row by row.
 */
export function applyPalette(
  rgba: Rgba,
  width: number,
  height: number,
  palette: Uint8Array,
  options: ApplyOptions = {},
): Uint8Array {
  checkImage(rgba, width, height);
  checkDither(options.dither);
  const colors = palette.length / 4;
  if (!(palette instanceof Uint8Array) || !isInt(colors) || colors < 1 || colors > 256)
    throw new RangeError('palette must be a Uint8Array of 1 to 256 RGBA colours');
  const t = options.transparentIndex;
  if (t !== undefined && (!isInt(t) || t < 0 || t >= colors))
    throw new RangeError(`transparentIndex must be a palette index, got ${t}`);
  return remap(rgba, width, height, fromStraight(palette), {
    dither: options.dither ?? 0,
    ...(t === undefined ? {} : { clear: t }),
  });
}

/** Writes an indexed PNG from a palette (straight RGBA, 1 to 256 colours) and one index per pixel. */
export function encodeIndexedPng(
  width: number,
  height: number,
  palette: Uint8Array,
  indices: Uint8Array,
  options: { level?: DeflateLevel } = {},
): Uint8Array {
  if (!isInt(width) || !isInt(height) || width < 1 || height < 1)
    throw new RangeError(`width and height must be positive integers, got ${width}x${height}`);
  if (width > MAX_SIDE || height > MAX_SIDE)
    throw new RangeError(`width and height must be at most ${MAX_SIDE}`);
  const colors = palette.length / 4;
  if (!(palette instanceof Uint8Array) || !isInt(colors) || colors < 1 || colors > 256)
    throw new RangeError('palette must be a Uint8Array of 1 to 256 RGBA colours');
  if (!(indices instanceof Uint8Array) || indices.length !== width * height)
    throw new RangeError(`indices must hold ${width * height} bytes, got ${indices.length}`);
  for (let i = 0; i < indices.length; i++)
    if (indices[i]! >= colors)
      throw new RangeError(`index ${indices[i]} at pixel ${i} is outside the palette`);
  checkLevel(options.level);
  return writePng(width, height, palette, indices, options.level ?? 9);
}

/**
 * Quantizes straight RGBA pixels (as from `canvas.getImageData`) to an indexed PNG.
 *
 * An image with at most `maxColors` colours comes back lossless. With `minQuality` the palette
 * shrinks while the quality holds. The result carries the file, the palette, the indices and
 * the measured fit.
 */
export function quantize(
  rgba: Rgba,
  width: number,
  height: number,
  options: QuantizeOptions = {},
): QuantizeResult {
  checkImage(rgba, width, height);
  checkPaletteOptions(options);
  checkDither(options.dither);
  checkLevel(options.level);
  const h = histogram(rgba);
  const built = buildPalette(h, options);
  const { matched, flat, ...result } = built;
  const dither =
    result.exact || flat || result.quality >= NO_DITHER_ABOVE ? 0 : (options.dither ?? 0);
  const clear = result.transparentIndex;
  let indices = remap(rgba, width, height, matched, {
    dither,
    ...(clear < 0 ? {} : { clear }),
  });
  let palette = result.palette;
  // Entries no pixel took (k-means can strand one) are dropped: shorter PLTE, maybe fewer bits.
  const used = new Uint8Array(matched.size);
  for (let i = 0; i < indices.length; i++) used[indices[i]!] = 1;
  let kept = 0;
  for (let k = 0; k < used.length; k++) kept += used[k]!;
  let transparentIndex = clear;
  if (kept < matched.size) {
    const to = new Uint8Array(matched.size);
    palette = new Uint8Array(kept * 4);
    for (let k = 0, n = 0; k < matched.size; k++) {
      if (!used[k]) continue;
      to[k] = n;
      palette.set(result.palette.subarray(k * 4, k * 4 + 4), n * 4);
      n++;
    }
    indices = indices.map((k) => to[k]!);
    transparentIndex = clear < 0 || !used[clear] ? -1 : to[clear]!;
  }
  const level = options.level ?? (width * height > BIG ? 6 : 9);
  return {
    ...result,
    palette,
    colors: palette.length / 4,
    transparentIndex,
    png: writePng(width, height, palette, indices, level),
    width,
    height,
    indices,
  };
}

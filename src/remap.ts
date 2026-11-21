/**
 * Pixels to palette indices. Without dithering each colour is matched exactly (nearest, cached
 * per colour). With dithering (Floyd-Steinberg, serpentine) the error spreads only over smooth
 * areas such as sky and skin, where it removes banding; on edges and text it is dropped, since
 * there it only adds noise and bytes. Fully transparent pixels always take the clear colour,
 * and no error passes through them.
 */
import { colorKey, premul, type Rgba } from './histogram.js';
import { nearest, type Palette } from './palette.js';

/** Step between neighbours (premultiplied luma or alpha) above which a pixel is an edge. */
const EDGE = 18;
/**
 * Largest error carried to a neighbour, per channel: keeps worms and streaks away. On purpose,
 * colours far from every palette entry are not dithered (grey 100 between black and white).
 */
const CLAMP = 24;
/** Luma of every pixel as seen, premultiplied: a nearly clear pixel's hidden colour counts little. */
function lumas(rgba: Rgba, pixels: number): Float32Array {
  const out = new Float32Array(pixels);
  for (let j = 0, i = 0; j < pixels; j++, i += 4) {
    out[j] =
      (rgba[i]! * 0.299 + rgba[i + 1]! * 0.587 + rgba[i + 2]! * 0.114) * (rgba[i + 3]! / 255);
  }
  return out;
}

/** 1 for every pixel on either side of a sharp step in luma or alpha, 0 elsewhere. */
export function edges(rgba: Rgba, width: number, height: number): Uint8Array {
  const pixels = width * height;
  const out = new Uint8Array(pixels);
  const l = lumas(rgba, pixels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = y * width + x,
        a = rgba[j * 4 + 3]!,
        lj = l[j]!;
      if (x + 1 < width) {
        const n = j + 1;
        if (Math.abs(lj - l[n]!) > EDGE || Math.abs(a - rgba[n * 4 + 3]!) > EDGE) {
          out[j] = 1;
          out[n] = 1;
        }
      }
      if (y + 1 < height) {
        const n = j + width;
        if (Math.abs(lj - l[n]!) > EDGE || Math.abs(a - rgba[n * 4 + 3]!) > EDGE) {
          out[j] = 1;
          out[n] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * A direct-mapped cache from a 32-bit colour key to a palette index: one slot per hash, the
 * newer colour replaces the older. Bounded memory however many colours the image has.
 */
class MatchCache {
  private readonly keys: Uint32Array;
  private readonly values: Int16Array;
  private readonly shift: number;

  constructor(pixels: number) {
    let bits = 10;
    while (bits < 20 && 1 << bits < pixels * 2) bits++;
    this.keys = new Uint32Array(1 << bits);
    this.values = new Int16Array(1 << bits).fill(-1);
    this.shift = 32 - bits;
  }

  /** The index stored for `key`, or -1. */
  get(key: number): number {
    const slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    return this.keys[slot] === key ? this.values[slot]! : -1;
  }

  set(key: number, value: number): void {
    const slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    this.keys[slot] = key;
    this.values[slot] = value;
  }
}

export interface RemapOptions {
  /** 0-1: how much error spreads over smooth areas. */
  dither: number;
  /** Index of the reserved fully transparent colour, if the palette has one. */
  clear?: number;
}

export function remap(
  rgba: Rgba,
  width: number,
  height: number,
  p: Palette,
  o: RemapOptions,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const clear = o.clear ?? nearest(p, 0, 0, 0, 0);
  // Every colour matched exactly and remembered by its exact key. On a miss the search starts
  // from the last answer, which for a neighbouring pixel is usually right or close.
  const exact = new MatchCache(width * height);
  let last = 0;
  const match = (key: number) => {
    let k = exact.get(key);
    if (k < 0) {
      k = nearest(p, ...premul(key), last);
      exact.set(key, k);
    }
    return (last = k);
  };
  if (o.dither <= 0) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      const c = colorKey(rgba, i);
      out[j] = c === 0 ? clear : match(c);
    }
    return out;
  }

  // Dithered colours are new every pixel: matched by their premultiplied bytes (rounded, at most
  // half a level off) through a cache of their own.
  const dithered = new MatchCache(width * height);
  const near = (r: number, g: number, b: number, a: number) => {
    const key = (((r + 0.5) << 24) | ((g + 0.5) << 16) | ((b + 0.5) << 8) | (a + 0.5)) >>> 0;
    let k = dithered.get(key);
    if (k < 0) {
      k = nearest(p, r, g, b, a, last);
      dithered.set(key, k);
    }
    return (last = k);
  };
  const edge = edges(rgba, width, height);
  // Error rows, 4 channels, one pixel of padding on each side.
  let cur = new Float32Array((width + 2) * 4);
  let next = new Float32Array((width + 2) * 4);
  const clamp = (v: number) => (v > CLAMP ? CLAMP : v < -CLAMP ? -CLAMP : v);
  const byte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const err = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    const ltr = y % 2 === 0;
    for (let n = 0; n < width; n++) {
      const x = ltr ? n : width - 1 - n;
      const j = y * width + x,
        i = j * 4,
        e = (x + 1) * 4;
      const c = colorKey(rgba, i);
      // Clear pixels stay clear and pass no error on.
      if (c === 0) {
        out[j] = clear;
        continue;
      }
      if (edge[j]) {
        out[j] = match(c);
        continue;
      }
      const [pr, pg, pb, pa] = premul(c);
      const r = byte(pr + cur[e]!);
      const g = byte(pg + cur[e + 1]!);
      const b = byte(pb + cur[e + 2]!);
      // Opaque stays opaque: the error never makes a solid pixel see-through.
      const a = pa >= 255 ? 255 : byte(pa + cur[e + 3]!);
      const k = near(r, g, b, a);
      out[j] = k;
      err[0] = r - p.r[k]!;
      err[1] = g - p.g[k]!;
      err[2] = b - p.b[k]!;
      err[3] = a - p.a[k]!;
      const ahead = ltr ? 4 : -4;
      for (let d = 0; d < 4; d++) {
        const v = clamp(err[d]! * o.dither);
        cur[e + ahead + d]! += (v * 7) / 16;
        next[e - ahead + d]! += (v * 3) / 16;
        next[e + d]! += (v * 5) / 16;
        next[e + ahead + d]! += v / 16;
      }
    }
    [cur, next] = [next, cur];
    next.fill(0);
  }
  return out;
}

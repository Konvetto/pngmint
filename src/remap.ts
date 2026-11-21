/**
 * Pixels to palette indices. Without dithering each colour is matched exactly (nearest, cached
 * per colour). With dithering (Floyd-Steinberg, serpentine) the error spreads only over smooth
 * areas such as sky and skin, where it removes banding; on edges and text it is dropped, since
 * there it only adds noise and bytes. Fully transparent pixels always take the clear colour,
 * and no error passes through them.
 */
import { coarseKey, colorKey, premul, type Rgba } from './histogram.js';
import { nearest, type Palette } from './palette.js';

/** Step between neighbours (premultiplied luma or alpha) above which a pixel is an edge. */
const EDGE = 18;
/**
 * Largest error carried to a neighbour, per channel: keeps worms and streaks away. On purpose,
 * colours far from every palette entry are not dithered (grey 100 between black and white).
 */
const CLAMP = 24;
/** Colours remembered by exact matching before the memory is emptied. */
const MAX_CACHE = 1_000_000;

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
 * Nearest palette colour per premultiplied colour, keyed coarsely (6/6/6/4 bits): a fixed 8 MB,
 * however many colours the image has.
 */
function coarseCache(p: Palette) {
  const slots = new Int16Array(1 << 22).fill(-1);
  return (r: number, g: number, b: number, a: number) => {
    const key = coarseKey(r, g, b, a);
    let k = slots[key]!;
    if (k < 0) {
      k = nearest(p, r, g, b, a);
      slots[key] = k;
    }
    return k;
  };
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
  // Every colour matched exactly, remembered per colour; the memory is emptied past a million
  // colours, so a huge noisy image cannot grow it without bound.
  const map = new Map<number, number>();
  const match = (key: number) => {
    let k = map.get(key);
    if (k === undefined) {
      if (map.size >= MAX_CACHE) map.clear();
      k = nearest(p, ...premul(key));
      map.set(key, k);
    }
    return k;
  };
  if (o.dither <= 0) {
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      const c = colorKey(rgba, i);
      out[j] = c === 0 ? clear : match(c);
    }
    return out;
  }

  // Dithered colours are new every pixel: matched through the bounded coarse cache.
  const near = coarseCache(p);
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

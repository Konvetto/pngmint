/**
 * A palette for a histogram: median cut (split the box with the most weighted error along its
 * widest axis, at the weighted median), then a few rounds of k-means, which move each colour to
 * the mean of the pixels it serves. Channels weigh the same: pngquant-style weights for the eye
 * (green most, blue least) lost about 1 dB and SSIM on red and blue images in our tests.
 * Opaque and see-through colours start in separate boxes, and an opaque pixel only ever takes
 * an opaque colour: a photo's pixels never turn slightly transparent (alpha 254).
 */
import type { Histogram } from './histogram.js';

/** Premultiplied RGBA, 0-255, `size` entries. */
export interface Palette {
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  a: Float64Array;
  size: number;
}

export const distance = (
  p: Palette,
  k: number,
  r: number,
  g: number,
  b: number,
  a: number,
): number => {
  const dr = p.r[k]! - r,
    dg = p.g[k]! - g,
    db = p.b[k]! - b,
    da = p.a[k]! - a;
  return dr * dr + dg * dg + db * db + da * da;
};

/** Palette alpha that counts as opaque (means of opaque pixels are exactly 255). */
const OPAQUE = 254.5;

/**
 * Index of the nearest colour, exact. Starts from `hint` (last round's answer, usually right)
 * and drops a colour as soon as its partial distance is already worse. An opaque colour
 * (alpha 255) only matches opaque palette colours, if there are any.
 */
export function nearest(p: Palette, r: number, g: number, b: number, a: number, hint = 0): number {
  const solid = a >= 255;
  const { r: pr, g: pg, b: pb, a: pa } = p;
  let best = -1;
  let bestD = Infinity;
  if (hint < p.size && (!solid || pa[hint]! >= OPAQUE)) {
    best = hint;
    bestD = distance(p, hint, r, g, b, a);
  }
  for (let k = 0; k < p.size; k++) {
    if (solid && pa[k]! < OPAQUE) continue;
    let d = pa[k]! - a;
    d *= d;
    if (d >= bestD) continue;
    const dg = pg[k]! - g;
    d += dg * dg;
    if (d >= bestD) continue;
    const dr = pr[k]! - r;
    d += dr * dr;
    if (d >= bestD) continue;
    const db = pb[k]! - b;
    d += db * db;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  // No opaque colour in the palette: any will do.
  return best >= 0 ? best : nearest(p, r, g, b, a - 1, 0);
}

interface Box {
  from: number;
  to: number;
  /** Weighted error of the box around its mean: how much splitting it would help. */
  error: number;
  axis: 0 | 1 | 2 | 3;
}

export function medianCut(h: Histogram, colors: number): Palette {
  const order = new Uint32Array(h.size).map((_, i) => i);
  const ch = [h.r, h.g, h.b, h.a] as const;

  const measure = (from: number, to: number): Box => {
    let n = 0;
    const s = [0, 0, 0, 0],
      q = [0, 0, 0, 0];
    for (let i = from; i < to; i++) {
      const e = order[i]!,
        c = h.count[e]!;
      n += c;
      for (let d = 0; d < 4; d++) {
        const v = ch[d]![e]!;
        s[d]! += c * v;
        q[d]! += c * v * v;
      }
    }
    let error = 0,
      axis: Box['axis'] = 0,
      widest = -1;
    for (let d = 0; d < 4; d++) {
      const v = q[d]! - (s[d]! * s[d]!) / n;
      error += v;
      if (v > widest) {
        widest = v;
        axis = d as Box['axis'];
      }
    }
    return { from, to, error: to - from > 1 ? error : 0, axis };
  };

  // Opaque entries first, see-through ones after: two boxes from the start.
  let lo = 0;
  for (let i = 0; i < h.size; i++) {
    if (h.a[order[i]!]! >= 255) {
      const t = order[lo]!;
      order[lo++] = order[i]!;
      order[i] = t;
    }
  }
  const boxes: Box[] =
    lo > 0 && lo < h.size && colors > 1
      ? [measure(0, lo), measure(lo, h.size)]
      : [measure(0, h.size)];
  while (boxes.length < colors) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.error > 0 && (pick < 0 || boxes[i]!.error > boxes[pick]!.error)) pick = i;
    }
    if (pick < 0) break;
    const box = boxes[pick]!;
    const mid = splitAtMedian(order, box.from, box.to, ch[box.axis], h.count);
    boxes.splice(pick, 1, measure(box.from, mid), measure(mid, box.to));
  }

  const p = emptyPalette(boxes.length);
  boxes.forEach((box, k) => {
    let n = 0,
      r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let i = box.from; i < box.to; i++) {
      const e = order[i]!,
        c = h.count[e]!;
      n += c;
      r += c * h.r[e]!;
      g += c * h.g[e]!;
      b += c * h.b[e]!;
      a += c * h.a[e]!;
    }
    p.r[k] = r / n;
    p.g[k] = g / n;
    p.b[k] = b / n;
    p.a[k] = a / n;
  });
  return p;
}

/**
 * Reorders `order[from, to)` so the entries below the weighted median of `values` come first,
 * and returns where the second part starts. Linear: the median comes from a 256-bin histogram
 * of the values (0-255), not from sorting.
 */
export function splitAtMedian(
  order: Uint32Array,
  from: number,
  to: number,
  values: Float64Array,
  count: Float64Array,
): number {
  const bins = new Float64Array(256);
  let total = 0;
  for (let i = from; i < to; i++) {
    const e = order[i]!;
    bins[values[e]! | 0]! += count[e]!;
    total += count[e]!;
  }
  let acc = 0;
  let cut = 0;
  while (cut < 255 && acc + bins[cut]! < total / 2) acc += bins[cut++]!;
  const part = (left: (v: number) => boolean) => {
    let lo = from;
    let hi = to - 1;
    while (lo <= hi) {
      if (left(values[order[lo]!]! | 0)) lo++;
      else {
        const t = order[lo]!;
        order[lo] = order[hi]!;
        order[hi--] = t;
      }
    }
    return lo;
  };
  // The median's bin goes left; when that leaves nothing on the right, it goes right instead.
  let mid = part((v) => v <= cut);
  if (mid === to) mid = part((v) => v < cut);
  // All entries in one bin (values a fraction apart): halve the box.
  return mid > from && mid < to ? mid : from + Math.max(1, (to - from) >> 1);
}

export function emptyPalette(size: number): Palette {
  return {
    r: new Float64Array(size),
    g: new Float64Array(size),
    b: new Float64Array(size),
    a: new Float64Array(size),
    size,
  };
}

/** Moves each colour to the mean of the histogram entries nearest to it; returns the error. */
export function refine(h: Histogram, p: Palette, rounds: number): number {
  const sum = emptyPalette(p.size);
  const n = new Float64Array(p.size);
  const hint = new Uint16Array(h.size);
  let error = 0;
  for (let round = 0; round <= rounds; round++) {
    for (const list of [sum.r, sum.g, sum.b, sum.a, n]) list.fill(0);
    error = 0;
    let pixels = 0;
    for (let e = 0; e < h.size; e++) {
      const r = h.r[e]!,
        g = h.g[e]!,
        b = h.b[e]!,
        a = h.a[e]!,
        c = h.count[e]!;
      const k = nearest(p, r, g, b, a, hint[e]);
      hint[e] = k;
      error += c * distance(p, k, r, g, b, a);
      pixels += c;
      n[k]! += c;
      sum.r[k]! += c * r;
      sum.g[k]! += c * g;
      sum.b[k]! += c * b;
      sum.a[k]! += c * a;
    }
    error /= pixels;
    if (round === rounds) break;
    for (let k = 0; k < p.size; k++) {
      if (!n[k]) continue;
      p.r[k] = sum.r[k]! / n[k]!;
      p.g[k] = sum.g[k]! / n[k]!;
      p.b[k] = sum.b[k]! / n[k]!;
      p.a[k] = sum.a[k]! / n[k]!;
    }
  }
  return error;
}

/**
 * The palette rounded to bytes: `straight` RGBA for the file (fully transparent colours first,
 * so tRNS stays short, then darkest to lightest, which keeps neighbouring indices close and
 * helps deflate) and `matched`, the same colours premultiplied, for matching pixels.
 */
export function finish(p: Palette): { straight: Uint8Array; matched: Palette } {
  const rank = (k: number) => (Math.round(p.a[k]!) === 0 ? 0 : Math.round(p.a[k]!) < 255 ? 1 : 2);
  const luma = (k: number) => p.r[k]! * 0.299 + p.g[k]! * 0.587 + p.b[k]! * 0.114;
  const order = [...Array(p.size).keys()].sort(
    (x, y) => rank(x) - rank(y) || luma(x) - luma(y) || x - y,
  );
  const straight = new Uint8Array(p.size * 4);
  order.forEach((k, n) => {
    const a = Math.round(p.a[k]!);
    const un = (v: number) => (a ? Math.min(255, Math.round((v * 255) / a)) : 0);
    straight.set([un(p.r[k]!), un(p.g[k]!), un(p.b[k]!), a], n * 4);
  });
  return { straight, matched: fromStraight(straight) };
}

/** A matching palette (premultiplied, unrounded) from straight RGBA bytes. */
export function fromStraight(straight: Uint8Array): Palette {
  const p = emptyPalette(straight.length >> 2);
  for (let k = 0; k < p.size; k++) {
    const a = straight[k * 4 + 3]!,
      f = a / 255;
    p.r[k] = straight[k * 4]! * f;
    p.g[k] = straight[k * 4 + 1]! * f;
    p.b[k] = straight[k * 4 + 2]! * f;
    p.a[k] = a;
  }
  return p;
}

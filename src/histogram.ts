/**
 * The image's colours with their pixel counts: the palette is built from these, not from every
 * pixel. Colours are premultiplied by alpha, so the hidden colour of a transparent pixel never
 * takes a palette slot; all fully transparent pixels are one entry, kept apart (`clear`).
 * An image with few colours (screenshots, flat art) keeps them exactly; past `EXACT` colours
 * they are bucketed (6 bits per colour channel, 4 for alpha). Each bucket remembers how far its
 * pixels spread around its mean (`spread`), so quality estimates stay honest.
 */
export interface Histogram {
  /** Premultiplied RGBA per entry, 0-255 (mean of the pixels it holds). Never fully clear. */
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  a: Float64Array;
  count: Float64Array;
  size: number;
  /** Fully transparent pixels: one reserved palette entry when there are any. */
  clear: number;
  /** All pixels, clear ones included. */
  pixels: number;
  /** Squared error of the buckets' pixels around their means, per visible pixel (0 if exact). */
  spread: number;
  /** True when every visible colour is its own entry. */
  exact: boolean;
  /** No pixel is partly or fully transparent. */
  opaque: boolean;
}

/** Up to this many distinct visible colours the histogram is exact. */
export const EXACT = 8192;

export type Rgba = Uint8Array | Uint8ClampedArray;

/** A pixel's colour as a key: straight RGBA; every fully transparent pixel is 0. */
export function colorKey(rgba: Rgba, i: number): number {
  const a = rgba[i + 3]!;
  return a === 0 ? 0 : ((rgba[i]! << 24) | (rgba[i + 1]! << 16) | (rgba[i + 2]! << 8) | a) >>> 0;
}

/** A coarse key, 6 bits per colour channel and 4 for alpha (22 bits): buckets and caches. */
export const coarseKey = (r: number, g: number, b: number, a: number): number =>
  ((r >> 2) << 16) | ((g >> 2) << 10) | ((b >> 2) << 4) | (a >> 4);

/**
 * The key's colour premultiplied by alpha, unrounded: what palette distances use, so a
 * half-transparent colour comes back exactly.
 */
export function premul(key: number): [number, number, number, number] {
  const a = key & 255,
    k = a / 255;
  return [(key >>> 24) * k, ((key >>> 16) & 255) * k, ((key >>> 8) & 255) * k, a];
}

export function histogram(rgba: Rgba, exactLimit = EXACT): Histogram {
  return collect(rgba, exactLimit, true) ?? collect(rgba, Infinity, false)!;
}

/** Growable parallel sums, one slot per histogram entry. */
class Sums {
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  a: Float64Array;
  n: Float64Array;
  sq: Float64Array;
  size = 0;

  constructor(capacity: number) {
    this.r = new Float64Array(capacity);
    this.g = new Float64Array(capacity);
    this.b = new Float64Array(capacity);
    this.a = new Float64Array(capacity);
    this.n = new Float64Array(capacity);
    this.sq = new Float64Array(capacity);
  }

  grow(): void {
    const next = this.r.length * 2;
    for (const ch of ['r', 'g', 'b', 'a', 'n', 'sq'] as const) {
      const bigger = new Float64Array(next);
      bigger.set(this[ch]);
      this[ch] = bigger;
    }
  }
}

/** Open addressing from a non-zero 32-bit key to an entry number; faster than a Map here. */
export class KeyIndex {
  private keys: Uint32Array;
  private values: Int32Array;
  private shift: number;
  size = 0;

  constructor(capacity = 1024) {
    let bits = 10;
    while (1 << bits < capacity * 2) bits++;
    this.keys = new Uint32Array(1 << bits);
    this.values = new Int32Array(1 << bits);
    this.shift = 32 - bits;
  }

  /** The entry for `key` (never 0), or -1. */
  get(key: number): number {
    const mask = this.keys.length - 1;
    let slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    for (;;) {
      const k = this.keys[slot]!;
      if (k === key) return this.values[slot]!;
      if (k === 0) return -1;
      slot = (slot + 1) & mask;
    }
  }

  set(key: number, value: number): void {
    if (this.size * 2 >= this.keys.length) this.grow();
    const mask = this.keys.length - 1;
    let slot = Math.imul(key, 0x9e3779b1) >>> this.shift;
    while (this.keys[slot] !== 0 && this.keys[slot] !== key) slot = (slot + 1) & mask;
    if (this.keys[slot] === 0) this.size++;
    this.keys[slot] = key;
    this.values[slot] = value;
  }

  private grow(): void {
    const keys = this.keys,
      values = this.values;
    this.keys = new Uint32Array(keys.length * 2);
    this.values = new Int32Array(keys.length * 2);
    this.shift--;
    this.size = 0;
    for (let i = 0; i < keys.length; i++) if (keys[i] !== 0) this.set(keys[i]!, values[i]!);
  }
}

function collect(rgba: Rgba, cap: number, exact: boolean): Histogram | undefined {
  // Exact keys (never 0 for a visible pixel) go through a hash; coarse keys (22 bits) index a
  // table directly: 16 MB for the time of the call, and no hashing per pixel.
  const hash = exact ? new KeyIndex(Math.min(cap, 1 << 16)) : undefined;
  const direct = exact ? undefined : new Int32Array(1 << 22).fill(-1);
  const s = new Sums(exact ? 256 : 4096);
  let clear = 0;
  let opaque = true;
  for (let i = 0; i < rgba.length; i += 4) {
    const A = rgba[i + 3]!;
    if (A === 0) {
      clear++;
      opaque = false;
      continue;
    }
    if (A < 255) opaque = false;
    const R = rgba[i]!,
      G = rgba[i + 1]!,
      B = rgba[i + 2]!;
    let at: number;
    if (hash) {
      const key = ((R << 24) | (G << 16) | (B << 8) | A) >>> 0;
      at = hash.get(key);
      if (at < 0) {
        if (s.size >= cap) return undefined;
        at = s.size++;
        if (at === s.r.length) s.grow();
        hash.set(key, at);
      }
    } else {
      const key = coarseKey(R, G, B, A);
      at = direct![key]!;
      if (at < 0) {
        at = s.size++;
        if (at === s.r.length) s.grow();
        direct![key] = at;
      }
    }
    const k = A / 255,
      pr = R * k,
      pg = G * k,
      pb = B * k;
    s.r[at]! += pr;
    s.g[at]! += pg;
    s.b[at]! += pb;
    s.a[at]! += A;
    s.n[at]! += 1;
    if (!exact) s.sq[at]! += pr * pr + pg * pg + pb * pb + A * A;
  }
  const size = s.size;
  const out: Histogram = {
    r: new Float64Array(size),
    g: new Float64Array(size),
    b: new Float64Array(size),
    a: new Float64Array(size),
    count: s.n.slice(0, size),
    size,
    clear,
    pixels: rgba.length / 4,
    spread: 0,
    exact,
    opaque,
  };
  let spread = 0,
    visible = 0;
  for (let i = 0; i < size; i++) {
    const c = s.n[i]!;
    out.r[i] = s.r[i]! / c;
    out.g[i] = s.g[i]! / c;
    out.b[i] = s.b[i]! / c;
    out.a[i] = s.a[i]! / c;
    visible += c;
    if (!exact) {
      const mean = out.r[i]! ** 2 + out.g[i]! ** 2 + out.b[i]! ** 2 + out.a[i]! ** 2;
      spread += Math.max(0, s.sq[i]! - c * mean);
    }
  }
  out.spread = visible ? spread / visible : 0;
  return out;
}

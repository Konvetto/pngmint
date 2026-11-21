import { describe, expect, it } from 'vitest';
import {
  applyPalette,
  createPalette,
  encodeIndexedPng,
  encodeIndexedPngSync,
  presets,
  psnrOf,
  quantize as quantizeAsync,
  quantizeSync,
  type QuantizeOptions,
  type Rgba,
} from '../src/index.js';
import {
  deflate,
  expectSamePixels,
  flat,
  gradient,
  mse,
  noise,
  random,
  readPng,
} from './helpers.js';

/** The synchronous variant with the deterministic compressor, which most tests want. */
const quantize = (rgba: Rgba, w: number, h: number, o: QuantizeOptions = {}) =>
  quantizeSync(rgba, w, h, { deflate, ...o });

describe('quantize: lossless cases', () => {
  it('an image with few colours comes back pixel for pixel', () => {
    const colors = [
      [255, 0, 0, 255],
      [0, 128, 255, 255],
      [20, 20, 20, 255],
      [255, 255, 255, 0],
      [10, 200, 30, 128],
    ];
    const rgba = flat(24, 16, colors);
    const q = quantize(rgba, 24, 16, { dither: 1 });
    expect(q.colors).toBe(5);
    expect(q.exact).toBe(true);
    expect(q.psnr).toBe(Infinity);
    expect(q.quality).toBe(Infinity);
    expect(q.transparentIndex).toBe(0);
    const png = readPng(q.png);
    expect(png.depth).toBe(4);
    expectSamePixels(rgba, png.rgba);
  });

  for (const n of [2, 3, 4, 5, 16, 17, 255, 256]) {
    it(`exactly ${n} colours are kept exactly, at the smallest bit depth`, () => {
      const rnd = random(n);
      const colors = Array.from({ length: n }, (_, i) => [
        (i * 53) & 255,
        rnd() * 256,
        (i * 7) & 255,
        i % 9 === 0 ? 77 : 255,
      ]).map((c) => c.map(Math.floor));
      const w = 61,
        h = 23;
      const rgba = flat(w, h, colors);
      const q = quantize(rgba, w, h, { maxColors: 256, dither: 1 });
      expect(q.colors).toBe(n);
      expect(q.exact).toBe(true);
      const png = readPng(q.png);
      expect(png.depth).toBe(n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8);
      expectSamePixels(rgba, png.rgba);
      // With a quality floor the palette may shrink, but only while the floor holds.
      const floored = quantize(rgba, w, h, { maxColors: 256, minQuality: 30 });
      expect(floored.colors).toBeLessThanOrEqual(n);
      expect(floored.quality).toBeGreaterThanOrEqual(30);
    });
  }

  it('the quality floor narrows down to the fewest colours that hold it', () => {
    const rgba = gradient(256, 8, [0, 0, 0], [255, 255, 255]);
    const q = quantize(rgba, 256, 8, { maxColors: 256, minQuality: 40 });
    expect(q.quality).toBeGreaterThanOrEqual(40);
    // One colour fewer (built the same quick way) would not hold.
    const fewer = createPalette(rgba, { maxColors: q.colors - 1, rounds: 1 });
    expect(fewer.quality).toBeLessThan(40);
    // Not a power of two away from the cap: the search did more than halve.
    expect([128, 64, 32, 16, 8, 4, 2]).not.toContain(q.colors);
  });

  it('257 colours are quantized to 256', () => {
    const make = (n: number) => {
      const rgba = new Uint8Array(n * 4 * 3);
      for (let i = 0; i < n * 3; i++)
        rgba.set([(i % n) & 255, ((i % n) * 7) & 255, (i % n) >> 1, 255], i * 4);
      return rgba;
    };
    const exact = quantize(make(256), 256 * 3, 1, { dither: 1 });
    expect(exact.psnr).toBe(Infinity);
    const over = quantize(make(257), 257 * 3, 1, { dither: 0 });
    expect(over.colors).toBe(256);
    expect(over.exact).toBe(false);
    expect(over.psnr).toBeLessThan(Infinity);
  });

  it('two colours give a 1-bit PNG', () => {
    const rgba = flat(9, 9, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const png = readPng(quantize(rgba, 9, 9).png);
    expect(png.depth).toBe(1);
    expectSamePixels(rgba, png.rgba);
  });

  it('a grayscale ramp of 256 levels is lossless at 256 colours and lossy at fewer', () => {
    const rgba = gradient(256, 4, [0, 0, 0], [255, 255, 255]);
    const full = quantize(rgba, 256, 4);
    expect(full.exact).toBe(true);
    expectSamePixels(rgba, readPng(full.png).rgba);
    const less = quantize(rgba, 256, 4, { maxColors: 16 });
    expect(less.colors).toBe(16);
    expect(less.psnr).toBeGreaterThan(30);
  });
});

describe('quantize: sizes and shapes', () => {
  it('1x1, 1xN, Nx1', () => {
    const one = readPng(quantize(new Uint8Array([10, 20, 30, 255]), 1, 1, { dither: 1 }).png);
    expect([one.width, one.height, one.depth, [...one.rgba]]).toEqual([1, 1, 1, [10, 20, 30, 255]]);
    const row = gradient(300, 1, [0, 0, 0], [255, 255, 255]);
    const column = new Uint8Array(row);
    for (const [w, h, rgba] of [
      [300, 1, row],
      [1, 300, column],
    ] as const) {
      const q = quantize(rgba, w, h, { maxColors: 8, dither: 1 });
      const png = readPng(q.png);
      expect([png.width, png.height]).toEqual([w, h]);
      expect(q.indices.length).toBe(300);
      expect(mse(rgba, png.rgba)).toBeLessThan(900);
    }
  });

  it('a single colour: one palette entry, 1-bit', () => {
    const q = quantize(new Uint8Array(40 * 4).fill(200), 40, 1, { dither: 1 });
    expect(q.colors).toBe(1);
    expect(readPng(q.png).depth).toBe(1);
  });

  it('a fully transparent image keeps one clear colour and no other', () => {
    const q = quantize(new Uint8Array(16), 2, 2, { dither: 1 });
    expect(q.colors).toBe(1);
    expect(q.transparentIndex).toBe(0);
    expect(q.exact).toBe(true);
    const png = readPng(q.png);
    expect([...png.rgba].filter((_, i) => i % 4 === 3)).toEqual([0, 0, 0, 0]);
  });

  it('clear pixels never leak their hidden colour into the palette', () => {
    const rgba = flat(32, 32, [
      [255, 0, 0, 0],
      [0, 255, 0, 0],
      [0, 0, 255, 0],
      [40, 40, 40, 255],
    ]);
    const q = quantize(rgba, 32, 32);
    expect(q.colors).toBe(2);
    expect([...q.palette]).toEqual([0, 0, 0, 0, 40, 40, 40, 255]);
  });

  it('partial alpha survives, and an opaque pixel never turns see-through', () => {
    const w = 64,
      h = 64,
      rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - 32, y - 32);
        const a = d < 12 ? 255 : d < 30 ? Math.round(255 * ((30 - d) / 18) ** 3) : 0;
        rgba.set([255, 120 + (x & 31), 40, a], (y * w + x) * 4);
      }
    }
    const png = readPng(quantize(rgba, w, h, presets.tiny).png);
    let semi = 0;
    for (let i = 0; i < w * h; i++) {
      const a = rgba[i * 4 + 3]!,
        got = png.rgba[i * 4 + 3]!;
      if (a === 0) expect(got).toBe(0);
      if (a === 255) expect(got).toBe(255);
      if (got > 0 && got < 255) semi++;
    }
    expect(semi).toBeGreaterThan(100);
  });

  it('a photo-like image stays close whatever the preset', () => {
    const r = random(5),
      w = 128,
      h = 96,
      rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = 40 + (x / w) * 150 + Math.sin(y / 9) * 20 + r() * 8;
        rgba.set([v, v * 0.8 + r() * 6, v * 0.5 + (y / h) * 60, 255], (y * w + x) * 4);
      }
    const expectPsnrAbove = { quality: 36, balanced: 33, small: 30, tiny: 27 };
    for (const [name, preset] of Object.entries(presets)) {
      const q = quantize(rgba, w, h, preset);
      const measured = psnrOf(mse(rgba, readPng(q.png).rgba), 255, 3);
      expect(measured, name).toBeGreaterThan(expectPsnrAbove[name as keyof typeof presets]);
      expect(q.colors).toBeLessThanOrEqual(preset.maxColors);
    }
  });

  it('a quality floor gives a simple image fewer colours, a busy one keeps the cap', () => {
    const simple = flat(
      64,
      64,
      [
        [0, 0, 0, 255],
        [250, 250, 250, 255],
        [200, 30, 30, 255],
        [30, 30, 200, 255],
      ].flatMap((c) => [c, c.map((v, i) => (i < 3 ? Math.min(255, v + 2) : v))]),
    );
    const s = quantize(simple, 64, 64, { maxColors: 256, minQuality: 40 });
    expect(s.colors).toBeLessThanOrEqual(4);
    expect(s.quality).toBeGreaterThanOrEqual(40);
    const busy = noise(64, 64);
    const b = quantize(busy, 64, 64, { maxColors: 32, minQuality: 60 });
    expect(b.colors).toBe(32);
  });

  it('a dark, low-contrast image keeps enough colours', () => {
    const r = random(5),
      w = 96,
      h = 96,
      rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = 10 + ((i % w) / w) * 25 + r() * 6;
      rgba.set([v, v * 0.8, v * 0.6 + r() * 4, 255], i * 4);
    }
    const q = quantize(rgba, w, h, { maxColors: 256, minQuality: 42, dither: 0.3 });
    expect(q.colors).toBeGreaterThanOrEqual(32);
    // Standard PSNR is reported next to the range-adjusted quality, and is higher for a dark image.
    expect(q.psnr).toBeGreaterThan(q.quality);
  });

  it('noise at maxColors 2 and 256 stays within bounds', () => {
    const rgba = noise(50, 50, 3);
    expect(quantize(rgba, 50, 50, { maxColors: 2, dither: 1 }).colors).toBe(2);
    expect(quantize(rgba, 50, 50, { maxColors: 256 }).colors).toBe(256);
  });

  it('maxColors 2 with transparency leaves one visible colour', () => {
    const rgba = flat(16, 16, [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 0, 0, 0],
    ]);
    const q = quantize(rgba, 16, 16, { maxColors: 2 });
    expect(q.colors).toBe(2);
    expect(q.palette[3]).toBe(0);
    expect(q.palette[7]).toBe(255);
  });

  it('a palette entry no pixel takes is dropped from the file', () => {
    // Two tight clusters far apart and k-means asked for 3 colours: one entry can strand.
    const rgba = flat(40, 40, [
      [0, 0, 0, 255],
      [1, 0, 0, 255],
      [0, 1, 0, 255],
      [254, 254, 254, 255],
      [255, 255, 255, 255],
      [253, 255, 255, 255],
    ]);
    const q = quantize(rgba, 40, 40, { maxColors: 5 });
    expect(q.colors).toBe(q.palette.length / 4);
    const used = new Set(q.indices);
    expect(used.size).toBe(q.colors);
  });

  it('flat art is never dithered, so stronger settings never grow the file', () => {
    const w = 200,
      h = 120,
      rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const base = x < 60 ? [246, 217, 200] : y < 40 ? [255, 255, 255] : [247, 247, 245];
        const text = (x % 11 < 2 || y % 13 < 2) && x > 70 ? 0.7 : 0;
        rgba.set([...base.map((v) => Math.round(v * (1 - text))), 255], (y * w + x) * 4);
      }
    }
    const sizes = Object.values(presets).map((o) => quantize(rgba, w, h, o).png.length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]!);
  });

  it('is deterministic: same input, same bytes', () => {
    const rgba = noise(50, 50, 9);
    const o = { maxColors: 64, minQuality: 30, dither: 0.5 };
    expect(quantize(rgba, 50, 50, o).png).toEqual(quantize(rgba, 50, 50, o).png);
    expect(quantize(new Uint8ClampedArray(rgba), 50, 50, o).png).toEqual(
      quantize(rgba, 50, 50, o).png,
    );
  });

  it('the compressor changes size, not pixels', async () => {
    const rgba = gradient(200, 50, [20, 0, 0], [255, 240, 200]);
    const native = await quantizeAsync(rgba, 200, 50, { maxColors: 32, dither: 0.5 });
    const fflate = quantize(rgba, 200, 50, { maxColors: 32, dither: 0.5 });
    expect(native.indices).toEqual(fflate.indices);
    expect(readPng(native.png).rgba).toEqual(readPng(fflate.png).rgba);
    expect(Math.abs(native.png.length - fflate.png.length) / fflate.png.length).toBeLessThan(0.25);
  });

  it('the asynchronous variant takes a synchronous or an asynchronous deflate', async () => {
    const rgba = gradient(64, 4, [0, 0, 0], [255, 255, 255]);
    const a = await quantizeAsync(rgba, 64, 4, { maxColors: 8, deflate });
    const b = await quantizeAsync(rgba, 64, 4, {
      maxColors: 8,
      deflate: (raw) => Promise.resolve(deflate(raw)),
    });
    expect(a.png).toEqual(b.png);
    expect(a.png).toEqual(quantize(rgba, 64, 4, { maxColors: 8 }).png);
  });

  it('the synchronous variant needs a synchronous deflate', () => {
    const rgba = gradient(8, 2, [0, 0, 0], [255, 255, 255]);
    expect(() => quantizeSync(rgba, 8, 2)).toThrow(TypeError);
    expect(() => quantizeSync(rgba, 8, 2, { deflate: (raw) => Promise.resolve(raw) })).toThrow(
      TypeError,
    );
    expect(() => quantizeSync(rgba, 8, 2, { deflate: 'zip' as never })).toThrow(TypeError);
    expect(() => quantizeSync(rgba, 8, 2, { deflate: () => [1, 2] as never })).toThrow(TypeError);
  });
});

describe('validation', () => {
  const ok = new Uint8Array(16);
  it('rejects a buffer that does not match the size', () => {
    expect(() => quantize(ok, 2, 3)).toThrow(RangeError);
    expect(() => quantize(ok, 0, 2)).toThrow(RangeError);
    expect(() => quantize(ok, 2.5, 2)).toThrow(RangeError);
    expect(() => quantize(ok, 2 ** 31, 1)).toThrow(RangeError);
    expect(() => quantize([0, 0, 0, 0] as unknown as Uint8Array, 1, 1)).toThrow(TypeError);
  });

  it('rejects options out of range', () => {
    expect(() => quantize(ok, 2, 2, { maxColors: 1 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { maxColors: 257 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { maxColors: 2.5 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { dither: -0.1 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { dither: 1.1 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { dither: NaN })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { rounds: -1 })).toThrow(RangeError);
    expect(() => quantize(ok, 2, 2, { minQuality: NaN })).toThrow(RangeError);
    expect(quantize(ok, 2, 2, { maxColors: 2, dither: 0, rounds: 0 }).colors).toBe(1);
  });

  it('createPalette rejects a partial pixel, applyPalette a bad palette or index', async () => {
    expect(() => createPalette(new Uint8Array(6))).toThrow(RangeError);
    expect(() => createPalette(new Uint8Array(0))).toThrow(RangeError);
    expect(() => applyPalette(ok, 2, 2, new Uint8Array(6))).toThrow(RangeError);
    expect(() => applyPalette(ok, 2, 2, new Uint8Array(4), { transparentIndex: 1 })).toThrow(
      RangeError,
    );
    const enc = (w: number, h: number, p: Uint8Array, i: Uint8Array, o = {}) =>
      encodeIndexedPngSync(w, h, p, i, { deflate, ...o });
    expect(() => enc(2, 2, new Uint8Array(4), new Uint8Array([0, 0, 1, 0]))).toThrow(RangeError);
    expect(() => enc(2, 2, new Uint8Array(4), new Uint8Array(3))).toThrow(RangeError);
    expect(() => enc(0, 2, new Uint8Array(4), new Uint8Array(0))).toThrow(RangeError);
    expect(() => enc(2 ** 31, 1, new Uint8Array(4), new Uint8Array(0))).toThrow(RangeError);
    expect(() => enc(2, 2, new Uint8Array(6), new Uint8Array(4))).toThrow(RangeError);
    expect(() => enc(2, 2, new Uint8Array(4), [0, 0, 0, 0] as never)).toThrow(RangeError);
    expect(() => enc(2, 2, new Uint8Array(4), new Uint8Array(4), { deflate: 7 })).toThrow(
      TypeError,
    );
    expect(() => encodeIndexedPngSync(2, 2, new Uint8Array(4), new Uint8Array(4))).toThrow(
      TypeError,
    );
    await expect(
      encodeIndexedPng(2, 2, new Uint8Array(4), new Uint8Array(3), { deflate }),
    ).rejects.toThrow(RangeError);
    expect(() => createPalette([1, 2, 3, 4] as never)).toThrow(TypeError);
  });
});

describe('lower-level API', () => {
  it('createPalette, applyPalette and encodeIndexedPng compose to the same file as quantize', async () => {
    const rgba = gradient(120, 30, [255, 0, 0], [0, 0, 255]);
    const whole = quantize(rgba, 120, 30, { maxColors: 16 });
    const p = createPalette(rgba, { maxColors: 16 });
    expect(p.colors).toBe(16);
    expect(p.transparentIndex).toBe(-1);
    const indices = applyPalette(rgba, 120, 30, p.palette);
    expect(indices).toEqual(whole.indices);
    expect(encodeIndexedPngSync(120, 30, p.palette, indices, { deflate })).toEqual(whole.png);
    expect(await encodeIndexedPng(120, 30, p.palette, indices, { deflate })).toEqual(whole.png);
    const native = await encodeIndexedPng(120, 30, p.palette, indices);
    expect(readPng(native).indices).toEqual(indices);
  });

  it('applyPalette takes any palette, dithers on request and honours transparentIndex', () => {
    const palette = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255]);
    const rgba = gradient(64, 8, [0, 0, 0], [255, 255, 255]);
    rgba[3] = 0; // one clear pixel
    const plain = applyPalette(rgba, 64, 8, palette, { transparentIndex: 0 });
    expect(plain[0]).toBe(0);
    expect(new Set(plain.subarray(1))).toEqual(new Set([1, 2]));
    const dithered = applyPalette(rgba, 64, 8, palette, { dither: 1, transparentIndex: 0 });
    expect(dithered).not.toEqual(plain);
    const png = readPng(encodeIndexedPngSync(64, 8, palette, dithered, { deflate }));
    expect(png.depth).toBe(2);
  });

  it('presets are frozen snapshots of the production settings', () => {
    expect(Object.keys(presets)).toEqual(['quality', 'balanced', 'small', 'tiny']);
    expect(presets.quality).toEqual({ maxColors: 256, minQuality: 42, dither: 0 });
    expect(presets.tiny.maxColors).toBe(32);
  });
});

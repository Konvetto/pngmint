import { describe, expect, it } from 'vitest';
import { coarseKey, colorKey, histogram, premul } from '../src/histogram.js';
import {
  distance,
  emptyPalette,
  finish,
  medianCut,
  nearest,
  refine,
  splitAtMedian,
} from '../src/palette.js';
import { bitDepth, crc32, writePng } from '../src/png.js';
import { edges, remap } from '../src/remap.js';
import { random, readPng } from './helpers.js';

const px = (...colors: number[][]) => new Uint8Array(colors.flat());

describe('colorKey and premul', () => {
  it('keys the straight colour; every fully transparent pixel is one key', () => {
    const key = colorKey(px([200, 100, 50, 255]), 0);
    expect(key).toBe(((200 << 24) | (100 << 16) | (50 << 8) | 255) >>> 0);
    expect(colorKey(px([200, 100, 50, 0]), 0)).toBe(0);
    expect(colorKey(px([9, 9, 9, 0]), 0)).toBe(0);
  });

  it('premultiplies without rounding', () => {
    const [r, g, b, a] = premul(colorKey(px([200, 0, 255, 128]), 0));
    expect(r).toBeCloseTo((200 * 128) / 255, 10);
    expect([g, a]).toEqual([0, 128]);
    expect(b).toBeCloseTo(128, 10);
  });

  it('coarse keys fit in 22 bits', () => {
    expect(coarseKey(255, 255, 255, 255)).toBe((1 << 22) - 1);
    expect(coarseKey(0, 0, 0, 0)).toBe(0);
  });
});

describe('histogram', () => {
  it('counts each colour once; clear pixels are counted apart, whatever their colour', () => {
    const h = histogram(
      px([10, 20, 30, 255], [10, 20, 30, 255], [1, 2, 3, 255], [5, 5, 5, 0], [7, 7, 7, 0]),
    );
    expect(h.size).toBe(2);
    expect([...h.count].sort()).toEqual([1, 2]);
    expect([h.clear, h.pixels, h.exact, h.opaque, h.spread]).toEqual([2, 5, true, false, 0]);
  });

  it('knows an opaque image', () => {
    expect(histogram(px([1, 2, 3, 255], [4, 5, 6, 255])).opaque).toBe(true);
    expect(histogram(px([1, 2, 3, 255], [4, 5, 6, 254])).opaque).toBe(false);
  });

  it('buckets past the exact limit, keeps the mean and measures the spread', () => {
    const n = 4096;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) rgba.set([i & 255, (i >> 4) & 255, 128, 255], i * 4);
    const exact = histogram(rgba);
    const coarse = histogram(rgba, 100);
    expect(exact.exact).toBe(true);
    expect(coarse.exact).toBe(false);
    expect(coarse.size).toBeLessThan(exact.size);
    expect([...coarse.count].reduce((a, b) => a + b, 0)).toBe(n);
    let red = 0;
    for (let i = 0; i < coarse.size; i++) red += coarse.r[i]! * coarse.count[i]!;
    expect(red / n).toBeCloseTo(127.5, 5);
    expect(coarse.spread).toBeGreaterThan(0);
  });

  it('grows past its first capacity without losing a count', () => {
    const n = 5000;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) rgba.set([i & 255, (i >> 8) & 255, 7, 255], i * 4);
    const h = histogram(rgba);
    expect(h.size).toBe(n);
    expect([...h.count].every((c) => c === 1)).toBe(true);
  });

  it('copes with an image of only clear pixels', () => {
    const h = histogram(px([1, 1, 1, 0], [2, 2, 2, 0]));
    expect([h.size, h.clear, h.spread]).toEqual([0, 2, 0]);
  });
});

function brute(p: ReturnType<typeof emptyPalette>, r: number, g: number, b: number, a: number) {
  let best = 0;
  for (let k = 1; k < p.size; k++)
    if (distance(p, k, r, g, b, a) < distance(p, best, r, g, b, a)) best = k;
  return best;
}

describe('nearest', () => {
  it('finds the same colour as a full search, from any hint', () => {
    const rnd = random(7);
    const p = emptyPalette(64);
    for (let k = 0; k < 64; k++)
      [p.r[k], p.g[k], p.b[k], p.a[k]] = [rnd() * 255, rnd() * 255, rnd() * 255, rnd() * 255];
    for (let i = 0; i < 500; i++) {
      const c = [rnd() * 255, rnd() * 255, rnd() * 255, rnd() * 255] as const;
      const want = distance(p, brute(p, ...c), ...c);
      expect(distance(p, nearest(p, ...c, i % 64), ...c)).toBe(want);
    }
  });

  it('gives an opaque pixel an opaque colour when there is one, any colour otherwise', () => {
    const p = emptyPalette(2);
    [p.r[0], p.g[0], p.b[0], p.a[0]] = [10, 10, 10, 250];
    [p.r[1], p.g[1], p.b[1], p.a[1]] = [200, 200, 200, 255];
    expect(nearest(p, 12, 12, 12, 255)).toBe(1);
    p.a[1] = 100;
    expect(nearest(p, 12, 12, 12, 255)).toBe(0);
  });
});

describe('splitAtMedian', () => {
  it('puts the lighter half of the pixels first, by weight', () => {
    const values = new Float64Array([10, 200, 50, 90, 130]);
    const count = new Float64Array([1, 1, 1, 1, 6]);
    const order = new Uint32Array([0, 1, 2, 3, 4]);
    const mid = splitAtMedian(order, 0, 5, values, count);
    const left = [...order.subarray(0, mid)].map((e) => values[e]!);
    const right = [...order.subarray(mid)].map((e) => values[e]!);
    expect(Math.max(...left)).toBeLessThan(Math.min(...right));
    expect(right).toEqual([200]);
  });

  it('always leaves both sides non-empty', () => {
    const values = new Float64Array([5.1, 5.2, 5.3]);
    const order = new Uint32Array([0, 1, 2]);
    const mid = splitAtMedian(order, 0, 3, values, new Float64Array([1, 1, 1]));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(3);
  });
});

describe('medianCut and refine', () => {
  const image = (n: number) => {
    const rnd = random(3);
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) rgba.set([rnd() * 255, rnd() * 255, rnd() * 128, 255], i * 4);
    return rgba;
  };

  it('keeps every colour when there are fewer than asked for', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255]);
    const p = medianCut(histogram(rgba), 16);
    expect(p.size).toBe(3);
    expect(refine(histogram(rgba), p, 2)).toBe(0);
  });

  it('gives at most the colours asked for, and k-means lowers the error', () => {
    const h = histogram(image(5000));
    const p = medianCut(h, 32);
    expect(p.size).toBe(32);
    const before = refine(h, medianCut(h, 32), 0);
    const after = refine(h, p, 3);
    expect(after).toBeLessThan(before);
  });

  it('starts opaque and see-through colours in separate boxes', () => {
    const rgba = new Uint8Array(200 * 4);
    for (let i = 0; i < 200; i++) rgba.set([i, 100, 100, i < 100 ? 255 : 128], i * 4);
    const p = medianCut(histogram(rgba), 8);
    const alphas = [...p.a].map(Math.round);
    expect(alphas.filter((a) => a === 255).length).toBeGreaterThan(0);
    expect(alphas.filter((a) => a === 128).length).toBeGreaterThan(0);
    expect(alphas.every((a) => a === 255 || a === 128)).toBe(true);
  });
});

describe('finish', () => {
  it('puts see-through colours first and stores them straight, not premultiplied', () => {
    const p = emptyPalette(3);
    [p.r[0], p.g[0], p.b[0], p.a[0]] = [200, 200, 200, 255];
    [p.r[1], p.g[1], p.b[1], p.a[1]] = [50, 0, 0, 100];
    [p.r[2], p.g[2], p.b[2], p.a[2]] = [10, 10, 10, 255];
    const { straight, matched } = finish(p);
    expect([...straight.subarray(0, 4)]).toEqual([128, 0, 0, 100]);
    expect([...straight.subarray(4, 8)]).toEqual([10, 10, 10, 255]);
    expect(matched.a[0]).toBe(100);
    expect(matched.r[0]).toBeCloseTo((128 * 100) / 255, 10);
  });
});

describe('crc32 and bitDepth', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('matches the PNG standard', () => {
    expect(crc32(enc('IEND'))).toBe(0xae426082);
    expect(crc32(enc('123456789'))).toBe(0xcbf43926);
  });
  it('uses the fewest bits that hold the palette', () => {
    expect([1, 2, 3, 4, 5, 16, 17, 256].map(bitDepth)).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
  });
});

describe('writePng', () => {
  const palette = (n: number, alpha = 255) =>
    new Uint8Array(n * 4).map((_, i) => (i % 4 === 3 ? alpha : (i * 37) % 256));

  for (const colors of [1, 2, 3, 4, 16, 17, 200, 256]) {
    it(`writes ${colors} colours at the right depth and reads back the same pixels`, () => {
      const width = 13,
        height = 7; // odd sizes: rows end mid-byte at low depths
      const indices = new Uint8Array(width * height).map((_, i) => (i * 7) % colors);
      const png = readPng(writePng(width, height, palette(colors), indices));
      expect(png.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.chunks.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
      expect(png.chunks.every((c) => c.crcOk)).toBe(true);
      expect([png.width, png.height, png.type, png.depth]).toEqual([
        width,
        height,
        3,
        bitDepth(colors),
      ]);
      expect(png.indices).toEqual(indices);
      expect(png.filters.every((f) => f === 0)).toBe(true);
    });
  }

  it('adds tRNS only up to the last see-through colour', () => {
    const p = palette(4);
    p[3] = 0;
    p[7] = 128;
    const png = readPng(writePng(2, 2, p, new Uint8Array([0, 1, 2, 3])));
    const trns = png.chunks.find((c) => c.type === 'tRNS')!;
    expect([...trns.data]).toEqual([0, 128]);
    expect([...png.palette.subarray(8, 16)]).toEqual([...p.subarray(8, 16)]);
  });
});

const grey = (values: number[]) => {
  const p = emptyPalette(values.length);
  values.forEach((v, k) => ([p.r[k], p.g[k], p.b[k], p.a[k]] = [v, v, v, 255]));
  return p;
};

const ramp = (w: number) =>
  new Uint8Array(
    [...Array(w).keys()].flatMap((x) => {
      const v = Math.round((x / (w - 1)) * 100);
      return [v, v, v, 255];
    }),
  );

describe('edges', () => {
  it('marks the pixels on both sides of a sharp step, not a gentle slope', () => {
    const rgba = new Uint8Array([0, 4, 8, 200].flatMap((v) => [v, v, v, 255]));
    expect([...edges(rgba, 4, 1)]).toEqual([0, 0, 1, 1]);
  });

  it('sees an alpha edge vertically as well as horizontally', () => {
    const column = new Uint8Array([90, 90, 90, 0, 90, 90, 90, 255]);
    expect([...edges(column, 1, 2)]).toEqual([1, 1]);
    expect([...edges(column, 2, 1)]).toEqual([1, 1]);
  });

  it('ignores the hidden colour of a nearly clear pixel', () => {
    const rgba = new Uint8Array([0, 0, 0, 2, 255, 255, 255, 2]);
    expect([...edges(rgba, 2, 1)]).toEqual([0, 0]);
  });

  it('a single pixel has no edges', () => {
    expect([...edges(new Uint8Array([1, 2, 3, 255]), 1, 1)]).toEqual([0]);
  });
});

describe('remap', () => {
  it('without dithering, each pixel takes its nearest colour', () => {
    const out = remap(ramp(101), 101, 1, grey([0, 100]), { dither: 0 });
    expect([out[0], out[49], out[51], out[100]]).toEqual([0, 0, 1, 1]);
  });

  it('dithering mixes the two colours across a smooth ramp, matching its average', () => {
    const w = 101,
      h = 8;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) rgba.set(ramp(w), y * w * 4);
    const out = remap(rgba, w, h, grey([30, 70]), { dither: 1 });
    const mid = [...out].filter((_, i) => i % w >= 40 && i % w < 60);
    const share = mid.reduce((n, k) => n + k, 0) / mid.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.75);
  });

  it('clear pixels take the clear colour and pass no error on', () => {
    const p = grey([0, 0, 100]);
    p.a[0] = 0;
    const rgba = new Uint8Array([50, 50, 50, 255, 9, 9, 9, 0, 9, 9, 9, 0, 50, 50, 50, 255]);
    const out = remap(rgba, 4, 1, p, { dither: 1, clear: 0 });
    expect([out[1], out[2]]).toEqual([0, 0]);
    expect(out[3]).not.toBe(0);
  });

  it('an opaque pixel never takes a see-through colour', () => {
    const p = grey([10, 200]);
    p.a[0] = 250;
    const out = remap(new Uint8Array([12, 12, 12, 255]), 1, 1, p, { dither: 0 });
    expect(out[0]).toBe(1);
  });

  it('dithers a 1-pixel-wide column and a 1-pixel-high row without reading outside', () => {
    const column = new Uint8Array(64 * 4);
    for (let y = 0; y < 64; y++) column.set([y * 4, y * 4, y * 4, 255], y * 4);
    expect(remap(column, 1, 64, grey([0, 255]), { dither: 1 }).length).toBe(64);
    expect(remap(column, 64, 1, grey([0, 255]), { dither: 1 }).length).toBe(64);
  });
});

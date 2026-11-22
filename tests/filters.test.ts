/** Row filters: which one each row gets, and that every decoder reads the same pixels back. */
import { describe, expect, it } from 'vitest';
import {
  encodeIndexedPng,
  encodeIndexedPngSync,
  quantize,
  quantizeSync,
  type Filter,
} from '../src/index.js';
import { bitDepth } from '../src/png.js';
import {
  decodeWithPngjs,
  decodeWithSharp,
  deflate,
  expectSamePixels,
  gradient,
  random,
  readPng,
} from './helpers.js';

const palette = (n: number) =>
  new Uint8Array(n * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 256));

/** libpng's heuristic, written out plainly: the sum of each filtered byte read as a signed value. */
function referenceChoice(cur: Uint8Array, prev: Uint8Array): number {
  const sums = [0, 0, 0, 0, 0];
  for (let x = 0; x < cur.length; x++) {
    const a = x > 0 ? cur[x - 1]! : 0,
      b = prev[x]!,
      c = x > 0 ? prev[x - 1]! : 0;
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    const preds = [0, a, b, (a + b) >> 1, paeth];
    preds.forEach((pred, t) => {
      const v = (cur[x]! - pred) & 255;
      sums[t]! += v < 128 ? v : 256 - v;
    });
  }
  return sums.indexOf(Math.min(...sums));
}

/** Rows of packed bytes as the writer sees them (bits per pixel below 8 pack several pixels). */
function packedRows(indices: Uint8Array, width: number, height: number, depth: number) {
  const bpl = Math.ceil((width * depth) / 8);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(bpl);
    for (let x = 0; x < width; x++) {
      const at = Math.floor((x * depth) / 8);
      row[at] = row[at]! | (indices[y * width + x]! << (8 - depth - ((x * depth) % 8)));
    }
    rows.push(row);
  }
  return rows;
}

describe('row filters', () => {
  it('a horizontal ramp takes sub, repeated rows take up, a flat row takes none', () => {
    // Row 0: 0, 1, 2 ... 255 (sub leaves all ones). Rows 1 to 3: the same (up leaves zeros).
    // Row 4: zeros (none is already zero and wins the tie). Row 5: zeros again (none, tie with up).
    const width = 256,
      height = 6;
    const indices = new Uint8Array(width * height);
    for (let y = 0; y < 4; y++) for (let x = 0; x < width; x++) indices[y * width + x] = x;
    const png = readPng(
      encodeIndexedPngSync(width, height, palette(256), indices, { deflate, filter: 'adaptive' }),
    );
    expect(png.filters).toEqual([1, 2, 2, 2, 0, 0]);
    expect(png.indices).toEqual(indices);
  });

  it('matches the libpng heuristic row by row at every bit depth', () => {
    const r = random(7);
    for (const colors of [2, 3, 4, 9, 16, 17, 256]) {
      const depth = bitDepth(colors);
      const width = 37,
        height = 24;
      const indices = new Uint8Array(width * height);
      // Mixed content: a ramp, noise, vertical stripes and a flat patch, so every filter has a turn.
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          indices[y * width + x] =
            y < 6
              ? (x * colors) / width
              : y < 12
                ? r() * colors
                : y < 18
                  ? (x >> 1) % colors
                  : Math.min(colors - 1, y - 18);
      const rows = packedRows(indices, width, height, depth);
      const want = rows.map((row, y) =>
        referenceChoice(row, y > 0 ? rows[y - 1]! : new Uint8Array(row.length)),
      );
      const png = readPng(
        encodeIndexedPngSync(width, height, palette(colors), indices, {
          deflate,
          filter: 'adaptive',
        }),
      );
      expect(png.depth).toBe(depth);
      expect(png.filters).toEqual(want);
      expect(new Set(want).size).toBeGreaterThan(1);
      expect(png.indices).toEqual(indices);
    }
  });

  it('independent decoders read the same pixels back from filtered and unfiltered files', async () => {
    const r = random(3);
    for (const colors of [2, 4, 16, 256]) {
      const width = 29,
        height = 11;
      const rgba = new Uint8Array(width * height * 4);
      const pal = palette(colors);
      for (let i = 0; i < width * height; i++) {
        const k = Math.floor(r() * colors);
        rgba.set(pal.subarray(k * 4, k * 4 + 4), i * 4);
      }
      for (const filter of ['adaptive', 'none'] as Filter[]) {
        const sync = quantizeSync(rgba, width, height, { deflate, filter });
        const native = await quantize(rgba, width, height, { filter });
        expect(sync.exact).toBe(true);
        for (const q of [sync, native]) {
          expectSamePixels(rgba, decodeWithPngjs(q.png).rgba);
          expectSamePixels(rgba, (await decodeWithSharp(q.png)).rgba);
          expectSamePixels(rgba, readPng(q.png).rgba);
        }
        const filters = readPng(sync.png).filters;
        if (filter === 'none') expect(filters.every((f) => f === 0)).toBe(true);
      }
    }
  });

  it('is deterministic and leaves the pixels alone; the filter only changes the bytes', () => {
    const rgba = gradient(300, 40, [10, 20, 30], [250, 240, 230]);
    const plain = quantizeSync(rgba, 300, 40, { deflate });
    const a = quantizeSync(rgba, 300, 40, { deflate, filter: 'adaptive' });
    const b = quantizeSync(rgba, 300, 40, { deflate, filter: 'adaptive' });
    expect(plain.png).toEqual(quantizeSync(rgba, 300, 40, { deflate, filter: 'none' }).png);
    expect(readPng(plain.png).filters.every((f) => f === 0)).toBe(true);
    expect(a.png).toEqual(b.png);
    expect(a.indices).toEqual(plain.indices);
    expect(readPng(a.png).rgba).toEqual(readPng(plain.png).rgba);
    expect(a.png).not.toEqual(plain.png);
  });

  it('rejects an unknown filter', async () => {
    const rgba = gradient(8, 2, [0, 0, 0], [255, 255, 255]);
    const bad = { filter: 'paeth' as never };
    expect(() => quantizeSync(rgba, 8, 2, { deflate, ...bad })).toThrow(RangeError);
    await expect(quantize(rgba, 8, 2, bad)).rejects.toThrow(RangeError);
    const indices = new Uint8Array(16);
    expect(() => encodeIndexedPngSync(8, 2, palette(2), indices, { deflate, ...bad })).toThrow(
      RangeError,
    );
    await expect(encodeIndexedPng(8, 2, palette(2), indices, bad)).rejects.toThrow(RangeError);
  });
});

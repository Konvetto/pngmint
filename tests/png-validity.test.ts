/** Output files checked by decoders we did not write: pngjs (pure JS, CRCs) and sharp (libvips). */
import { describe, expect, it } from 'vitest';
import { presets, quantize } from '../src/index.js';
import {
  decodeWithPngjs,
  decodeWithSharp,
  expectSamePixels,
  flat,
  gradient,
  mse,
  noise,
} from './helpers.js';

const cases: { name: string; w: number; h: number; rgba: Uint8Array; opts?: object }[] = [
  { name: '1 colour, 1 bit', w: 5, h: 3, rgba: new Uint8Array(5 * 3 * 4).fill(9) },
  {
    name: '2 colours, 1 bit, odd width',
    w: 13,
    h: 7,
    rgba: flat(13, 7, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]),
  },
  {
    name: '3 colours, 2 bits',
    w: 9,
    h: 9,
    rgba: flat(9, 9, [
      [1, 2, 3, 255],
      [4, 5, 6, 255],
      [7, 8, 9, 255],
    ]),
  },
  {
    name: '16 colours, 4 bits',
    w: 33,
    h: 5,
    rgba: gradient(33, 5, [0, 0, 0], [240, 240, 240]),
    opts: { maxColors: 16 },
  },
  { name: '17 colours, 8 bits', w: 17, h: 2, rgba: gradient(17, 2, [0, 0, 0], [255, 255, 255]) },
  { name: '256 colours', w: 256, h: 3, rgba: gradient(256, 3, [0, 0, 0], [255, 255, 255]) },
  {
    name: 'transparent and semi-transparent',
    w: 20,
    h: 20,
    rgba: flat(20, 20, [
      [255, 0, 0, 0],
      [0, 255, 0, 128],
      [0, 0, 255, 255],
      [9, 9, 9, 3],
    ]),
  },
  { name: 'all clear', w: 4, h: 4, rgba: new Uint8Array(64) },
  { name: 'noise, 32 colours dithered', w: 40, h: 30, rgba: noise(40, 30), opts: presets.tiny },
  {
    name: '1 x 200',
    w: 1,
    h: 200,
    rgba: gradient(1, 200, [0, 0, 0], [0, 0, 0]).map((_, i) =>
      i % 4 === 3 ? 255 : (i >> 2) % 200,
    ),
  },
  {
    name: '200 x 1',
    w: 200,
    h: 1,
    rgba: gradient(200, 1, [10, 200, 30], [200, 10, 90]),
    opts: { maxColors: 8, dither: 1 },
  },
];

describe('independent decoders accept every file', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const q = quantize(c.rgba, c.w, c.h, c.opts);
      const js = decodeWithPngjs(q.png);
      const vips = await decodeWithSharp(q.png);
      expect([js.width, js.height]).toEqual([c.w, c.h]);
      expect([vips.width, vips.height]).toEqual([c.w, c.h]);
      // Both decoders see the same pixels (sharp stores clear pixels as it likes).
      expectSamePixels(js.rgba, vips.rgba);
      if (q.exact) expectSamePixels(c.rgba, js.rgba);
      else expect(mse(c.rgba, js.rgba)).toBeLessThan(2500);
    });
  }

  it('the chunk layout is minimal and in order', () => {
    const png = quantize(
      flat(8, 8, [
        [0, 0, 0, 255],
        [0, 0, 0, 0],
      ]),
      8,
      8,
    ).png;
    const types: string[] = [];
    for (let at = 8; at < png.length;) {
      const len = new DataView(png.buffer, png.byteOffset).getUint32(at);
      types.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
      at += 12 + len;
    }
    expect(types).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  });
});

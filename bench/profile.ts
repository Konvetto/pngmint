/**
 * Where the time goes: phase timings of one quantization. Usage: pnpm tsx bench/profile.ts <image> [colors] [dither]
 */
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { histogram } from '../src/histogram.js';
import { finish, medianCut, refine } from '../src/palette.js';
import { nativeDeflate, writePng } from '../src/png.js';
import { remap } from '../src/remap.js';
import { quantizeSync } from '../src/index.js';
import { zlibSync } from 'fflate';

const [file, colorsArg = '256', ditherArg = '0'] = process.argv.slice(2);
if (!file) throw new Error('usage: profile.ts <image> [colors] [dither]');
const colors = Number(colorsArg);
const dither = Number(ditherArg);
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const { width, height } = info;
console.log(`${file}: ${width}x${height}, ${((width * height) / 1e6).toFixed(1)} MP`);

const lap = (() => {
  let t = performance.now();
  return (label: string) => {
    const now = performance.now();
    console.log(`  ${label.padEnd(28)} ${(now - t).toFixed(0).padStart(6)} ms`);
    t = now;
  };
})();

for (let round = 0; round < 2; round++) {
  console.log(round ? 'warm:' : 'cold:');
  const h = histogram(rgba);
  lap(`histogram (${h.size} entries, exact ${h.exact})`);
  const p = medianCut(h, colors);
  lap('medianCut');
  refine(h, p, 2);
  lap('refine x2');
  const { matched, straight } = finish(p);
  lap('finish');
  const plain = remap(rgba, width, height, matched, { dither: 0 });
  lap('remap, no dither');
  if (dither > 0) {
    remap(rgba, width, height, matched, { dither });
    lap(`remap, dither ${dither}`);
  }
  const png = writePng(width, height, straight, plain, (raw) =>
    zlibSync(raw, { level: 9 }),
  ) as Uint8Array;
  lap(`writePng fflate 9 (${(png.length / 1024).toFixed(0)} kB)`);
  const png6 = writePng(width, height, straight, plain, (raw) =>
    zlibSync(raw, { level: 6 }),
  ) as Uint8Array;
  lap(`writePng fflate 6 (${(png6.length / 1024).toFixed(0)} kB)`);
  const pngN = await writePng(width, height, straight, plain, nativeDeflate);
  lap(`writePng CompressionStream (${(pngN.length / 1024).toFixed(0)} kB)`);
  const t = performance.now();
  const q = quantizeSync(rgba, width, height, {
    maxColors: colors,
    dither,
    deflate: (raw) => zlibSync(raw, { level: 9 }),
  });
  console.log(
    `  quantize() total ${(performance.now() - t).toFixed(0)} ms, ${q.colors} colours, ${(q.png.length / 1024).toFixed(0)} kB`,
  );
  const heap = process.memoryUsage();
  console.log(
    `  heap used ${(heap.heapUsed / 1e6).toFixed(0)} MB, rss ${(heap.rss / 1e6).toFixed(0)} MB`,
  );
}

/**
 * Deflate choices for the IDAT: fflate at levels 9 and 6 against the platform's
 * CompressionStream('deflate'). Same palette and indices, only the compressor differs.
 * Usage: pnpm tsx bench/deflate.ts
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { zlibSync } from 'fflate';
import sharp from 'sharp';
import { nativeDeflate as native, presets, quantizeSync } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, 'images.json'), 'utf8')) as {
  images: { file: string }[];
};

const time = async (fn: () => Promise<Uint8Array> | Uint8Array) => {
  const t = performance.now();
  const out = await fn();
  return { out, ms: performance.now() - t };
};

const rows: string[] = [];
const totals = { f9: 0, f6: 0, nat: 0, t9: 0, t6: 0, tn: 0 };
for (const image of manifest.images) {
  const { data, info } = await sharp(join(here, 'images', image.file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (const [name, preset] of [
    ['quality', presets.quality],
    ['tiny', presets.tiny],
  ] as const) {
    // A deflate hook that keeps the raw rows and stores them uncompressed: the input for each compressor.
    let raw: Uint8Array = new Uint8Array();
    const q = quantizeSync(rgba, info.width, info.height, {
      ...preset,
      deflate: (rows) => ((raw = rows), zlibSync(rows, { level: 0 })),
    });
    const f9 = await time(() => zlibSync(raw, { level: 9 }));
    const f6 = await time(() => zlibSync(raw, { level: 6 }));
    const nat = await time(() => native(raw));
    totals.f9 += f9.out.length;
    totals.f6 += f6.out.length;
    totals.nat += nat.out.length;
    totals.t9 += f9.ms;
    totals.t6 += f6.ms;
    totals.tn += nat.ms;
    rows.push(
      `| ${image.file} | ${name} | ${q.colors} | ${kb(f9.out.length)} | ${kb(f6.out.length)} (${pct(f6.out.length, f9.out.length)}) | ${kb(nat.out.length)} (${pct(nat.out.length, f9.out.length)}) | ${f9.ms.toFixed(0)} | ${f6.ms.toFixed(0)} | ${nat.ms.toFixed(0)} |`,
    );
    console.log(rows[rows.length - 1]);
  }
}
console.log(
  '\n| Image | Preset | Colours | fflate 9 kB | fflate 6 kB | CompressionStream kB | ms 9 | ms 6 | ms native |',
);
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|');
console.log(rows.join('\n'));
console.log(
  `| **Total** | | | ${kb(totals.f9)} | ${kb(totals.f6)} (${pct(totals.f6, totals.f9)}) | ${kb(totals.nat)} (${pct(totals.nat, totals.f9)}) | ${totals.t9.toFixed(0)} | ${totals.t6.toFixed(0)} | ${totals.tn.toFixed(0)} |`,
);

function kb(b: number) {
  return (b / 1024).toFixed(1);
}
function pct(b: number, base: number) {
  const v = ((b / base - 1) * 100).toFixed(1);
  return (v.startsWith('-') ? '' : '+') + v + '%';
}

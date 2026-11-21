/**
 * Benchmark: this package against UPNG.js, image-q and libimagequant (wasm), with lossless oxipng as a
 * size reference. Every contender gets the same straight RGBA pixels and the same colour count.
 * Output files are decoded again with sharp (libvips) and compared with the original: PSNR
 * (premultiplied RGB, plus alpha when the source has any), SSIM (grayscale, over white) and
 * wall time (median of up to 3 runs after a warm-up).
 *
 * Usage: pnpm bench [--colors 256,64] [--only kodim] [--max-mp 8] [--runs 3] [--libs name,name]
 * Results: bench/out/results.json and bench/out/results.md. With --libs or --only, rows of the
 * other libraries and images are kept from the previous results.json.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { quantize } from '../src/index.js';
import { contenders, NAME, type Contender } from './lib/contenders.js';
import { psnr, ssimOverWhite } from './lib/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!, process.argv[i + 1] ?? '');
const colorSteps = (args.get('--colors') ?? '256,128,64,32').split(',').map(Number);
const only = args.get('--only');
const maxMp = Number(args.get('--max-mp') ?? Infinity);
const runs = Number(args.get('--runs') ?? 3);
const libs = args.get('--libs')?.split(',');

interface Manifest {
  images: { file: string; kind: string; license: string; source: string }[];
}
const manifest = JSON.parse(await readFile(join(here, 'images.json'), 'utf8')) as Manifest;

export interface Row {
  image: string;
  kind: string;
  width: number;
  height: number;
  colors: number;
  library: string;
  bytes: number;
  psnr: number;
  ssim: number;
  ms: number;
  note?: string;
}

const outDir = join(here, 'out');
await mkdir(outDir, { recursive: true });
const active = contenders.filter((c) => !libs || libs.includes(c.name));
const isPreset = (r: Row) => r.library.startsWith(`${NAME}:`);
const runsPresets = !libs || libs.includes(NAME);
// A partial run keeps the rows it does not redo.
const previous: Row[] = await readFile(join(outDir, 'results.json'), 'utf8')
  .then((t) => (JSON.parse(t) as { rows: Row[] }).rows)
  .catch(() => []);
const rows: Row[] = previous.filter(
  (r) =>
    (only !== undefined && !r.image.includes(only)) ||
    !(active.some((c) => c.name === r.library) || (runsPresets && isPreset(r))),
);

async function timeIt(fn: () => Promise<Uint8Array> | Uint8Array) {
  const times: number[] = [];
  let out!: Uint8Array;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    times.push(performance.now() - t);
    if (times[0]! > 4000) break; // slow runs: one is enough
  }
  times.sort((a, b) => a - b);
  return { out, ms: times[times.length >> 1]! };
}

// Warm-up on a tiny image so JIT and wasm start-up stay out of the numbers.
{
  const tiny = new Uint8Array(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) & 255));
  for (const c of active) if (c.lossy) await c.run(tiny, 32, 32, 16);
}

for (const image of manifest.images) {
  if (only && !image.file.includes(only)) continue;
  const path = join(here, 'images', image.file);
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const { width, height } = info;
  const mp = (width * height) / 1e6;
  let hasAlpha = false;
  for (let i = 3; i < rgba.length && !hasAlpha; i += 4) hasAlpha = rgba[i] !== 255;
  const channels = hasAlpha ? 4 : 3;
  console.log(`\n${image.file} ${width}x${height} (${mp.toFixed(1)} MP, ${image.kind})`);

  const measure = async (c: Contender, colors: number) => {
    if (mp > maxMp && c.name !== NAME) return;
    let result: { out: Uint8Array; ms: number };
    try {
      result = await timeIt(() => c.run(rgba, width, height, colors));
    } catch (e) {
      console.log(`  ${c.name.padEnd(14)} ${String(colors).padStart(3)}  failed: ${String(e)}`);
      rows.push({
        image: image.file,
        kind: image.kind,
        width,
        height,
        colors,
        library: c.name,
        bytes: 0,
        psnr: 0,
        ssim: 0,
        ms: 0,
        note: `failed: ${String(e).slice(0, 80)}`,
      });
      return;
    }
    const decoded = await sharp(Buffer.from(result.out)).ensureAlpha().raw().toBuffer();
    const back = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    const row: Row = {
      image: image.file,
      kind: image.kind,
      width,
      height,
      colors,
      library: c.name,
      bytes: result.out.length,
      psnr: psnr(rgba, back, channels),
      ssim: ssimOverWhite(rgba, back, width, height),
      ms: result.ms,
    };
    if (c.note) row.note = c.note;
    rows.push(row);
    await writeFile(join(outDir, `${image.file}.${c.name}.${colors}.png`), result.out);
    console.log(
      `  ${c.name.padEnd(14)} ${String(colors).padStart(3)}  ${(row.bytes / 1024).toFixed(1).padStart(8)} kB  ${row.psnr.toFixed(2).padStart(6)} dB  ssim ${row.ssim.toFixed(4)}  ${row.ms.toFixed(0).padStart(6)} ms`,
    );
  };

  for (const c of active) {
    if (!c.lossy) {
      await measure(c, 0);
      continue;
    }
    for (const colors of colorSteps) await measure(c, colors);
  }
  // The presets, which also shrink the palette while the quality holds (default compressor).
  if (runsPresets) {
    const { presets } = await import('../src/index.js');
    for (const [name, preset] of Object.entries(presets)) {
      const r = await timeIt(async () => (await quantize(rgba, width, height, preset)).png);
      const decoded = await sharp(Buffer.from(r.out)).ensureAlpha().raw().toBuffer();
      const back = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const q = await quantize(rgba, width, height, preset);
      rows.push({
        image: image.file,
        kind: image.kind,
        width,
        height,
        colors: q.colors,
        library: `${NAME}:${name}`,
        bytes: r.out.length,
        psnr: psnr(rgba, back, channels),
        ssim: ssimOverWhite(rgba, back, width, height),
        ms: r.ms,
      });
      console.log(
        `  preset ${name.padEnd(8)} ${String(q.colors).padStart(3)}  ${(r.out.length / 1024).toFixed(1).padStart(8)} kB  ${psnr(rgba, back, channels).toFixed(2).padStart(6)} dB  ${r.ms.toFixed(0).padStart(6)} ms`,
      );
    }
  }
}

await writeFile(
  join(outDir, 'results.json'),
  JSON.stringify({ date: new Date().toISOString(), node: process.version, rows }, null, 1),
);
const { report } = await import('./lib/report.js');
const md = report(rows);
await writeFile(join(outDir, 'results.md'), md);
console.log(`\n${md}`);

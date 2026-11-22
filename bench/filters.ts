/**
 * Row filters: the adaptive per-row filter (the default since 1.1) against unfiltered rows, with
 * both compressors, plus oxipng level 2 run on the finished file as the reference for what a
 * dedicated optimizer still finds. Same palette and indices in every column, only the writer
 * differs. Usage: pnpm tsx bench/filters.ts [--only kodim] [--presets quality,tiny] [--runs 3]
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { zlibSync } from 'fflate';
import sharp from 'sharp';
import {
  encodeIndexedPng,
  encodeIndexedPngSync,
  presets,
  quantizeSync,
  type Filter,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!, process.argv[i + 1] ?? '');
const only = args.get('--only');
const runs = Number(args.get('--runs') ?? 3);
const presetNames = (args.get('--presets') ?? 'quality,balanced,small,tiny').split(
  ',',
) as (keyof typeof presets)[];

const manifest = JSON.parse(await readFile(join(here, 'images.json'), 'utf8')) as {
  images: { file: string; kind: string }[];
};
const fflate9 = (raw: Uint8Array) => zlibSync(raw, { level: 9 });

const oxi = await (async () => {
  const mod = (await import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js')) as unknown as {
    default: (bytes: Uint8Array) => Promise<unknown>;
    optimise: (png: Uint8Array, level: number, interlace: boolean, alpha: boolean) => Uint8Array;
  };
  await mod.default(
    await readFile(require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')),
  );
  return (png: Uint8Array) => mod.optimise(png, 2, false, false);
})();

/** Median wall time of up to `runs` runs; one run when the first takes over 3 s. */
async function timeIt(fn: () => Promise<Uint8Array> | Uint8Array) {
  const times: number[] = [];
  let out!: Uint8Array;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    times.push(performance.now() - t);
    if (times[0]! > 3000) break;
  }
  times.sort((a, b) => a - b);
  return { out, ms: times[times.length >> 1]! };
}

interface Case {
  image: string;
  kind: string;
  preset: string;
  colors: number;
  /** Bytes and encode time (rows + deflate) per writer and compressor. */
  noneFflate: { bytes: number; ms: number };
  adaptiveFflate: { bytes: number; ms: number };
  noneNative: { bytes: number; ms: number };
  adaptiveNative: { bytes: number; ms: number };
  /** Time of the row pass alone (filter selection included), without deflate. */
  rowsNoneMs: number;
  rowsAdaptiveMs: number;
  /** oxipng level 2 on the unfiltered fflate file, and on the adaptive one. */
  oxiOfNone: { bytes: number; ms: number };
  oxiOfAdaptive: { bytes: number; ms: number };
  /** How many rows took each filter type, 0 to 4. */
  histogram: number[];
}

const cases: Case[] = [];
// Warm-up so JIT and wasm start-up stay out of the numbers.
{
  const tiny = new Uint8Array(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) & 255));
  const q = quantizeSync(tiny, 64, 64, { maxColors: 16, deflate: fflate9 });
  for (const filter of ['none', 'adaptive'] as const) {
    encodeIndexedPngSync(64, 64, q.palette, q.indices, { deflate: fflate9, filter });
    await encodeIndexedPng(64, 64, q.palette, q.indices, { filter });
  }
  oxi(q.png);
}

for (const image of manifest.images) {
  if (only && !image.file.includes(only)) continue;
  const { data, info } = await sharp(join(here, 'images', image.file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const { width, height } = info;
  for (const name of presetNames) {
    const preset = presets[name];
    const q = quantizeSync(rgba, width, height, { ...preset, deflate: fflate9, filter: 'none' });
    const { palette, indices } = q;
    const enc = (filter: Filter, deflate?: typeof fflate9) =>
      timeIt(() =>
        deflate
          ? encodeIndexedPngSync(width, height, palette, indices, { deflate, filter })
          : encodeIndexedPng(width, height, palette, indices, { filter }),
      );
    const noneFflate = await enc('none', fflate9);
    const adaptiveFflate = await enc('adaptive', fflate9);
    const noneNative = await enc('none');
    const adaptiveNative = await enc('adaptive');
    // The row pass alone: a deflate that stores the rows as they are.
    const store = (raw: Uint8Array) => raw;
    const rowsNone = await timeIt(() =>
      encodeIndexedPngSync(width, height, palette, indices, { deflate: store, filter: 'none' }),
    );
    const rowsAdaptive = await timeIt(() =>
      encodeIndexedPngSync(width, height, palette, indices, { deflate: store, filter: 'adaptive' }),
    );
    const histogram = [0, 0, 0, 0, 0];
    {
      const raw = encodeIndexedPngSync(width, height, palette, indices, {
        deflate: store,
        filter: 'adaptive',
      });
      // IHDR (25 bytes) + PLTE + optional tRNS precede IDAT; find IDAT and walk its rows.
      const view = new DataView(raw.buffer, raw.byteOffset);
      let at = 8;
      while (String.fromCharCode(...raw.subarray(at + 4, at + 8)) !== 'IDAT')
        at += 12 + view.getUint32(at);
      const body = raw.subarray(at + 8, at + 8 + view.getUint32(at));
      const depth = raw[24]!;
      const bpl = Math.ceil((width * depth) / 8);
      for (let y = 0; y < height; y++) histogram[body[y * (bpl + 1)]!]!++;
    }
    const oxiOfNone = await timeIt(() => oxi(noneFflate.out));
    const oxiOfAdaptive = await timeIt(() => oxi(adaptiveFflate.out));
    const sized = (r: { out: Uint8Array; ms: number }) => ({ bytes: r.out.length, ms: r.ms });
    const c: Case = {
      image: image.file,
      kind: image.kind,
      preset: name,
      colors: q.colors,
      noneFflate: sized(noneFflate),
      adaptiveFflate: sized(adaptiveFflate),
      noneNative: sized(noneNative),
      adaptiveNative: sized(adaptiveNative),
      rowsNoneMs: rowsNone.ms,
      rowsAdaptiveMs: rowsAdaptive.ms,
      oxiOfNone: sized(oxiOfNone),
      oxiOfAdaptive: sized(oxiOfAdaptive),
      histogram,
    };
    cases.push(c);
    console.log(
      `${image.file.padEnd(30)} ${name.padEnd(8)} ${String(c.colors).padStart(3)}c  fflate ${kb(c.noneFflate.bytes)} -> ${kb(c.adaptiveFflate.bytes)} (${pct(c.adaptiveFflate.bytes, c.noneFflate.bytes)})  native ${kb(c.noneNative.bytes)} -> ${kb(c.adaptiveNative.bytes)} (${pct(c.adaptiveNative.bytes, c.noneNative.bytes)})  oxipng ${kb(c.oxiOfNone.bytes)}  rows ${c.rowsNoneMs.toFixed(0)} -> ${c.rowsAdaptiveMs.toFixed(0)} ms  encode ${c.noneFflate.ms.toFixed(0)} -> ${c.adaptiveFflate.ms.toFixed(0)} ms  filters ${histogram.join('/')}`,
    );
  }
}

const sum = (f: (c: Case) => number, cs = cases) => cs.reduce((n, c) => n + f(c), 0);
const lines: string[] = [];
lines.push(
  `# Row filters, measured`,
  '',
  `Generated by \`pnpm tsx bench/filters.ts\` on ${new Date().toISOString().slice(0, 10)}, Node ${process.version}, median of up to ${runs} runs. Same palette and indices in every column; only the writer differs. "oxipng" is oxipng level 2 (@jsquash/oxipng) run on the finished pngmint file, as a reference for what a dedicated optimizer still finds.`,
  '',
);
lines.push('## Totals', '');
lines.push(
  '| Group | Cases | none + fflate 9 | adaptive + fflate 9 | none + CompressionStream | adaptive + CompressionStream | oxipng 2 on none | oxipng 2 on adaptive | encode none (ms) | encode adaptive (ms) | row pass none (ms) | row pass adaptive (ms) |',
);
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
const groups: [string, (c: Case) => boolean][] = [
  ['all', () => true],
  ['photos', (c) => c.kind === 'photo'],
  ['graphics', (c) => c.kind !== 'photo'],
  ...presetNames.map((p): [string, (c: Case) => boolean] => [`preset ${p}`, (c) => c.preset === p]),
];
for (const [name, inGroup] of groups) {
  const cs = cases.filter(inGroup);
  if (!cs.length) continue;
  const nf = sum((c) => c.noneFflate.bytes, cs),
    af = sum((c) => c.adaptiveFflate.bytes, cs),
    nn = sum((c) => c.noneNative.bytes, cs),
    an = sum((c) => c.adaptiveNative.bytes, cs),
    on = sum((c) => c.oxiOfNone.bytes, cs),
    oa = sum((c) => c.oxiOfAdaptive.bytes, cs);
  lines.push(
    `| ${name} | ${cs.length} | ${kb(nf)} | ${kb(af)} (${pct(af, nf)}) | ${kb(nn)} | ${kb(an)} (${pct(an, nn)}) | ${kb(on)} (${pct(on, nf)}) | ${kb(oa)} (${pct(oa, af)}) | ${sum((c) => c.noneFflate.ms, cs).toFixed(0)} | ${sum((c) => c.adaptiveFflate.ms, cs).toFixed(0)} | ${sum((c) => c.rowsNoneMs, cs).toFixed(0)} | ${sum((c) => c.rowsAdaptiveMs, cs).toFixed(0)} |`,
  );
}
lines.push('');
lines.push('## Every case', '');
lines.push(
  '| Image | Preset | Colours | none + fflate 9 kB | adaptive + fflate 9 kB | none + CS kB | adaptive + CS kB | oxipng 2 on none kB | oxipng 2 on adaptive kB | encode none ms | encode adaptive ms | row pass none ms | row pass adaptive ms | oxipng ms | filters 0/1/2/3/4 |',
);
lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const c of cases)
  lines.push(
    `| ${c.image} | ${c.preset} | ${c.colors} | ${kb(c.noneFflate.bytes)} | ${kb(c.adaptiveFflate.bytes)} (${pct(c.adaptiveFflate.bytes, c.noneFflate.bytes)}) | ${kb(c.noneNative.bytes)} | ${kb(c.adaptiveNative.bytes)} (${pct(c.adaptiveNative.bytes, c.noneNative.bytes)}) | ${kb(c.oxiOfNone.bytes)} (${pct(c.oxiOfNone.bytes, c.noneFflate.bytes)}) | ${kb(c.oxiOfAdaptive.bytes)} (${pct(c.oxiOfAdaptive.bytes, c.adaptiveFflate.bytes)}) | ${c.noneFflate.ms.toFixed(0)} | ${c.adaptiveFflate.ms.toFixed(0)} | ${c.rowsNoneMs.toFixed(0)} | ${c.rowsAdaptiveMs.toFixed(0)} | ${c.oxiOfNone.ms.toFixed(0)} | ${c.histogram.join('/')} |`,
  );
const md = lines.join('\n') + '\n';
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(join(here, 'out'), { recursive: true });
await writeFile(join(here, 'out', 'filters.md'), md);
await writeFile(join(here, 'out', 'filters.json'), JSON.stringify(cases, null, 1));
console.log(`\n${md}`);

function kb(b: number) {
  return (b / 1024).toFixed(1);
}
function pct(b: number, base: number) {
  const v = ((b / base - 1) * 100).toFixed(1);
  return (v.startsWith('-') ? '' : '+') + v + '%';
}

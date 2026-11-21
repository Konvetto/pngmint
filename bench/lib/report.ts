/** Markdown tables from benchmark rows: a summary per colour count and the full per-image table. */
import { HOOKED, NAME } from './contenders.js';
import type { Row } from '../run.js';

const kb = (b: number) => (b / 1024).toFixed(1);
const db = (v: number) => (v === Infinity ? 'lossless' : v.toFixed(2));
const geo = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function report(input: Row[]): string {
  // JSON has no Infinity: a lossless PSNR comes back from results.json as null.
  const rows = input.map((r) => ({ ...r, psnr: (r.psnr as number | null) ?? Infinity }));
  const ok = rows.filter((r) => !r.note?.startsWith('failed'));
  const libs = [...new Set(ok.map((r) => r.library))].filter(
    (l) => !l.startsWith(`${NAME}:`) && l !== 'oxipng',
  );
  const colorSteps = [...new Set(ok.filter((r) => r.library === NAME).map((r) => r.colors))].sort(
    (a, b) => b - a,
  );
  const lines: string[] = [];

  lines.push(`## Summary: other libraries relative to ${NAME}, same colour count`, '');
  lines.push(
    `Size ratio is the geometric mean of (library bytes / ${NAME} bytes): below 1.00 means the other library is smaller. PSNR and SSIM are mean differences (library minus ${NAME}): below 0 means ${NAME} is closer to the original. Time ratio is the geometric mean of (library ms / ${NAME} ms).`,
    '',
  );
  lines.push(
    `${NAME} rows are the default install (CompressionStream). "${HOOKED}" is the same output compressed through the optional deflate hook with fflate level 9: shown apart, never mixed into the ${NAME} numbers.`,
    '',
  );
  lines.push(
    'Photos are the five photographs; graphics are the screenshots, illustrations, logos and pixel art, where most libraries land above 45 dB and dB differences mean little.',
    '',
  );
  lines.push(
    '| Colours | Library | Set | Images | Size ratio | PSNR diff (dB) | SSIM diff | Time ratio |',
  );
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|');
  const sets: [string, (r: Row) => boolean][] = [
    ['photos', (r) => r.kind === 'photo'],
    ['graphics', (r) => r.kind !== 'photo'],
  ];
  for (const colors of colorSteps) {
    for (const lib of libs) {
      if (lib === NAME) continue;
      for (const [set, inSet] of sets) {
        const pairs = ok
          .filter((r) => r.library === lib && r.colors === colors && inSet(r))
          .map(
            (r) =>
              [
                r,
                ok.find((p) => p.library === NAME && p.image === r.image && p.colors === colors),
              ] as const,
          )
          .filter((pair): pair is readonly [Row, Row] => {
            const [r, p] = pair;
            return p !== undefined && r.psnr !== Infinity && p.psnr !== Infinity;
          });
        if (!pairs.length) continue;
        lines.push(
          `| ${colors} | ${lib} | ${set} | ${pairs.length} | ${geo(pairs.map(([r, p]) => r.bytes / p.bytes)).toFixed(2)} | ${signed(mean(pairs.map(([r, p]) => r.psnr - p.psnr)), 2)} | ${signed(mean(pairs.map(([r, p]) => r.ssim - p.ssim)), 4)} | ${geo(pairs.map(([r, p]) => r.ms / p.ms)).toFixed(2)} |`,
        );
      }
    }
  }
  lines.push('');

  lines.push('## With and without the deflate hook vs other libraries', '');
  lines.push(
    `Totals and means per colour count and group. ${NAME} is the default install (CompressionStream); "${HOOKED}" is the same palette and pixels compressed through the optional deflate option with fflate level 9. Size and time are sums over the group's images; PSNR and SSIM are means over the images where every library is lossy (lossless rows have no finite PSNR and are left out of the means).`,
    '',
  );
  lines.push(
    '| Colours | Group | Library | Size (kB) | Size vs default | PSNR (dB) | SSIM | Time (ms) | Time vs default |',
  );
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|');
  const allLibs = [NAME, HOOKED, ...libs.filter((l) => l !== NAME && l !== HOOKED)];
  for (const colors of colorSteps) {
    for (const [set, inSet] of sets) {
      const images = [
        ...new Set(ok.filter((r) => r.colors === colors && inSet(r)).map((r) => r.image)),
      ];
      const lossy = images.filter((im) =>
        allLibs.every((lib) => {
          const r = ok.find((x) => x.library === lib && x.image === im && x.colors === colors);
          return r !== undefined && r.psnr !== Infinity;
        }),
      );
      const base = allLibs.map((lib) =>
        ok.filter((r) => r.library === lib && r.colors === colors && images.includes(r.image)),
      );
      const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((n, r) => n + f(r), 0);
      const defaultRows = base[0]!;
      allLibs.forEach((lib, i) => {
        const rs = base[i]!;
        if (rs.length !== images.length) return;
        const quality = rs.filter((r) => lossy.includes(r.image));
        lines.push(
          `| ${colors} | ${set} | ${lib} | ${kb(sum(rs, (r) => r.bytes))} | ${(sum(rs, (r) => r.bytes) / sum(defaultRows, (r) => r.bytes)).toFixed(3)} | ${quality.length ? mean(quality.map((r) => r.psnr)).toFixed(2) : ''} | ${quality.length ? mean(quality.map((r) => r.ssim)).toFixed(4) : ''} | ${sum(rs, (r) => r.ms).toFixed(0)} | ${(sum(rs, (r) => r.ms) / sum(defaultRows, (r) => r.ms)).toFixed(2)} |`,
        );
      });
    }
  }
  lines.push('');

  lines.push('## Wins and losses per image (PSNR at the same colour count)', '');
  lines.push(
    `| Colours | Library | ${NAME} closer | other closer | ${NAME} smaller | other smaller |`,
  );
  lines.push('|---:|---|---:|---:|---:|---:|');
  for (const colors of colorSteps) {
    for (const lib of libs) {
      if (lib === NAME) continue;
      let closer = 0,
        farther = 0,
        smaller = 0,
        bigger = 0;
      for (const r of ok.filter((r) => r.library === lib && r.colors === colors)) {
        const p = ok.find((p) => p.library === NAME && p.image === r.image && p.colors === colors);
        if (!p || r.psnr === Infinity || p.psnr === Infinity) continue;
        if (p.psnr > r.psnr + 0.05) closer++;
        else if (r.psnr > p.psnr + 0.05) farther++;
        if (p.bytes < r.bytes) smaller++;
        else if (r.bytes < p.bytes) bigger++;
      }
      if (closer + farther + smaller + bigger)
        lines.push(`| ${colors} | ${lib} | ${closer} | ${farther} | ${smaller} | ${bigger} |`);
    }
  }
  lines.push('');

  lines.push('## Presets', '');
  lines.push('| Image | Preset | Colours | kB | PSNR (dB) | SSIM | ms |');
  lines.push('|---|---|---:|---:|---:|---:|---:|');
  for (const r of ok.filter((r) => r.library.startsWith(`${NAME}:`)))
    lines.push(
      `| ${r.image} | ${r.library.slice(8)} | ${r.colors} | ${kb(r.bytes)} | ${db(r.psnr)} | ${r.ssim.toFixed(4)} | ${r.ms.toFixed(0)} |`,
    );
  lines.push('');

  lines.push('## Every run', '');
  lines.push('| Image | Size | Colours | Library | kB | PSNR (dB) | SSIM | ms |');
  lines.push('|---|---|---:|---|---:|---:|---:|---:|');
  for (const r of rows.filter((r) => !r.library.startsWith(`${NAME}:`))) {
    if (r.note?.startsWith('failed')) {
      lines.push(
        `| ${r.image} | ${r.width}x${r.height} | ${r.colors || ''} | ${r.library} | ${r.note} | | | |`,
      );
      continue;
    }
    lines.push(
      `| ${r.image} | ${r.width}x${r.height} | ${r.colors || 'lossless'} | ${r.library} | ${kb(r.bytes)} | ${db(r.psnr)} | ${r.ssim.toFixed(4)} | ${r.ms.toFixed(0)} |`,
    );
  }
  lines.push('');
  const notes = [
    ...new Set(rows.map((r) => r.note).filter((n): n is string => !!n && !n.startsWith('failed'))),
  ];
  if (notes.length) lines.push('Notes:', '', ...notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}

function signed(v: number, digits: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

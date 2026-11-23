/**
 * Draws the README chart from the "With and without the deflate hook" table in bench/results.md:
 * file size, PSNR and time of the four quantizers at 256 colors, photos and graphics side by
 * side, pngmint highlighted. Writes two SVGs, one per color scheme, which the README shows
 * through <picture>. No dependencies, no network.
 *
 *   pnpm bench:chart   # after pnpm bench has updated bench/results.md
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const NAME: string = pkg.name;
const COLORS = 256;

const DISPLAY: Record<string, string> = {
  'upng-js': 'UPNG.js',
  'image-q': 'image-q',
  libimagequant: 'libimagequant',
};

interface Row {
  group: string;
  library: string;
  kb: number;
  psnr: number;
  ms: number;
}

function parse(md: string): Row[] {
  const rows: Row[] = [];
  const re =
    /^\| +(\d+) \| (\w+) +\| (.+?) +\| +([\d.]+) \| +[\d.]+ \| +([\d.]*) \| +[\d.]* \| +(\d+) \| +[\d.]+ \|$/;
  for (const line of md.split('\n')) {
    const m = re.exec(line);
    if (!m || Number(m[1]) !== COLORS) continue;
    const library = m[3]!;
    if (library !== NAME && !(library in DISPLAY)) continue; // skips the fflate hook row
    rows.push({
      group: m[2]!,
      library,
      kb: Number(m[4]),
      psnr: Number(m[5]),
      ms: Number(m[6]),
    });
  }
  if (rows.length === 0) throw new Error('no totals table found in bench/results.md');
  return rows;
}

interface Theme {
  bg: string;
  text: string;
  muted: string;
  grid: string;
  other: string;
  ours: string;
}

const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    bg: '#fcfcfb',
    text: '#0b0b0b',
    muted: '#52514e',
    grid: '#e4e3df',
    other: '#9a9994',
    ours: '#2a78d6',
  },
  dark: {
    bg: '#1a1a19',
    text: '#f0efec',
    muted: '#c3c2b7',
    grid: '#33332f',
    other: '#75746e',
    ours: '#3987e5',
  },
};

const W = 800;
const H = 600;
const FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
// Each group heading sits at the column's edge; metric titles and library names are indented
// under it, and the bars start after the longest name.
const INDENT = 14;
const COL = { x: [32, 420], names: 108, bars: 136 };
const BAR = 16;
const STEP = 23;

interface Metric {
  title: string;
  note: string;
  value: (r: Row) => number;
  fmt: (v: number) => string;
  kind: 'bar' | 'dot';
}

const METRICS: Metric[] = [
  {
    title: 'File size',
    note: 'sum of the group, lower is better',
    value: (r) => r.kb,
    fmt: (v) => (v >= 1000 ? `${(v / 1024).toFixed(1)} MB` : `${v.toFixed(0)} kB`),
    kind: 'bar',
  },
  {
    title: 'Closeness to the original',
    note: 'PSNR in dB, mean of the group, higher is better',
    value: (r) => r.psnr,
    fmt: (v) => `${v.toFixed(2)} dB`,
    kind: 'dot',
  },
  {
    title: 'Time',
    note: 'sum of the group, lower is better',
    value: (r) => r.ms,
    fmt: (v) => (v >= 10000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(0)} ms`),
    kind: 'bar',
  },
];

function svg(rows: Row[], t: Theme): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family='${FONT}' font-size="13">`,
    `<title>Four PNG quantizers at 256 colors: file size, PSNR and time</title>`,
    `<rect width="${W}" height="${H}" rx="12" fill="${t.bg}"/>`,
    `<text x="${COL.x[0]}" y="28" font-size="16" font-weight="500" fill="${t.text}">Four palette quantizers at ${COLORS} colors, same pixels in, same color count</text>`,
    `<text x="${COL.x[0]}" y="46" fill="${t.muted}">14 public-domain images, Node 26, Apple Silicon laptop, median of 3 runs. ${NAME} as installed, default compressor.</text>`,
  );

  const groups: [key: string, heading: string][] = [
    ['photos', 'Photos, 5 images|0.4 to 14 MP'],
    ['graphics', 'Graphics, 9 images|screenshots, illustrations, logos'],
  ];
  const headY = 78;
  groups.forEach(([key, heading], gi) => {
    const x = COL.x[gi]!;
    out.push(
      `<text x="${x}" y="${headY}" font-size="15" font-weight="600" fill="${t.text}">${esc(heading.split('|')[0]!)}<tspan dx="8" font-size="11" font-weight="400" fill="${t.muted}">${esc(heading.split('|')[1] ?? '')}</tspan></text>`,
      `<line x1="${x}" x2="${x + 348}" y1="${headY + 10}" y2="${headY + 10}" stroke="${t.grid}" stroke-width="1"/>`,
    );
    let y = headY + 36;
    for (const m of METRICS) {
      const group = rows.filter((r) => r.group === key);
      const order = [NAME, 'upng-js', 'image-q', 'libimagequant'];
      const items = order
        .map((lib) => group.find((r) => r.library === lib))
        .filter((r): r is Row => r !== undefined);
      const values = items.map(m.value);
      const max = Math.max(...values);
      const min = Math.min(...values);
      out.push(
        `<text x="${x + INDENT}" y="${y}" fill="${t.ours}" font-size="12" font-weight="600" letter-spacing="0.06em">${esc(m.title.toUpperCase())}</text>`,
        `<text x="${x + INDENT}" y="${y + 15}" fill="${t.muted}" font-size="11">${esc(m.note)}</text>`,
      );
      y += 28;
      const bx = x + INDENT + COL.names;
      // Dot plots get a range line so the differences read against a scale, not a zero.
      const lo = m.kind === 'dot' ? Math.floor(min) - 1 : 0;
      const hi = m.kind === 'dot' ? Math.ceil(max) : max;
      const scale = (v: number) => bx + ((v - lo) / (hi - lo)) * COL.bars;
      if (m.kind === 'dot') {
        for (const v of [lo, hi]) {
          out.push(
            `<line x1="${scale(v)}" x2="${scale(v)}" y1="${y - 2}" y2="${y + items.length * STEP - 6}" stroke="${t.grid}" stroke-width="1"/>`,
            `<text x="${scale(v)}" y="${y + items.length * STEP + 6}" text-anchor="middle" fill="${t.muted}" font-size="11">${v} dB</text>`,
          );
        }
      }
      items.forEach((r, i) => {
        const ours = r.library === NAME;
        const cy = y + i * STEP + BAR / 2;
        const v = m.value(r);
        const color = ours ? t.ours : t.other;
        out.push(
          `<text x="${x + INDENT}" y="${cy + 4}" fill="${ours ? t.text : t.muted}" font-weight="${ours ? 500 : 400}">${esc(DISPLAY[r.library] ?? r.library)}</text>`,
        );
        if (m.kind === 'bar') {
          const wBar = Math.max(2, scale(v) - bx);
          out.push(
            `<rect x="${bx}" y="${cy - BAR / 2}" width="${wBar.toFixed(1)}" height="${BAR}" rx="3" fill="${color}"/>`,
            `<text x="${(bx + wBar + 8).toFixed(1)}" y="${cy + 4}" fill="${ours ? t.text : t.muted}" font-size="12">${m.fmt(v)}</text>`,
          );
        } else {
          out.push(
            `<line x1="${bx}" x2="${scale(v).toFixed(1)}" y1="${cy}" y2="${cy}" stroke="${t.grid}" stroke-width="1"/>`,
            `<circle cx="${scale(v).toFixed(1)}" cy="${cy}" r="6" fill="${color}" stroke="${t.bg}" stroke-width="2"/>`,
            `<text x="${(scale(v) + 11).toFixed(1)}" y="${cy + 4}" fill="${ours ? t.text : t.muted}" font-size="12">${m.fmt(v)}</text>`,
          );
        }
      });
      y += items.length * STEP + (m.kind === 'dot' ? 34 : 22);
    }
  });
  out.push(
    `<text x="${COL.x[0]}" y="${H - 48}" fill="${t.muted}" font-size="11">Graphics PSNR is the mean over the 7 images every library encodes with a loss; 2 are lossless for ${NAME}.</text>`,
    `<text x="${COL.x[0]}" y="${H - 32}" fill="${t.muted}" font-size="11">Below 128 colors UPNG.js writes smaller photo files than ${NAME}, without dithering.</text>`,
    `<text x="${COL.x[0]}" y="${H - 16}" fill="${t.muted}" font-size="11">libimagequant runs as wasm. Full tables: bench/results.md.</text>`,
    '</svg>',
    '',
  );
  return out.join('\n');
}

const rows = parse(readFileSync(join(here, 'results.md'), 'utf8'));
for (const [scheme, theme] of Object.entries(THEMES)) {
  const file = join(here, `benchmark-${scheme}.svg`);
  writeFileSync(file, svg(rows, theme));
  console.log(`wrote ${file}`);
}

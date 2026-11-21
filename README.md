# pigmint

**Palette PNGs that stay sharp. Pure TypeScript, zero dependencies, 5 kB, no wasm.**

[![npm](https://img.shields.io/npm/v/pigmint)](https://www.npmjs.com/package/pigmint)
[![bundle size](https://img.shields.io/bundlejs/size/pigmint?label=gzip)](https://bundlejs.com/?q=pigmint)
[![dependencies](https://img.shields.io/badge/dependencies-0-success)](./package.json)
[![license](https://img.shields.io/npm/l/pigmint)](./LICENSE)
[![CI](https://github.com/konvetto/pigmint/actions/workflows/ci.yml/badge.svg)](https://github.com/konvetto/pigmint/actions/workflows/ci.yml)

pigmint turns RGBA pixels into an indexed PNG with up to 256 colours: on the benchmark photos 2.7
to 6.4 times smaller than lossless PNG, depending on the preset, and a near-lossless file for
screenshots and flat art. It runs where your pixels already
are, in the browser, in a Web Worker, in Node, Deno or Bun, from one ES module with no
dependencies: the file is compressed by the platform's `CompressionStream`, or by any zlib
compressor you pass in.

> **Try it without installing anything:** the [Compress PNG](https://konvetto.com/images/compress-png)
> tool on Konvetto runs pigmint in your browser. No upload, no account, your file never leaves the
> tab.

## Why pigmint

Measured on 14 public-domain images (photos, screenshots, illustrations, transparency) against
UPNG.js, image-q and libimagequant, all given the same pixels and the same colour count. Full
tables, method and the reproducible script are [below](#benchmarks).

- **Closest to the original at 256 colours**: on the five photos pigmint's PSNR is 0.7 dB above UPNG.js, 1.1 dB above image-q and 1.4 dB above libimagequant at 256 colours, and it is the closest of the four on 11 of 12 lossy images at 256 and on 12 of 13 at 128 colours.
- **Smallest files at 256 colours**: at 256 colours pigmint's photos are 2 percent smaller than UPNG.js and image-q and 17 percent smaller than libimagequant, with the default compressor and no hook.
- **Fast without wasm**: 1.7 to 2.7 times faster than the libimagequant wasm build and 10 to 15 times faster than image-q on photos; the fastest of the four on screenshots and illustrations at every colour count (UPNG.js is faster on photos).
- **Lossless when it can be**: an image with at most `maxColors` colours comes back pixel for
  pixel, at the smallest bit depth PNG allows (1, 2, 4 or 8 bits).
- **Deterministic**: the palette and every pixel index are the same on every run and platform.
  No random seeds, no timing, no threads. With a deterministic compressor (the `deflate` option,
  see below) the file bytes are too.
- **Small**: zero dependencies, 14 kB minified, 5.7 kB gzipped, 5.2 kB brotli. Types included,
  tree-shakeable, `sideEffects: false`.

Where it loses, honestly: below 128 colours UPNG.js writes 8 to 22 percent smaller photo files because it does not dither (with visibly lower SSIM); libimagequant has the higher SSIM on photos at every colour count; and with the default compressor flat graphics come out 3 to 4 percent larger than UPNG.js and libimagequant, which the optional fflate hook recovers. Details in [Reading it](#reading-it).

## Install

```sh
npm install pigmint
```

Node 20 or newer; any modern browser; Deno and Bun; ESM only. `quantize` returns a promise
because the default compressor, `CompressionStream`, is asynchronous. `quantizeSync` exists for
callers that pass their own synchronous compressor (see [Deflate](#deflate)).

## Usage

### Browser, from a canvas

```ts
import { quantize, presets } from 'pigmint';

const canvas = document.querySelector('canvas')!;
const { data, width, height } = canvas
  .getContext('2d')!
  .getImageData(0, 0, canvas.width, canvas.height);

const result = await quantize(data, width, height, presets.balanced);
// result.png: Uint8Array of a complete PNG file
// result.colors, result.psnr, result.quality, result.exact

const blob = new Blob([result.png], { type: 'image/png' });
```

### In a Web Worker

The call is synchronous and CPU-bound (about a second for a 12 megapixel photo on a laptop), so
run it off the main thread:

```ts
// worker.ts
import { quantize } from 'pigmint';
self.onmessage = async ({ data: { rgba, width, height, options } }) => {
  const { png, colors } = await quantize(rgba, width, height, options);
  self.postMessage({ png, colors }, [png.buffer]);
};

// main.ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ rgba: imageData.data, width, height, options: { maxColors: 128 } });
```

### Node, with a decoder

pigmint takes pixels, not files. Decode with whatever you have (sharp, pngjs, jpeg-js):

```ts
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { quantize, presets } from 'pigmint';

const { data, info } = await sharp('photo.jpg')
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { png, colors, psnr } = await quantize(
  new Uint8Array(data),
  info.width,
  info.height,
  presets.quality,
);
await writeFile('photo.png', png);
console.log(`${colors} colours, ${psnr.toFixed(1)} dB`);
```

Input is straight (not premultiplied) RGBA, 4 bytes per pixel, as `getImageData` and every
decoder give it.

### Lower-level API

```ts
import { createPalette, applyPalette, encodeIndexedPng } from 'pigmint';

const { palette, transparentIndex } = createPalette(rgba, { maxColors: 64 }); // straight RGBA bytes
const indices = applyPalette(rgba, width, height, palette, { dither: 0.5, transparentIndex });
const png = await encodeIndexedPng(width, height, palette, indices);
```

Use these to share one palette across several frames, to bring your own palette, or to write the
indices somewhere other than a PNG. `encodeIndexedPngSync` is the synchronous twin.

### Deflate

The pixel rows are compressed by `CompressionStream('deflate')` by default: zero dependencies,
but asynchronous, at the engine's default level, and the bytes differ slightly between engines.
The `deflate` option takes any function from raw bytes to a zlib stream. With
[fflate](https://github.com/101arrowz/fflate) (8 kB) at level 9 the files are 2.5 percent smaller
on the benchmark set, the bytes are the same everywhere, and the synchronous variants work:

```ts
import { zlibSync } from 'fflate';
import { quantizeSync, presets } from 'pigmint';

const deflate = (raw: Uint8Array) => zlibSync(raw, { level: 9 });
const { png } = quantizeSync(rgba, width, height, { ...presets.balanced, deflate });
```

Measured on the benchmark set at the `quality` and `tiny` presets (same palette and indices, only the compressor differs; the times are one run on a busy laptop, read them as ratios):

| Compressor                       | Total size, 28 files | Relative | Deflate time |
| -------------------------------- | -------------------: | -------: | -----------: |
| fflate level 9                   |              17.9 MB |    1.000 |       12.6 s |
| fflate level 6                   |              18.1 MB |    +1.3% |        6.6 s |
| CompressionStream (Node 26 zlib) |              18.4 MB |    +2.5% |        5.0 s |

The gap is widest on tiny flat images (a 3.6 kB icon becomes 5.1 kB) and on screenshots (+6 to
9 percent), smallest on photos (+1 to 3 percent). Konvetto passes fflate; the default is for
everyone who wants nothing else to install.

## Options

`quantize(rgba, width, height, options?)` and `createPalette(rgba, options?)`:

| Option       | Type        | Default             | What it does                                                                                                                                                                                                            |
| ------------ | ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxColors`  | 2 to 256    | 256                 | Most palette entries. A fully transparent colour, when the image needs one, counts.                                                                                                                                     |
| `minQuality` | number (dB) | off                 | Fewer colours while the fit stays above this. Measured like PSNR but against the image's own brightness range, so dark and pale images are judged fairly. 42 keeps screenshots lossless-looking; 32 is visibly reduced. |
| `dither`     | 0 to 1      | 0                   | Floyd-Steinberg error diffusion on smooth areas only (sky, skin, gradients). Edges and text are never dithered, nor is flat art or a palette that already fits above 42 dB.                                             |
| `rounds`     | integer     | 2                   | k-means rounds after median cut. 0 is plain median cut.                                                                                                                                                                 |
| `deflate`    | function    | `CompressionStream` | Raw rows in, zlib stream out. Pixels never change, only size, time and whether `quantizeSync` is available.                                                                                                             |

Presets, the strength steps used in production:

| Preset             | maxColors | minQuality | dither | Typical use                                 |
| ------------------ | --------: | ---------: | -----: | ------------------------------------------- |
| `presets.quality`  |       256 |         42 |      0 | Screenshots stay exact, photos lose little. |
| `presets.balanced` |       128 |         38 |    0.4 | The default step on Konvetto.               |
| `presets.small`    |        64 |         35 |   0.65 | Thumbnails, previews.                       |
| `presets.tiny`     |        32 |         32 |    0.6 | Icons, placeholders.                        |

The result of `quantize`:

| Field                          | Meaning                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `png`                          | The file, `Uint8Array`.                                                                                     |
| `palette`, `indices`, `colors` | Straight RGBA palette (fully transparent first, then dark to light), one index per pixel, the palette size. |
| `transparentIndex`             | The reserved fully transparent entry, or -1.                                                                |
| `psnr`                         | Standard PSNR of the palette fit, peak 255, before dithering. `Infinity` when lossless.                     |
| `quality`                      | The same fit against the image's brightness range: what `minQuality` compares with.                         |
| `exact`                        | True when every colour of the image is in the palette.                                                      |

Bad input throws `RangeError` or `TypeError` (wrong buffer length, sizes under 1 or over
2^31 - 1, options out of range).

## Benchmarks

Set: 14 public-domain and CC0 images listed in [`bench/images.json`](./bench/images.json) with
sources and licenses: three Kodak photos (0.4 MP), a 14 MP and a 7 MP photo, three screenshots,
three illustrations, two logos with transparency and one pixel-art sprite. `pnpm bench:images`
downloads them, `pnpm bench` reruns everything and writes `bench/out/results.md`.

Method: every library gets the same decoded RGBA and the same colour count; pigmint runs with the
fflate level 9 `deflate` option (Konvetto's configuration; the default compressor adds about 2.5
percent, see [Deflate](#deflate)). Each output is decoded
again with libvips and compared with the original: PSNR over premultiplied RGB (plus alpha when the
source has any), SSIM (grayscale, flattened over white), and wall time, median of 3 runs after a
warm-up, on an Apple Silicon laptop with Node 26. Lossless oxipng (level 2) is included as a size
reference only.

Contenders: UPNG.js 2.1.0, image-q 4.0.0 (wuquant palette, Floyd-Steinberg below 256 colours; it
has no PNG writer, so its pixels are written losslessly by pigmint), libimagequant through the
`imagequant` 0.1.2 wasm build (speed 4). libimagequant is GPL-3.0: it is a devDependency of the
benchmark and never part of this package.

### Summary, other libraries relative to pigmint at the same colour count

Photos (5 images, 0.4 to 14 MP). Ratios are geometric means of (library / pigmint): a size ratio above 1.00 means the other library's file is larger, a time ratio above 1.00 means it is slower. PSNR and SSIM are mean differences (library minus pigmint): below 0 means pigmint is closer to the original. The last row of each group is pigmint's own output compressed through the optional `deflate` hook with fflate level 9, shown apart from the default.

| Colours | Library                                       | Size ratio | PSNR diff (dB) | SSIM diff | Time ratio |
| ------: | --------------------------------------------- | ---------: | -------------: | --------: | ---------: |
|     256 | UPNG.js                                       |       1.02 |          -0.73 |   -0.0015 |       0.88 |
|     256 | image-q                                       |       1.02 |          -1.13 |   +0.0023 |      10.96 |
|     256 | libimagequant (wasm)                          |       1.17 |          -1.44 |   +0.0042 |       2.70 |
|     256 | pigmint with optional deflate hook (fflate 9) |       0.98 |          +0.00 |   +0.0000 |       1.38 |
|     128 | UPNG.js                                       |       0.92 |          -0.53 |   -0.0068 |       0.62 |
|     128 | image-q                                       |       1.08 |          -1.71 |   +0.0049 |      15.09 |
|     128 | libimagequant (wasm)                          |       1.10 |          -1.13 |   +0.0041 |       1.66 |
|     128 | pigmint with optional deflate hook (fflate 9) |       0.99 |          +0.00 |   +0.0000 |       1.46 |
|      64 | UPNG.js                                       |       0.82 |          -0.15 |   -0.0140 |       0.84 |
|      64 | image-q                                       |       1.00 |          -1.33 |   +0.0046 |       9.89 |
|      64 | libimagequant (wasm)                          |       1.05 |          -0.83 |   +0.0038 |       2.08 |
|      64 | pigmint with optional deflate hook (fflate 9) |       1.00 |          +0.00 |   +0.0000 |       1.55 |
|      32 | UPNG.js                                       |       0.78 |          -0.24 |   -0.0237 |       0.87 |
|      32 | image-q                                       |       0.97 |          -1.46 |   +0.0051 |      12.54 |
|      32 | libimagequant (wasm)                          |       1.06 |          -0.70 |   +0.0052 |       2.46 |
|      32 | pigmint with optional deflate hook (fflate 9) |       1.00 |          +0.00 |   +0.0000 |       1.76 |

Graphics (9 screenshots, illustrations, logos and pixel art) are a different story: at 256 colours most libraries are above 45 dB, several outputs are lossless, and the differences are in bytes, not in visible quality. There pigmint's default compressor is the weak spot (see [Deflate](#deflate)): UPNG.js and libimagequant write 3 to 4 percent smaller files on average, image-q 7 percent smaller, and the hook recovers 3 percent. Counting wins across all 14 images at the same colour count, pigmint is closer to the original (PSNR) than UPNG.js on 11 of 12 lossy cases at 256 colours and 12 of 13 at 128, than libimagequant on 11 of 12 and 13 of 13, and than image-q on every one.

### Reading it

- **At 256 colours pigmint is the most faithful of the four on photos**: 0.7 dB above UPNG.js, 1.1 dB above image-q, 1.4 dB above libimagequant, with files 2 percent smaller than UPNG.js and image-q and 17 percent smaller than libimagequant.
- **Below 128 colours UPNG.js writes smaller files** (8 percent at 128, 18 percent at 64, 22 percent at 32 on photos) because it does not dither; it pays with lower PSNR (0.2 to 0.5 dB) and clearly lower SSIM (-0.007 to -0.024, visible banding in skies and skin). Dial `dither` down to 0 if bytes matter more than banding and you get most of that back.
- **libimagequant has the best SSIM on photos at every colour count** (+0.004 to +0.005 over pigmint): its dithering covers the whole image with an adaptive strength, while pigmint dithers smooth areas only and clamps the carried error. Its PSNR is lower and its files 5 to 17 percent larger.
- **Speed**: UPNG.js is the fastest on photos (0.6 to 0.9 of pigmint's time); pigmint is 1.7 to 2.7 times faster than the libimagequant wasm build and 10 to 15 times faster than image-q. On graphics pigmint is the fastest of the four at every count (UPNG.js 2.2 to 3.4 times slower, libimagequant 1.9 to 2.8 times).
- **Lossless cases**: an image with at most 256 colours comes back pixel for pixel (`illustration-venn-diagram`, `pixelart-bird`). The file is then larger than oxipng's lossless output (151 kB against 128 kB), because oxipng tries PNG filters and a stronger deflate; pigmint writes rows unfiltered. If lossless size is the goal, run oxipng on the result.
- **Tiny files**: on a 1 MP icon with 9 colours the default compressor costs 1 kB (8.1 kB against 7.0 with the hook, 5.7 to 7.5 for the others). The hook closes that gap.

### Every image at 256 colours

| Image                        |   MP | pigmint kB |       dB |   ms | hook kB | UPNG.js kB |    dB |   ms | image-q kB |    dB |    ms | libimagequant kB |       dB |   ms | oxipng kB |
| ---------------------------- | ---: | ---------: | -------: | ---: | ------: | ---------: | ----: | ---: | ---------: | ----: | ----: | ---------------: | -------: | ---: | --------: |
| photo-kodim03-hats           |  0.4 |      141.4 |    39.24 |  133 |   139.6 |      145.5 | 38.29 |   89 |      147.5 | 38.64 |   787 |            168.3 |    38.17 |  153 |     469.4 |
| photo-kodim15-face           |  0.4 |      194.3 |    38.82 |  127 |   191.4 |      199.2 | 38.06 |   85 |      192.5 | 37.96 |   875 |            209.8 |    38.15 |  716 |     574.1 |
| photo-kodim23-parrots        |  0.4 |      143.8 |    36.31 |  180 |   142.6 |      148.8 | 35.32 |  121 |      149.1 | 35.13 |  6479 |            175.5 |    35.06 | 1231 |     534.5 |
| photo-dordogne-14mp          | 14.0 |     6196.4 |    36.05 | 2114 |  6020.3 |     6290.8 | 35.51 | 2683 |     6183.7 | 34.48 | 21998 |           7570.0 |    33.81 | 4017 |   16778.0 |
| photo-budapest-night-7mp     |  7.2 |     3170.9 |    38.47 | 1070 |  3113.0 |     3230.2 | 38.03 | 1451 |     3269.0 | 37.04 | 10981 |           3646.3 |    36.49 | 1810 |    9478.3 |
| screenshot-wikipedia-history |  1.7 |      141.8 |    54.76 |   95 |   140.8 |      142.2 | 53.94 |  154 |      139.3 | 47.63 |  2473 |            145.8 |    53.66 |  152 |     276.0 |
| screenshot-wikidata-dialog   |  3.1 |       83.3 |    64.53 |   94 |    80.2 |       84.3 | 63.83 |  242 |       78.5 | 48.24 |  4152 |             84.5 |    63.18 |  210 |     128.7 |
| screenshot-arc-browser       |  4.7 |      363.4 |    52.02 |  275 |   375.2 |      466.0 | 51.47 |  524 |      363.4 | 47.27 |  6274 |            545.4 |    50.35 |  450 |    1067.7 |
| illustration-goyave          |  2.2 |      197.6 |    51.24 |  166 |   194.1 |      198.0 | 50.73 |  161 |      194.2 | 46.39 |  3304 |            202.5 |    50.24 |  245 |     501.3 |
| illustration-village         |  2.2 |     1002.0 |    42.82 |  363 |   975.9 |     1014.1 | 42.31 |  355 |      974.3 | 41.00 |  3511 |           1020.6 |    41.73 |  599 |    2559.5 |
| illustration-venn-diagram    |  4.3 |      151.4 | lossless |   71 |   151.2 |      150.4 | 93.27 |  322 |      110.1 | 62.23 |  7131 |            142.4 | lossless |  801 |     127.5 |
| alpha-computer-icon          |  1.0 |        8.1 |    87.54 |   24 |     7.0 |        7.5 | 78.06 |  269 |        5.7 | 52.00 |  4641 |              6.2 |    69.23 |   60 |      13.6 |
| alpha-wikiindaba-logo        |  4.0 |      118.7 |    58.78 |   96 |   117.6 |      126.0 | 59.83 |  292 |      116.4 | 54.04 |  6493 |            127.0 |    59.56 |  269 |     292.8 |
| pixelart-bird                |  0.3 |        1.3 | lossless |    7 |     1.1 |        1.3 | 71.24 |   19 |        1.1 | 61.81 |   366 |              1.2 | lossless |   19 |       1.1 |

Full per-image tables for 128, 64 and 32 colours and the presets are in
[`bench/results.md`](./bench/results.md).

## How it works

1. **Histogram.** Each distinct colour is counted once, premultiplied by alpha, so the hidden
   colour of a transparent pixel never takes a palette slot. Fully transparent pixels become one
   reserved entry. Up to 8192 colours the histogram is exact; beyond that colours are bucketed at
   6 bits per channel (4 for alpha) and each bucket remembers how far its pixels spread, so the
   quality estimate stays honest.
2. **Median cut.** The box with the most weighted error is split along its widest axis at the
   weighted median, found in linear time from a 256-bin histogram rather than by sorting. Opaque
   and see-through colours start in separate boxes, so an opaque pixel never turns slightly
   transparent.
3. **k-means.** Two rounds move each palette colour to the mean of the pixels it serves. Nearest
   search is exact: it starts from the previous answer and drops a candidate as soon as its
   partial distance is already worse.
4. **Quality floor.** With `minQuality`, the palette is halved while a quick one-round palette
   still holds the floor, then narrowed between the last size that held and the first that did
   not.
5. **Remap.** Without dithering every colour is matched exactly through a direct-mapped cache.
   With dithering, Floyd-Steinberg error runs in serpentine order over smooth areas only; pixels
   next to an edge (a luma or alpha step above 18) take their nearest colour and pass nothing on,
   which keeps text crisp and files small. The carried error is clamped so colours far from every
   palette entry do not turn into worms.
6. **Write.** Palette entries no pixel uses are dropped. Entries are ordered fully transparent
   first (a short tRNS), then dark to light (neighbouring indices stay close, which helps
   deflate). Rows go unfiltered at the smallest bit depth that fits; IDAT comes from
   `CompressionStream` or your `deflate` function.

## Limits

- Palette PNG only. For photos where 256 colours are not enough, use WebP or AVIF; for lossless
  PNG, use oxipng.
- CPU-bound and single-threaded (the promise only waits for the compressor). Put it in a worker
  for anything above a megapixel.
- Memory: about 20 bytes per pixel on top of your input while it runs (the index array, the edge
  map and the row buffer for deflate), plus up to 22 MB of fixed tables on large images.
- No APNG, no 16-bit input, no colour management: pixels in, pixels out, in whatever colour
  space you gave them.
- The histogram is exact up to 8192 colours; a 20 000-colour screenshot is quantized from bucket
  means, which is why a few screenshots lose 0.1 to 0.3 dB to libimagequant at 256 colours.

## Used in production on Konvetto

pigmint is the engine behind the palette step of these free browser tools. They run the same code
you install from npm, in a Web Worker, and never upload your file:

- Compress PNG: [English](https://konvetto.com/images/compress-png),
  [Polski](https://konvetto.com/pl/obrazy/kompresja-png),
  [Deutsch](https://konvetto.com/de/bilder/png-komprimieren),
  [Español](https://konvetto.com/es/imagenes/comprimir-png),
  [Français](https://konvetto.com/fr/images/compresser-png)
- Compress image: [English](https://konvetto.com/images/compress-image),
  [Polski](https://konvetto.com/pl/obrazy/zmniejsz-rozmiar-zdjecia),
  [Deutsch](https://konvetto.com/de/bilder/bild-komprimieren),
  [Español](https://konvetto.com/es/imagenes/comprimir-imagen),
  [Français](https://konvetto.com/fr/images/compresser-image)

> **Try it free on Konvetto:** drop a PNG on [konvetto.com/images/compress-png](https://konvetto.com/images/compress-png),
> pick a strength, download. No install, no upload, runs in your browser.

## License

MIT, Copyright (c) Konvetto. See [LICENSE](./LICENSE).

No runtime dependencies. The devDependencies of the tests and the benchmark include fflate
(MIT), libimagequant through `imagequant` (GPL-3.0), UPNG.js (MIT), image-q (MIT), ssim.js (MIT),
sharp (Apache-2.0) and @jsquash/oxipng (Apache-2.0); none of them ship in the package. Benchmark images are public domain or CC0, credited in
[`bench/images.json`](./bench/images.json).

Questions and security reports: hello@konvetto.com.

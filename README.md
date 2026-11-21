# pigmint

**Palette PNGs that stay sharp. Pure TypeScript, 5 kB, no wasm, same bytes every time.**

[![npm](https://img.shields.io/npm/v/pigmint)](https://www.npmjs.com/package/pigmint)
[![bundle size](https://img.shields.io/bundlejs/size/pigmint?label=gzip)](https://bundlejs.com/?q=pigmint)
[![license](https://img.shields.io/npm/l/pigmint)](./LICENSE)
[![CI](https://github.com/konvetto/pigmint/actions/workflows/ci.yml/badge.svg)](https://github.com/konvetto/pigmint/actions/workflows/ci.yml)

pigmint turns RGBA pixels into an indexed PNG with up to 256 colours: a 3 to 5 times smaller file
for photos and a near-lossless one for screenshots and flat art. It runs where your pixels already
are, in the browser, in a Web Worker, in Node, Deno or Bun, from one ES module with a single
dependency (fflate, for deflate).

> **Try it without installing anything:** the [Compress PNG](https://konvetto.com/images/compress-png)
> tool on Konvetto runs pigmint in your browser. No upload, no account, your file never leaves the
> tab.

## Why pigmint

Measured on 14 public-domain images (photos, screenshots, illustrations, transparency) against
UPNG.js, image-q and libimagequant, all given the same pixels and the same colour count. Full
tables, method and the reproducible script are [below](#benchmarks).

- **Closest to the original at 256 colours**: BENCH_WHY_256
- **Smallest files at 256 colours**: BENCH_WHY_SIZE
- **Fast without wasm**: BENCH_WHY_TIME
- **Lossless when it can be**: an image with at most `maxColors` colours comes back pixel for
  pixel, at the smallest bit depth PNG allows (1, 2, 4 or 8 bits).
- **Deterministic**: the same input and options give the same bytes on every run and platform.
  No random seeds, no timing, no threads.
- **Small**: 13 kB minified, 5.4 kB gzipped on its own; 19.6 kB and 8.6 kB with the part of
  fflate it uses. Types included, tree-shakeable, `sideEffects: false`.

Where it loses, honestly: BENCH_WHY_LOSE

## Install

```sh
npm install pigmint
```

Node 20 or newer; any modern browser; ESM only.

## Usage

### Browser, from a canvas

```ts
import { quantize, presets } from 'pigmint';

const canvas = document.querySelector('canvas')!;
const { data, width, height } = canvas
  .getContext('2d')!
  .getImageData(0, 0, canvas.width, canvas.height);

const result = quantize(data, width, height, presets.balanced);
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
self.onmessage = ({ data: { rgba, width, height, options } }) => {
  const { png, colors } = quantize(rgba, width, height, options);
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
const { png, colors, psnr } = quantize(
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
const png = encodeIndexedPng(width, height, palette, indices);
```

Use these to share one palette across several frames, to bring your own palette, or to write the
indices somewhere other than a PNG.

## Options

`quantize(rgba, width, height, options?)` and `createPalette(rgba, options?)`:

| Option       | Type        | Default          | What it does                                                                                                                                                                                                            |
| ------------ | ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxColors`  | 2 to 256    | 256              | Most palette entries. A fully transparent colour, when the image needs one, counts.                                                                                                                                     |
| `minQuality` | number (dB) | off              | Fewer colours while the fit stays above this. Measured like PSNR but against the image's own brightness range, so dark and pale images are judged fairly. 42 keeps screenshots lossless-looking; 32 is visibly reduced. |
| `dither`     | 0 to 1      | 0                | Floyd-Steinberg error diffusion on smooth areas only (sky, skin, gradients). Edges and text are never dithered, nor is flat art or a palette that already fits above 42 dB.                                             |
| `rounds`     | integer     | 2                | k-means rounds after median cut. 0 is plain median cut.                                                                                                                                                                 |
| `level`      | 0 to 9      | 9 (6 above 4 MP) | Deflate level. Pixels never change, only size and time.                                                                                                                                                                 |

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

Method: every library gets the same decoded RGBA and the same colour count. Each output is decoded
again with libvips and compared with the original: PSNR over premultiplied RGB (plus alpha when the
source has any), SSIM (grayscale, flattened over white), and wall time, median of 3 runs after a
warm-up, on an Apple Silicon laptop with Node 26. Lossless oxipng (level 2) is included as a size
reference only.

Contenders: UPNG.js 2.1.0, image-q 4.0.0 (wuquant palette, Floyd-Steinberg below 256 colours; it
has no PNG writer, so its pixels are written losslessly by pigmint), libimagequant through the
`imagequant` 0.1.2 wasm build (speed 4). libimagequant is GPL-3.0: it is a devDependency of the
benchmark and never part of this package.

### Summary, other libraries relative to pigmint at the same colour count

BENCH_SUMMARY

### Reading it

BENCH_READING

### Every image at 256 colours

BENCH_256

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
   deflate). Rows go unfiltered at the smallest bit depth that fits; IDAT is fflate at level 9
   (6 above 4 megapixels).

## Limits

- Palette PNG only. For photos where 256 colours are not enough, use WebP or AVIF; for lossless
  PNG, use oxipng.
- Synchronous and single-threaded. Put it in a worker for anything above a megapixel.
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

The only runtime dependency is [fflate](https://github.com/101arrowz/fflate) (MIT). The
benchmark's devDependencies include libimagequant through `imagequant` (GPL-3.0), UPNG.js (MIT),
image-q (MIT), ssim.js (MIT), sharp (Apache-2.0) and @jsquash/oxipng (Apache-2.0); none of them
ship in the package. Benchmark images are public domain or CC0, credited in
[`bench/images.json`](./bench/images.json).

Questions and security reports: hello@konvetto.com.

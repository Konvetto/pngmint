# Audit of the palette PNG engine

Scope: the modules extracted from `handy-tools-2/src/engines/image/png-quant/` (histogram, median
cut and k-means, remapping with dithering, indexed PNG writer) and their caller `palette.ts`.
Method: read every module, write edge-case tests (1x1, 1xN, Nx1, all clear, partial alpha, exactly
N colours, 2 colours, grayscale ramps, noise, gradients, option bounds, wrong buffer sizes,
determinism), decode every output with two independent decoders (pngjs and libvips through
sharp), profile the hot paths on 0.4 to 14 megapixel images, and compare outputs byte for byte
with the original implementation.

Legend for "port back": **yes** means handy-tools-2 benefits now; **no** means the production
caller cannot hit it; **swap** means the simplest port is to replace the folder with this package.

## Bugs and hazards

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Effect in handy-tools-2 today                                              | Port back                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `dither` undefined was not rejected. `o.dither <= 0` is false for `undefined`, so the dithering path ran with `NaN` errors: every dithered pixel got palette index 0 of the coarse cache.                                                                                                                                                                                                                                                                                                | None: `palette.ts` always passes `dither`. A footgun for any other caller. | yes (validation)                                                |
| 2   | `rgba.length` was never checked against `width * height * 4`. The histogram walked `rgba.length`, the remap walked `width * height`: a short buffer read `undefined` as 0, a long one ignored the tail.                                                                                                                                                                                                                                                                                  | None: `ImageData` is always consistent.                                    | yes (validation)                                                |
| 3   | A 0 x 0 image reached `nearest()` with an empty palette, which recurses with `a - 1` forever (stack overflow).                                                                                                                                                                                                                                                                                                                                                                           | None: a canvas cannot produce a 0 x 0 `ImageData`.                         | yes (validation)                                                |
| 4   | k-means can strand a palette entry that no pixel maps to; the file still carried it in PLTE (and tRNS), `colors` was over-reported, and the bit depth could step up (17 entries at 8 bits instead of 16 at 4). Measured: `screenshot-wikipedia-history.png` at 256 colours wrote 256 entries, 253 used.                                                                                                                                                                                  | Slightly larger files on some images.                                      | yes                                                             |
| 5   | The quality floor (`minPsnr`) only halved the palette: 256, 128, 64, 32... A screenshot that holds 42 dB at 51 colours but not at 32 kept 64. Narrowing between the last size that held and the first that did not gives 2 to 13 percent smaller files on flat art at the same floor (`screenshot-wikidata-dialog.png`, quality preset: 32 colours, 63.3 kB, 48.2 dB became 18 colours, 54.7 kB, 43.3 dB). Photos pay nothing: when the top size itself misses the floor no search runs. | Files larger than the floor allows.                                        | yes                                                             |
| 6   | The result field `psnr` was not a PSNR: it is measured against the 1st to 99th percentile brightness range, not peak 255, so a dark image scored lower than its standard PSNR. Fine as an internal threshold, misleading in an API.                                                                                                                                                                                                                                                      | None (the field is unused).                                                | no (renamed here: `quality`, with a standard `psnr` next to it) |
| 7   | `finish()` sorted palette entries with a comparator that returned 0 for equal luma. `Array.prototype.sort` is stable, so the result was deterministic, but by accident.                                                                                                                                                                                                                                                                                                                  | None.                                                                      | no (tie-break on index added)                                   |
| 8   | `maxColors` outside 2 to 256, non-integer `rounds`, `NaN` thresholds and non-typed-array input were accepted silently.                                                                                                                                                                                                                                                                                                                                                                   | None in production.                                                        | yes (validation)                                                |

## Performance

Measured on an Apple Silicon laptop, Node 26, single run after warm-up, with the original module
and this package side by side on the same decoded pixels.

| Change                                                                                                                                                                    | Where          | Effect                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Open-addressing hash (typed arrays) instead of `Map` for exact colours; a direct 4 M-slot table for coarse buckets                                                        | `histogram.ts` | The histogram was the largest phase on photos.                                                                     |
| Direct-mapped cache keyed by the exact colour instead of a `Map` that grew to a million entries and was then emptied                                                      | `remap.ts`     | Bounded memory (at most 6 MB) and faster matching. The nearest search now starts from the previous pixel's answer. |
| Dithered pixels matched by their rounded premultiplied colour (at most half a level off) through the same kind of cache, instead of a fixed 8 MB cache of 4-level buckets | `remap.ts`     | 8 MB less per call, and the match is closer to exact.                                                              |
| Luma computed once per pixel in `edges()` instead of up to four times through a closure                                                                                   | `remap.ts`     | Less work on every dithered image.                                                                                 |
| Shift-accumulate bit packing instead of `Math.floor` and `%` per pixel                                                                                                    | `png.ts`       | Only images with 16 or fewer colours.                                                                              |

Wall time, original module vs this package, same image and options (ms, lower is better):

| Image                                 | Options                | Original | This package |
| ------------------------------------- | ---------------------- | -------- | ------------ |
| screenshot-wikipedia-history (1.7 MP) | 256 colours            | 445      | 273          |
| screenshot-wikipedia-history          | tiny preset (dithered) | 549      | 237          |
| illustration-goyave (2.3 MP)          | tiny preset            | 652      | 438          |
| alpha-wikiindaba-logo (4 MP)          | tiny preset            | 1013     | 217          |
| photo-kodim03 (0.4 MP)                | 256 colours            | 155      | 141          |

The 14 MP photo takes 2.1 s at 256 colours in the benchmark (fflate hook or default compressor alike; the time is in the histogram and the remap), against about 2.7 s measured for the original module under the same conditions.

Output bytes differ slightly from the original in two cases, both intended: pruned palette entries
(finding 4) and the narrower quality floor (finding 5). Ties in nearest-colour search can also
resolve differently because the search now starts from the previous answer; the chosen colour is at
the same distance, so quality is unchanged. Outputs are byte-identical where none of this applies
(`alpha-computer-icon.png` at every setting, several others at 64 and 256 colours).

## Dropping fflate

Asked for: zero runtime dependencies. Measured on the 14 benchmark images at the `quality` and
`tiny` presets (28 files), same palette and indices, only the compressor differs:

| Compressor                               | Total bytes | Relative |   Time |
| ---------------------------------------- | ----------: | -------: | -----: |
| fflate level 9 (the original engine)     | 17 920.6 kB |    1.000 | 12.6 s |
| fflate level 6 (the original above 4 MP) | 18 144.8 kB |    +1.3% |  6.6 s |
| `CompressionStream('deflate')`, Node 26  | 18 362.3 kB |    +2.5% |  5.0 s |

Per image the native stream costs +1 to +3 percent on photos, +6 to +9 percent on screenshots and
up to +45 percent on a 3.6 kB icon (1.5 kB more). It is as fast as fflate at level 6 and its bytes
depend on the engine's zlib, so file bytes are no longer identical across platforms (palette and
indices still are). Decision: the package ships with zero dependencies and the native stream as the
default, and a `deflate` option takes any zlib compressor. Konvetto already ships fflate and passes
`(raw) => zlibSync(raw, { level: 9 })`, which gives exactly the previous files and keeps the
synchronous call (`quantizeSync`). The benchmark tables measure that configuration.

## Things checked and found correct

- Exactly N colours with N at most `maxColors` (and no quality floor) come back pixel for pixel,
  at the smallest bit depth PNG allows (1, 2, 4, 8). Verified for 2, 3, 4, 5, 16, 17, 255, 256.
- Fully transparent pixels never leak their hidden colour into the palette, always take the
  reserved entry and pass no dithering error on.
- An opaque pixel never takes a see-through palette colour; a semi-transparent pixel is matched
  premultiplied, so a half-transparent colour comes back exactly.
- Chunk order, lengths and CRCs; tRNS only as long as the last see-through entry; IHDR fields;
  pngjs with `checkCRC` and libvips both decode every test file to the same pixels.
- Determinism: same input and options give the same bytes, from `Uint8Array` or
  `Uint8ClampedArray`.
- 1 x 1, 1 x N and N x 1 images, with and without dithering, do not read outside their rows.
- Deflate level changes size only, never pixels.

## Not changed, worth knowing

- The histogram is exact up to 8192 colours and bucketed (6 bits per colour channel, 4 for alpha)
  beyond. A 17 000-colour screenshot is therefore quantized from bucket means; its palette is
  still exact per pixel in the remap. Raising the limit costs time on photos.
- Dithering is Floyd-Steinberg restricted to smooth areas with the carried error clamped at 24
  per channel. libimagequant dithers everywhere with an adaptive strength and scores higher on
  SSIM at the same colour count (see the benchmark); its files are usually larger.
- The quality floor is checked with a one-round palette; the final palette with two rounds lands
  about 0.3 dB above it. Narrowing keeps the margin.
- Rows are written unfiltered. PNG filters helped by under 1 percent on palette indices in our
  tests and hurt on posters; an adaptive filter pass would add time for little.

## What to port to handy-tools-2

The simplest port is to depend on this package and delete the folder: `quantizePng(rgba, w, h,
{ maxColors, minPsnr, dither })` becomes `quantize(rgba, w, h, { maxColors, minQuality, dither })`
and `.png` stays `.png`. The strength steps in `palette.ts` are `presets.quality`,
`presets.balanced`, `presets.small` and `presets.tiny` here, unchanged. Expect the same or smaller
files (findings 4 and 5) and faster runs.

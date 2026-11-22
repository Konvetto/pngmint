# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0](https://github.com/Konvetto/pngmint/compare/v1.0.0...v1.1.0) (2026-11-22)


### Features

* add the filter option with libpng's adaptive row filter, off by default ([e1c9ee2](https://github.com/Konvetto/pngmint/commit/e1c9ee269bf6422b6530b9b1ca1343016f4ce3aa))

## [1.0.0](https://github.com/Konvetto/pngmint/compare/v0.1.0...v1.0.0) (2026-11-21)


### Miscellaneous Chores

* release 1.0.0 ([a097f03](https://github.com/Konvetto/pngmint/commit/a097f03e5dca2d89b05aa2d3ee2d437963afc2b3))

## [0.1.0]

First public release, extracted from the Compress PNG engine of konvetto.com.

### Added

- `quantize(rgba, width, height, options)`: straight RGBA in, indexed PNG out, with the palette,
  the indices and the measured fit (`psnr`, `quality`, `exact`). Compression by the platform's
  `CompressionStream` (no dependencies) or by the `deflate` option; `quantizeSync` for a
  synchronous compressor such as fflate.
- `createPalette`, `applyPalette`, `encodeIndexedPng` and `encodeIndexedPngSync` for custom
  pipelines.
- `presets.quality`, `presets.balanced`, `presets.small` and `presets.tiny`, the strength steps
  used in production.
- Exact histogram up to 8192 colours, bucketed beyond; median cut with a linear weighted median;
  k-means refinement; exact nearest-colour search with pruning; Floyd-Steinberg dithering on smooth
  areas only; indexed PNG writer with 1, 2, 4 or 8 bits per pixel and a short tRNS.
- Input validation with `RangeError` and `TypeError`.
- Palette entries no pixel uses are dropped from the file.

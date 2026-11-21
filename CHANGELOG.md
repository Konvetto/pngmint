# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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

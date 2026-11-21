# Contributing

Thanks for helping. Bug reports with a reproducible image are the most useful thing you can send.

## Setup

```sh
pnpm install
pnpm test          # Vitest
pnpm check         # types, lint, tests, build, publint, attw, size
pnpm bench:images  # downloads the CC0 benchmark set into bench/images
pnpm bench         # writes bench/out/results.md
```

Node 20 or newer and pnpm (see `packageManager` in package.json).

## Rules of the house

- Every change to the quantizer needs a test or a benchmark number. Quality claims come from
  `pnpm bench`, not from looking at one image.
- Output must stay deterministic: the same input and options give the same bytes on every run and
  platform. No `Math.random`, no time, no locale.
- No runtime dependencies. fflate stays a devDependency for tests and the benchmark; the
  `deflate` option is how callers bring it in.
- No wasm, no Node-only APIs in `src/`. The package runs in browsers, Web Workers, Node, Deno and
  Bun from the same ESM file.
- Keep the public API small. New options need a reason that a preset cannot cover.
- Commits in English, imperative mood, one change per commit.

## Pull requests

CI runs lint, types, tests on Node 20, 22 and 24, publint, arethetypeswrong and size-limit. Add a
line to CHANGELOG.md under Unreleased.

## Benchmark images

All files in `bench/images.json` are public domain or CC0. If you add one, link its source page and
license in the manifest. Do not commit the images themselves.

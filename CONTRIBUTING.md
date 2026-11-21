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

CI runs lint, types, tests on Node 20, 22 and 24, publint, arethetypeswrong and size-limit.
Use a Conventional Commit title for the PR (it becomes the squash commit): do not edit
CHANGELOG.md by hand, the release PR generates it.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` a new feature (minor bump)
- `fix: ...` a bug fix (patch bump)
- `docs: ...`, `chore: ...`, `test: ...`, `refactor: ...`, `perf: ...` no release by themselves
  (`perf` and `fix` show in the changelog)
- `feat!: ...` or a `BREAKING CHANGE:` footer: breaking change (while on 0.x this bumps minor)

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Every push to `main` updates one open "chore(main): release x.y.z" PR with the version bump in
   package.json and the new CHANGELOG.md section.
2. A maintainer merges that PR when ready to ship. This creates the tag `vX.Y.Z` and the GitHub
   release.
3. The publish job in `.github/workflows/release.yml` then runs `pnpm check` and
   `npm publish --provenance --access public` (npm trusted publishing, environment `npm`). A
   version already on npm is skipped.

To force a version (for example 1.0.0), push an empty commit to `main` with the footer:

```sh
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
```

## Benchmark images

All files in `bench/images.json` are public domain or CC0. If you add one, link its source page and
license in the manifest. Do not commit the images themselves.

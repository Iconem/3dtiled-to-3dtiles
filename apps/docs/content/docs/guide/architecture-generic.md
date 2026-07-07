---
title: "Architecture: Generic"
description: "Monorepo layout, Parallelism model, browser readiness"
---

# Architecture — 3dtiled-to-3dtiles monorepo

## Goals
1. **Modular** — each input format is an independent converter with its own dependencies, releasable
   on its own, installable à la carte.
2. **One meta-converter** — a single entry point (CLI + JS/TS API) that detects any supported input
   and dispatches to the right converter, producing 3D Tiles.
3. **Shared core** — the common machinery (SPZ-v2 splat GLB encoder, POINTS GLB encoder, tileset/HLOD
   tree + geometricError/bounds helpers, parallelism) lives in one place, used by all converters.
4. **Parallel** — per-tile encoding fanned across cores (the work is independent per tile).
5. **Runtime-honest** — document which converters are pure-Node vs browser-capable and why.

## Monorepo layout (npm workspaces)

```
package.json                     # root: { "workspaces": ["packages/*"] }, dev scripts
packages/
  core/        3dtiles-convert-core   — shared, dependency-light (gltf-transform + Node stdlib)
    spz-glb.js      SPZ-v2 buffer + KHR_gaussian_splatting(+_spz_2) GLB  (async gzip)
    points-glb.js   glTF POINTS GLB (point clouds)
    parallel.js     parallelMap (bounded concurrency) + WorkerPool (worker_threads)
    detect.js       sniff a path → format id (rad|sog|lcc|copc|potree|i3s)
    index.js        re-exports
  convert/     3dtiles-convert  (the meta-converter) → deps: core + dispatches to all converters
    index.js   convert(input, outDir, opts): detect → dispatch
    cli.js     `3dtiled <input> <out> [--format] [--scale N] [--ge-scale …] [-- extra]`

  rad-to-3dtiles/    → dep: @sparkjsdev/spark
  sog-to-3dtiles/    → dep: @playcanvas/splat-transform  (webp.wasm)
  lcc-to-3dtiles/    → no heavy dep (binary parsing); imports core + parallelMap
  copc-to-3dtiles/   → dep: copc, laz-perf, proj4 (+ plain LAS/LAZ)
  potree-to-3dtiles/ → dep: copc (laz-perf); validated 2.0 BROTLI + 1.x v1.7/v1.4 + tiled LAZ
  i3s-to-3dtiles/    → dep: copc — draft (NYC mesh works)
```

Naming: per-format converters keep the descriptive **`<fmt>-to-3dtiles`** convention (not scoped
`@scope/<fmt>`); shared packages are the unscoped `3dtiles-convert-core` / `3dtiles-convert`. Each
per-format converter depends only on `3dtiles-convert-core` + its format libs, so installing one
pulls only its deps. `3dtiles-convert` is the batteries-included meta-CLI. **All converters now live
under `packages/`** (workspace members); the meta-converter dispatches to each via child process
(`packages/<fmt>-to-3dtiles/src/index.js`) — the remaining step is exporting a uniform in-process
`convert()` from each so the registry can `import` instead of `spawn`.

## Uniform converter interface

Every converter exports the same shape so `convert` can treat them identically:

```ts
export interface Converter {
  id: string;                                  // "rad" | "sog" | …
  detect(path: string): Promise<boolean>;      // cheap sniff (magic bytes / index filename)
  convert(input: string, outDir: string, opts: ConvertOptions): Promise<ConvertResult>;
}
export interface ConvertOptions {
  concurrency?: number;        // tile-encode parallelism (default: cores−1)
  geScale?: number; geLayer?: number;
  signal?: AbortSignal; onProgress?: (done, total) => void;
  // …format-specific opts pass through
}
export interface ConvertResult { tiles: number; splats?: number; levels?: number; outDir: string; }
```

`convert(input, …)` flow: `detect` each registered converter in priority order → first match runs;
`--format` overrides detection. Same logic backs the CLI and the JS/TS API.

## Parallelism model

Per-tile work (decode → SPZ/GLB encode → gzip → write) is **independent per tile** → embarrassingly
parallel. Two tiers, both in `core/parallel.js`:

1. **Async-gzip + bounded concurrency (default, low-risk).** Replace `zlib.gzipSync` with the async
   `zlib.gzip` — it runs on the **libuv threadpool** (off the main thread; size via `UV_THREADPOOL_SIZE`).
   Drive tiles through `parallelMap(items, fn, {concurrency})` (N promises in flight). This parallelises
   the gzip (usually the CPU bottleneck) and file I/O with no worker_threads complexity. JS decode stays
   on the main thread.
2. **WorkerPool (decode-heavy formats).** A `worker_threads` pool for formats where *decode* dominates
   (SOG WebP, COPC LAZ): the worker does decode+encode+write given a tile descriptor (chunk bytes +
   range), transferring typed arrays. Full multi-core scaling; higher setup cost.

Converters call `parallelMap` over their tile list; memory stays bounded (decode one chunk → fan its
runs → release), matching today's per-chunk streaming.

## Browser readiness (why the README column)

| Gate | Node today | Browser path |
|------|-----------|--------------|
| File I/O | `fs` | `fs-io.js` abstraction → fetch/File/OPFS |
| gzip (SPZ) | `zlib.gzip` | `CompressionStream('gzip')` (widely supported) |
| brotli (Potree 2.0) | `zlib.brotli*` | needs a WASM brotli (no standard API) |
| parallelism | `worker_threads` | Web Workers (same task shape) |
| WebP decode (SOG) | `webp.wasm` (splat-transform) | already WASM → browser-native |
| LAZ decode (COPC) | `laz-perf` WASM | already WASM → browser-native |

So **decoders are mostly browser-capable** (the heavy ones are already WASM); the Node-only bits are
the *I/O + compression + worker* shims, which `core` abstracts. See the README "Runtime" column for the
per-converter verdict.

## Migration plan (incremental, non-breaking)
1. Stand up `packages/core` (canonical `spz-glb` with async gzip + `parallel` + `detect`) — **done**.
2. `packages/convert` meta-CLI dispatching to converters — **done** (dispatch shims today).
3. Move each `*-to-3dtiles/` → `packages/<fmt>-to-3dtiles/`, repoint its encoder import to
   `3dtiles-convert-core`, and switch its tile loop to `parallelMap`. **DONE** — all six converters
   now live under `packages/` (workspace members), import core, and run `parallelMap`.
4. Delete the per-converter duplicated `spzGlb.js` once all import core. **DONE** (lcc/sog deleted; rad
   uses core directly).
5. Export a uniform in-process `convert(input, outDir, opts)` from each converter so the meta-converter
   `import`s the module instead of `spawn`-ing the CLI. **DONE** — every converter exports `convert()`
   + a `fileURLToPath`-guarded CLI shim; the registry dispatches in-process by default (verified: 0 child
   processes), falling back to `spawn` only when `opts.extraArgs` (format-specific CLI flags) are passed.

# Changelog

All notable changes to **3dtiled-to-3dtiles** are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added — converters
- **sog-to-3dtiles** — PlayCanvas Streamed SOG → 3D Tiles. Walks the binary spatial tree
  (interior = grouping, leaf = REPLACE LOD chain); decodes each chunk via
  `@playcanvas/splat-transform`'s `readSog` (CPU `webp.wasm`, no GPU) into a `DataTable`,
  re-encodes to SPZ-v2 GLB. Validated on `example_skatepark_02` (2,054 tiles) and
  `example_roman_parish_02` (37,725 tiles). Memory-bounded (decode chunk → write → release).
  `scripts/fetch-sog.mjs` downloads a full streamed-SOG dataset.
- **lcc-to-3dtiles** — XGRIDS LCC → 3D Tiles. Reverse-engineered the uncompressed 32-B/splat
  `Data.bin` layout (pos f32×3 · color rgba8 (a=opacity) · rot u32 10-10-10-2 · scale u16×3),
  parses `meta.lcc` + `Index.bin` (Unit grid × LODs). Validated on `Guan_Temple`
  (154 tiles, 11,424,293 splats = `totalSplats`). Rotation matches the LCC-Web-SDK `QUAT_TAB`.
  Scale decode under active refinement (geometric vs. v5 codebook-LUT). SH not yet emitted.
- **i3s-to-3dtiles** — 🟡 draft (UNTESTED, no SLPK sample): node-tree → tileset, OBB→box,
  `DefaultGeometrySchema` mesh / PointCloud → glTF. Draco/textures/attributes/legacy index gated out.
- **potree-to-3dtiles** — 🟡 Potree octree point cloud → 3D Tiles glTF POINTS. Auto-detects 2.0
  (`metadata.json`/`hierarchy.bin`/`octree.bin`, incl. BROTLI) and 1.x (`cloud.js`/`.hrc`/`.bin`).
  Octree→tree, `refine: ADD`, GE = spacing/2^depth. 2.0 decode validated on a synthetic dataset
  (positions + RGB exact); 1.x best-effort; both untested on real data; output not geo-referenced.

### Fixed — rad-to-3dtiles (the "spiky render" saga)
- **SPZ v2, not v3** — `KHR_gaussian_splatting_compression_spz_2` is locked to SPZ v2 (3-byte
  "first-three" rotations). Emitting v3 mis-strided the rotation block in CesiumJS's decoder.
- **RAD column byte-layout** (the root cause, confirmed from SparkJS Rust `rad.rs` encoders):
  `f16`/`oct88r8` are **interleaved**, `ln_0r8`/`r8_delta` **planar**, `f32_lebytes` byte-transposed.
  Reading alpha & orientation as planar corrupted opacity + rotation (positions stayed correct, so
  the shape showed through the noise). Fixed; scales correctly reverted to planar.
- **`lodOpacity`** — RAD encoding params live under `meta.splatEncoding` (not `meta.encoding`);
  the missed `lodOpacity: true` meant opacity wasn't doubled. Cross-validated vs William's PLY
  pipeline: keep `α×1` (`--alpha-scale` flag added for A/B).
- **geometricError** — uniform-per-depth, anchored to a featureSize/spatial proxy with natural
  halving (`--ge-scale` / `--ge-layer`, default 1; an earlier ×16/×8 hack over-refined everything).
- **Bounding volumes** — emitted in the Z-up tileset frame (`RX+90°`), nested bottom-up
  (parent ⊇ children); root `RX(180°)` transform corrects the inverted-up artifact.
- Noise filtering made **opt-in** (`--opacity-filter`, `--max-scale-mult`, default off) — SparkJS
  renders the RAD without discarding splats, so we don't either by default.
- Processing-time estimate + actual-time logging.

### Added — viewer (`viewer.html`)
- Renderer toggle (CesiumJS / 3DTilesRendererJS-via-SparkJS); preset pills for every sample
  (RAD, SOG, LCC, COPC, PLY-comparison, alpha variants).
- SparkJS render settings on the 3DGS plugin (`maxStdDev=√8`, `blurAmount=0.3`); reaches the shared
  SparkRenderer to set `lodInflate`/`lodSplatScale`. 🪲 Debug tiles (boxes coloured by depth, dimmed).
  Max-SSE and FOV inputs; orbit/globe/env controls; Google-hybrid basemap default.

### Added — tooling & docs
- `tools-inspector/` (WilliamLiu 3DTiles-Inspector) with `npm run inspect:*` scripts.
- Local **build-lod** build recipe (rustup GNU + `rust-mingw` + `--no-default-features`) for the
  PLY→RAD→3DTiles comparison vs `3dgs-ply-3dtiles-converter`.
- `docs-references/`: `spz-format`, `KHR_gaussian_splatting(+_spz_2)`, `sog`, `streamed-sog`,
  `lcc-format`, `i3s-spec`, `nexus-format`, plus a top-of-README format-comparison table +
  per-format Mermaid diagrams.

### Known limitations
- **Spherical harmonics** not yet emitted (DC only) on any path — the largest remaining fidelity gap.
- LCC scale decode (v3 geometric vs v5 codebook) and SH still being finalised.
- Tile conversion is **single-threaded / sequential** (see README "Performance"); a worker pool is the
  obvious next optimization.

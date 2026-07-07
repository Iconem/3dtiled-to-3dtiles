---
title: "Documentation"
description: "3D Tiles 1.1 — OGC standard for streaming massive 3D geospatial datasets. A tileset consists"
---

### Formats

**3D Tiles 1.1** — OGC standard for streaming massive 3D geospatial datasets. A tileset consists
of a `tileset.json` describing a spatial hierarchy of tiles, each referencing a GLB/B3DM/PNTS
payload. Version 1.1 adds implicit tiling (OCTREE/QUADTREE subdivision schemes with binary
subtree files), metadata schemas, and new glTF extensions including `KHR_gaussian_splatting`.
Tiles can carry a `transform` (column-major 4×4) to place them in any coordinate system —
ECEF (EPSG:4978) is conventional for globe viewers but not required.

**COPC (Cloud Optimized Point Cloud)** — A LAZ 1.4 file with a specific VLR/EVLR layout that
embeds an octree hierarchy. Each octree node is a contiguous chunk at a known offset, enabling
HTTP range requests without a separate index. Internally organized in the same way as 3D Tiles
implicit tiling — a direct 1:1 mapping. CRS is stored as WKT in a VLR (LASF_Projection record
2112). Not all files include it (e.g. the Autzen test file does not), in which case the output
is in local dataset coordinates.

**RAD (SparkJS Gaussian Splat LoD)** — SparkJS binary streaming format for BhattLod Gaussian
splat scenes. See structure in the [rad-to-3dtiles](/docs/guide/cli-usage#rad-to-3dtiles) section of CLI usage.

### RAD: PackedSplats or ExtSplats?

The `.RAD` format is **receiver-agnostic**: the same `.rad` file can be decoded into either
`PackedSplats` (16 B/splat) or `ExtSplats` (32 B/splat, Spark 2.0 preview) depending on which
class you instantiate in JavaScript.

**BhattLod `.rad` files** (like `coit-40m-sh1-lod.rad`) use per-property encodings chosen for
compression quality. The actual in-memory format is chosen at runtime:

```js
// Decode into PackedSplats (16B/splat, float16 center)
const packed = new PackedSplats({ url: 'coit.rad', lod: true });

// Decode into ExtSplats (32B/splat, float32 center — Spark 2.0 preview)
const ext = new ExtSplats({ url: 'coit.rad', lod: true });
```

The RAD storage encodings for `coit.rad` are:
- `center: f32_lebytes` — byte-plane encoded float32 (higher precision than PackedSplats f16)
- `alpha: f16` — float16 opacity (matches ExtSplats)
- `scales: ln_0r8` — uint8 log scale (matches PackedSplats range)
- `rgb: r8_delta` — delta-encoded uint8 (matches PackedSplats)
- `orientation: oct88r8` — shared by both formats

See [`sparkjs-packed-splats.md`](/docs/references/sparkjs-packed-splats) and
[`sparkjs-ext-splats.md`](/docs/references/sparkjs-ext-splats) for full layout specs.

### REPLACE vs ADD refinement

3D Tiles tilesets declare how children relate to their parent via the `refine` field:

- **`REPLACE`** — when a child tile loads, the parent is discarded. Each level of detail fully
  replaces the previous. Used by photogrammetry meshes (b3dm), Gaussian splat LoDs (RAD), and
  most point cloud viewers. Visual quality improves as finer tiles load; no double-drawing.

- **`ADD`** — children are *added on top of* the parent; the parent is never hidden. Each level
  independently contributes content. Used by COPC point clouds because every node holds a
  disjoint subset of points — hiding the parent would lose points that are only in that node.
  The total visible point count grows as finer tiles load.

Viewers must implement both correctly. A REPLACE tileset rendered as ADD would show every LoD
layer simultaneously (ghosting / double-draw). An ADD tileset rendered as REPLACE would hide
coarser nodes that contain unique points.

### RAD LoD: geometric error, bounding volumes & coordinates

How `rad-to-3dtiles` builds a tile hierarchy that selects levels correctly in both
CesiumJS and 3DTilesRendererJS:

- **Geometric error = uniform per depth, anchored to a rendering-error proxy — then scaled to
  match renderer expectations.** *(This describes the original **`--ge-basis=featuresize`** approach,
  kept below for the design rationale. The undershoot noted at the end of this bullet is why the
  **default basis is now `spatial`** — `bboxDiag/∛splatCount` — instead; `featuresize` is opt-in
  legacy. See the RAD `geometricError` note in the
  [Design log](/docs/guide/streaming-architecture-design-log).)* Each tile records a feature size =
  `mean over splats of max(scaleₓ,scaleᵧ,scale_z) × 3` (≈ SparkJS BhattLod `featureSize`),
  then the builder collapses these to **one error per LoD level** (mean featureSize at each depth,
  forced strictly decreasing). This mirrors the
  [3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
  model where all siblings at a level share one error so they **refine together**. Per-*node*
  errors vary within a level and make siblings pop in/out at different distances. Uniform per-depth
  fixes that.

  Two optional modifiers (both **default 1**, mirroring the
  [3DTiles-Inspector](https://github.com/WilliamLiu-1997/3DTiles-Inspector) sliders and the
  reference converter's `errorTargetLayerMultiplier`) can tune this:

  1. **Layer multiplier** (`--ge-layer`, default `1`): stretches the per-depth range —
     `GE(d) = leafGE + (GE(d) − leafGE) × geLayer`. `1` = natural halving, which is what the
     reference uses and what makes sibling levels refine together.
  2. **Global GE scale** (`--ge-scale`, default `1`): multiplies all GE values by a constant.

  **These default to 1** because the raw featureSize GE is already the right magnitude: Coit's root
  GE is ≈ 1.1, matching the [3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter)
  reference's ≈ 2.07 for a comparable scene (verified by fetching its `tiling/geometric-error.js` and
  a rendered reference tileset). An earlier attempt set these to `16`/`8` — that over-inflated GE so
  every tile's SSE always exceeded the threshold, forcing **full-detail-everywhere refinement
  regardless of camera distance** (high-res tiles loading away from the camera focus, the whole scene
  rendering as dense spikes). That was a mis-calibration compensating for the half-opacity `lodOpacity`
  bug; with opacity fixed, raw GE is correct. If a scene under-refines, nudge `--ge-scale=2` (the
  reference sits ~2× our magnitude); values like `16` are far too high.
- **Bounding volumes are emitted in the Z-up tileset frame.** Bounds are computed from the glTF
  (Y-up) splat positions, but a 3D Tiles tile's `boundingVolume` lives in the tileset frame, which
  is Z-up — both CesiumJS and 3DTilesRendererJS rotate glTF content by `RX(+90°)` → `(x,y,z) →
  (x,−z,y)`. Emitting the box in the raw Y-up frame makes the boxes appear **rotated ~90° off the
  rendered splats** (the splats stand upright, the boxes lie down). The builder now rotates every
  box into Z-up (`yUpBoxToZUp`), so box centres coincide with the rendered splat centres. (The COPC
  writer already bakes this convention into its per-point swap; this brings the RAD path in line.)
- **Bounding volumes are nested bottom-up.** RAD's ~1.5-fanout octree plus the fact that splats
  are *shapes* (a merged parent splat can be smaller than a child covering spatial outliers)
  means per-node AABBs do **not** contain their children on their own. The builder expands each
  node's box to enclose all descendant boxes (`parent ⊇ children`), which both renderers require
  for correct frustum culling and screen-space-error refinement. (Before this fix, 56% of Coit
  parent→child pairs were non-nested, with children up to 14× larger than their parent.)
- **Root node RX(180°) transform corrects the inverted-up artifact.** After the glTF→tileset
  `RX(+90°)` that both renderers apply to GLB content, RAD splats appeared upside-down. A
  `root.transform = diag(1,−1,−1,1)` (column-major RX 180°) is written into the root tile only —
  children inherit it automatically per the 3D Tiles spec, so no intermediate or leaf nodes carry
  a transform. This is the correct place: intermediate/leaf transforms would fight the inherited
  value on each child's rendered position.
- **Native RAD coordinates, no global-centroid subtraction.** Splats keep their raw RAD frame —
  subtracting a float offset before int24 quantisation buys nothing (RAD scenes already sit near
  the origin) and only adds a lossy step. RAD has no per-node transforms, so all tiles share one
  frame; the single root transform above is sufficient to orient the content correctly.
- **`lodOpacity` must be applied — the cause of the "thin/spiky" artifact.** RAD stores its
  quantisation ranges and flags under `meta.splatEncoding` (per-chunk, mirrored from the root
  header), **not** `meta.encoding`. Reading the wrong key silently fell back to defaults, missing
  `lodOpacity: true`. SparkJS's `unpackSplat` does `opacity = stored/255; if (lodOpacity) opacity ×= 2`
  — i.e. RAD LoD files store **half** the real opacity. Without the ×2 every splat rendered at half
  opacity, so the large coarse splats could not blend and the sharp needle splats (scale anisotropy
  reaches 100–1000× on merged LoD representatives — legitimately needle-shaped) showed through as
  spikes. Sourcing `lnScaleMin/Max`/`lodOpacity` from `splatEncoding` fixes it (and is robust for RAD
  files whose ranges differ from the `−12…9` default). Note: the SPZ encoding itself was verified
  **byte-identical** to SparkJS's `SpzWriter` (positions int24/4096, alpha ×255, rgb via `SH_C0/0.15`,
  scales `(ln s + 10)×16`, v2 first-three rotations) — the bug was purely the missed opacity doubling
  in the RAD decode, not the SPZ storage.

Toggle **🪲 Debug tiles** in `viewer.html` to draw the tile bounding volumes coloured by octree
depth — CesiumJS via `debugShowBoundingVolume`/`debugColorizeTiles`, 3DTRJS via `DebugTilesPlugin`
(`displayBoxBounds` + `colorMode: DEPTH`). Useful for eyeballing nesting and LoD selection.

### Open 3D Tiles Datasets

Cesium and partner organizations publish open 3D Tiles datasets:

**CesiumGS open data (Ion)** — https://cesium.com/platform/cesium-ion/content/
- Assets marked "open data" are publicly accessible with any Ion account token.
- Examples: Google Photorealistic 3D Tiles (assetId 2275207), Bing Imagery basemap.

**More public 3D Tiles / 3DGS / OSM-3D endpoints** — see the curated list in
[blosm#498](https://github.com/vvoovv/blosm/issues/498) (3D Tiles + Gaussian-splat + city-model sources).

**CesiumGS 3d-tiles-samples** (raw GitHub, CORS-friendly, verified 200) — handy for testing:
- `https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.1/SparseImplicitQuadtree/tileset.json` (mesh, implicit 1.1)
- `https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithRequestVolume/tileset.json` (mesh + point cloud)

**Strasbourg Od@CiT** — 3D Tiles 1.0, explicit tiling, **REPLACE**, b3dm photogrammetry mesh
```
https://s3.eu-west-2.wasabisys.com/ems-sgct-photomaillage/ODACIT/EMS_PM2022/tileset.json
```

**Clermont-Ferrand (CRAIG)** — 3D Tiles 1.0, explicit, **REPLACE**, b3dm
```
https://3d.craig.fr/datasets/Clermont/3dtiles/tileset.json
```

**Lille Métropole** — 3D Tiles 1.0, explicit, **REPLACE**, b3dm
```
https://webimaging.lillemetropole.fr/externe/maillage/2016_mel_10cm/3dtiles/tileset.json
```

All three city mesh tilesets use RGF93/Lambert-93 or WGS84 coordinates and are served with CORS.
They work in `viewer.html` via the built-in city mesh presets.

**Esri I3S samples (for `i3s-to-3dtiles`)** — [loaders.gl I3S test data](https://github.com/visgl/loaders.gl/tree/master/modules/i3s/test/data)
has both `.slpk` packages and **raw REST/file-server layouts** (`3dSceneLayer.json` + `nodepages/` + `nodes/`
trees on disk — the converter reads those directly, no unzip). Mix of `3DObject`/`IntegratedMesh` (mesh),
`PointCloud`, and Draco-compressed layers (Draco/LEPCC are gated out). Local samples live in
`sample-data/input/I3S-SLPK/` (NYC buildings mesh ✓, Autzen point cloud → LEPCC, gated).

### References

#### Local notes (in `docs-references/`)

| File | Description |
|------|-------------|
| `spark-2.0-blog-post.md` | Spark 2.0 technical deep dive (LoD, streaming, RAD format, PackedSplats vs ExtSplats) |
| `sparkjs-packed-splats.md` | SparkJS PackedSplats API + 16-byte layout |
| `sparkjs-ext-splats.md` | SparkJS ExtSplats API + 32-byte layout (Spark 2.0 preview) |
| `KHR_gaussian_splatting.md` | KHR_gaussian_splatting glTF extension spec (RC), plus the `KHR_gaussian_splatting_compression_spz_2` SPZ-compression child extension (Draft) as a subsection |
| `spz-format.md` | SPZ v2/v3 binary format — per-field encoding, pack/unpack formulas (source: github.com/nianticlabs/spz) |
| `sog.md` | SOG (Spatially Ordered Gaussians) chunk format — WebP textures + dequant (positions/quats/scales/SH); consumed by `sog-to-3dtiles` (source: developer.playcanvas.com) |
| `streamed-sog.md` | PlayCanvas Streamed SOG LOD format — `lod-meta.json` spatial tree + chunk references; the input to `sog-to-3dtiles` (source: developer.playcanvas.com) |
| `lcc-format.md` | XGRIDS LCC (Lixel CyberColor) — `meta.lcc`/`Index.bin`/`Data.bin` (32 B/splat, 10-10-10-2 rot, packed-11 SH); input to `lcc-to-3dtiles` (source: github.com/xgrids/LCCWhitepaper). Attribution required. |
| `potree-format.md` | Potree 1.x (`cloud.js` + `.hrc`/`.bin`/`.laz`) and 2.0 (binary octree) — input to `potree-to-3dtiles`. Key: 1.x decode is `POSITION·scale + the NODE's box.min` (node-relative), with the `createChildAABB` octant convention bit0→Z/bit1→Y/bit2→X. cloud.js can carry a proj4 CRS. Sources: potree repo `docs/` (pinned commits). |
| `nexus-format.md` | 🟠 CNR-ISTI Nexus multiresolution mesh (DAG of patches) — **doc-referenced, no converter** (mesh, not splats; niche). Refs: github.com/cnr-isti-vclab/nexus, FastDec paper |
| `i3s-spec.md` | 🟡 Esri I3S (Indexed 3D Scene Layer / SLPK) — **draft converter `i3s-to-3dtiles/`** (validated on `Buildings_NewYork_v18.slpk` → 5882 tiles, see below): explicit nodepages + uncompressed `DefaultGeometrySchema` mesh / point cloud only. Ref: github.com/esri/i3s-spec |
| `streaming-adapter-plans.md` | Implementation plans for candidate adapters — **Bentley 3MX** (`3MXBO`/OpenCTM) and **Bing Maps 3D** (`tf=3dv4` GLB+Draco+KTX2, quadtree) — plus feasibility verdicts for **Nexus** (moderate, postponed) and **Autodesk ReCap** (blocked). Research-backed. |

> The [Design log](/docs/guide/streaming-architecture-design-log) (live-streaming harmonization — lazy
> hierarchy, the `cache = none/hierarchy/full` continuum, push/pull, per-format wiring + parallel
> hierarchy build, plus a running historical record of completed migrations) lives in the **Guide**,
> a companion narrative to
> ["Architecture: the materialization continuum"](/docs/guide/architecture-the-materialization-continuum-cache-none-hierar)
> rather than a per-format reference doc.

#### Upstream specs & reference implementations

**glTF extensions (Khronos)**
- [`KHR_gaussian_splatting` — PR #2490](https://github.com/KhronosGroup/glTF/pull/2490) — the base extension; 555-comment thread documenting the design (attribute set, namespacing, shape/rendering hints, SH handling, the split from the original single extension). Merged Jan 2026.
- [`KHR_gaussian_splatting_compression_spz_2` — PR #2531](https://github.com/KhronosGroup/glTF/pull/2531) — the SPZ-compression child extension, pinned to SPZ v2.

**CesiumJS implementation**
- [Issue #12837](https://github.com/CesiumGS/cesium/issues/12837) — "Updating to latest 3D Gaussian Extensions and deprecating initial experimental version" (deprecation/removal timeline: deprecated Sep 2025, removed Nov 2025 / v1.135).
- [PR #12843](https://github.com/CesiumGS/cesium/pull/12843) — adds support for `KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz_2`, deprecates `KHR_spz_gaussian_splats_compression`. Confirms CesiumJS decodes via the Niantic `spz` library.

**SPZ format & tooling**
- [nianticlabs/spz](https://github.com/nianticlabs/spz) — reference C++ SPZ codec. The v2 vs v3 rotation split lives in `src/cc/load-spz.cc` (`packQuaternionFirstThree` = v2 / 3-byte, `packQuaternionSmallestThree` = v3 / 4-byte).
- [@sparkjsdev/spark](https://github.com/sparkjsdev/spark) — SparkJS; writes SPZ v3 by default but version-dispatches on read (handles v2 and v3).
- [javagl/JSplat](https://github.com/javagl/JSplat) — Java reference for writing splat glTFs that CesiumJS reads (`GltfSpzSplatWriter`); a useful cross-check when updating an SPZ writer.

**PlayCanvas SOG / Streamed SOG (used by `sog-to-3dtiles`)**
- [playcanvas/splat-transform](https://github.com/playcanvas/splat-transform) — SplatTransform: PlayCanvas's splat conversion library/CLI. `sog-to-3dtiles` uses its `readSog` (CPU `webp.wasm` decode) to turn each SOG chunk into a `DataTable`. Authors Streamed SOG datasets too.
- [SOG format spec](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/) — local notes: [`sog.md`](/docs/references/sog).
- [Streamed SOG (LOD) spec](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/) — local notes: [`streamed-sog.md`](/docs/references/streamed-sog).

**3DTilesRendererJS Gaussian-splat ecosystem (WilliamLiu-1997)** — closest reference implementations to this repo's RAD path; studied to improve tiling:
- [3DTilesRendererJS-3DGS-Plugin](https://github.com/WilliamLiu-1997/3DTilesRendererJS-3DGS-Plugin) — the `3d-tiles-rendererjs-3dgs-plugin` this viewer uses to render splats in 3DTRJS (parses `KHR_gaussian_splatting` + `_spz_2`, renders via SparkJS, one shared Spark renderer per scene/renderer, camera-relative rebasing, `sparkRendererOptions`, WebXR-aware). Its `data/gaussianSplat1` & `gaussianSplat2` are wired into this viewer's preset bar (**◈ GSplat 1/2**). Note its rendering tip: keep the globe in the **opaque** pass so it doesn't object-sort against transparent splats at the horizon.
- [3DGS-PLY-3DTiles-Converter](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter) — PLY→3D Tiles converter (kd-tree tiling, AABB bounds, SPZ v3 + quantized SH). Its [`src/tiling/geometric-error.js`](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter/blob/main/src/tiling/geometric-error.js) is the model our **uniform-per-depth geometric error** mirrors: `GE(depth) = leafReference × (1/samplingRate)^(maxDepth−depth)`, anchored to a deepest-leaf "sparsity + extent" estimate, all siblings at a level sharing one error. Each tileset also emits a `build_summary.json` exposing the full GE-by-depth and sampling schedule — handy for cross-checking. ([Issue #24](https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter/issues/24): auto-depth can overload the root node on >8M-splat scenes — a tree-balancing concern worth noting for very large RAD inputs.)
- [3DTiles-Inspector](https://github.com/WilliamLiu-1997/3DTiles-Inspector) — standalone web inspector for 3D Tiles / Gaussian-splat tilesets (root-transform edit, geometric-error & layer-multiplier scaling `1/16x–16x`, splat crop regions, `build_summary.json` round-trip). A good complement to this repo's `viewer.html` 🪲 Debug-tiles overlay.

  **The inspector is pre-installed** in `tools-inspector/` — run via npm scripts (no global install needed):
  ```bash
  cd tools-inspector
  npm run inspect:tastier    # tastier500k RAD tileset
  npm run inspect:coit       # coit RAD tileset (large, 778 tiles)
  npm run inspect:coit-s050  # coit σ×0.5 scale variant
  ```
  Or run directly from the repo root with `npx`:
  ```bash
  npx --prefix tools-inspector 3dtiles-inspector sample-data/output/rad/tastier500k-3dtiles-from-rad
  npx --prefix tools-inspector 3dtiles-inspector sample-data/output/rad/coit-3dtiles-from-rad
  ```
  Each command starts a localhost HTTP server and opens the inspector in your default browser. Its `Geometric Error` / `Layer Multiplier` sliders are the runtime analogue of this converter's uniform-per-depth error model — handy for confirming LoD behaviour without re-tiling.

**Splatter (splatter.app, Jakub Červený)** — a hosted Gaussian-splat viewer/host (tested against a
103M-splat scene). Its `splatter-three` library's actual source lives in
[`splatter-app/splatter-three`](https://github.com/splatter-app/splatter-three), a **private** repo —
nothing beyond its published, intentionally-public consumer demo is reverse-engineered or reproduced
here. From [`splatter-app/three-demo`](https://github.com/splatter-app/three-demo)'s `main.js` (the
only public source), the observable public API surface:
- `new Splatter(renderer, { splatId })` — content addressed by an opaque ID, loaded/streamed
  independent of the Three.js scene graph; `renderer.render(scene, camera)` and
  `splatter.render(camera, controls.target)` are called separately per frame.
- Progressive loading via `'update'` (redraw on each streamed chunk) and `'loaded'(totalLoaded,
  numDisplayed)` events — their own demo hides a loading spinner once `numDisplayed > 1e6`, well
  before `totalLoaded` finishes, i.e. partial-scene display while still streaming (conceptually close
  to this repo's own SOG octree LOD, though the wire format itself isn't public).
- `splatter.setTransform(matrix)` positions the splat cloud independent of the rest of the scene.
- `splatter.addUniform(type, name)` + `splatter.setShaderEffect(glsl)` — a small GLSL-injection point
  operating on per-splat `position`/`scale` (their demo uses it for a radial reveal-on-load animation)
  without needing to fork the splat renderer itself.
- `splatter.hitTest(camera, [x, y], { alphaThreshold })` — screen-space picking weighted by actual
  rendered alpha, not just geometry — used for a recenter-on-double-click interaction.
- Requires an explicit WebGL2 context (`canvas.getContext('webgl2', options)`), passed into
  `new THREE.WebGLRenderer({ canvas, context })`.

---

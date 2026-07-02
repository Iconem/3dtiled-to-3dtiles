---
title: "I3S — Esri Indexed 3D Scene Layer"
description: "A \"v2\" adapter built on the loaders.gl SDK (@loaders.gl/i3s SLPK archive + scene-layer/nodepage"
---

> Status: 🟢 **live `/stream` adapter** (`packages/tile-server/i3s-live.js`, loaders.gl-based) +
> 🟡 offline draft converter `i3s-to-3dtiles/`. Validated on `Buildings_NewYork_v18` (3DObject v1.8).
> Ref: https://github.com/esri/i3s-spec (OGC Community Standard), docs/1.8.

## Live streaming (`/stream?format=i3s` · `i3s-live.js`)

A "v2" adapter built on the **loaders.gl** SDK (`@loaders.gl/i3s` SLPK archive + scene-layer/nodepage
parsing) that reuses this repo's I3S geometry decoder + ENU placement:

- **tileset.json** — read `3dSceneLayer.json` + all nodepages (node **OBBs + children + mesh refs**).
  Each tile's box comes from the OBB's enclosing AABB in a shared ENU frame — **no geometry decode**.
  One ENU→ECEF root transform; content URIs route to `/i3s/tile/<nodeIndex>.glb`.
- **tile/`<i>`.glb** — fetch ONE node's uncompressed `DefaultGeometrySchema` buffer, decode it,
  place vertices in the ENU frame, build a glTF (TRIANGLES / POINTS) on demand.

Two source modes, auto-detected: **REST / extracted-SLPK dir** (`…/3dSceneLayer.json[.gz]`, fetched
file-by-file — best for multi-GB layers like NYC, never pulls the whole dataset) and **SLPK archive**
(`….slpk`, fetched once and read via loaders.gl). Scope: uncompressed geometry only (Draco/LEPCC
gated out), no textures yet — same subset as the offline draft.

## Gist
I3S is Esri's streaming format for large 3D scene layers. Distributed as a **REST service** or a
single-file **SLPK** (Scene Layer Package — a plain zip; resources inside are often gzip'd). It is
the closest "other tiled 3D" analogue to OGC 3D Tiles — both are OGC standards solving the same
streaming-LoD problem with different document layouts.

## Layer types (what I3S can carry)
- **IntegratedMesh** — photogrammetry / reality mesh (one watertight textured mesh, tiled).
- **3DObject** — discrete textured meshes with attributes (buildings, features).
- **PointCloud** (PCSL) — lidar; its own per-node binary encoding (not `DefaultGeometrySchema`).
- **Point** — places **symbol/model instances** (billboards or 3D models) at point features.
- **Building** (BSL) — a **composite** of sublayers (the "mix of types" case).

So: meshes ✓, point clouds ✓, instances ✓ (Point layers), and mixed ✓ (Building SL = multiple
sublayers). A *single* scene layer is one type; heterogeneity comes from BSL or multiple layers.

## Tiling & hierarchy — **always explicit**
- A **node tree**: internal nodes reference children by array index. I3S has **no implicit/template
  tiling** (nothing like 3D Tiles `3DTILES_implicit_tiling` subtrees) — it is always an explicit tree.
- Modern I3S (≥1.7) uses **node pages** (`nodepages/<id>.json`, `nodesPerPage` entries each) for
  compact, range-friendly index access. Older layers used per-node `3dNodeIndexDocument`.
- **Refine:** REPLACE-style — a node's children supersede it; selection driven by `lodThreshold`.
- **HTTP:** REST + range-friendly by design; SLPK packs the same layout into a zip.

## Key on-disk structures (1.8)
- **`3dSceneLayer.json`** — `layerType`, `store` (version, `index.nodesPerPage`,
  `defaultGeometrySchema`), `spatialReference` (`wkid`/`latestWkid`, optional `vcsWkid`),
  `geometryDefinitions` (where Draco shows up, under `geometryBuffers[].compressedAttributes`).
- **nodePage entry**: `{ index, children:[idx…], obb, mesh?, lodThreshold }`.
  - **`obb`** = `{ center:[x,y,z], halfSize:[3], quaternion:[x,y,z,w] }`. center is in the layer CRS
    (global ⇒ WGS84 lon°,lat°,h); the quaternion orients an ECEF-aligned box.
  - **`mesh`** = `{ geometry:{definition, resource, vertexCount, featureCount}, material:{…}, attribute:{…} }`.
- **`DefaultGeometrySchema`** (uncompressed): `topology: PerAttributeArray` → **sequential** arrays,
  NOT interleaved. Header `vertexCount u32, featureCount u32`, then in `ordering`:
  `position f32[3·V] · normal f32[3·V] · uv0 f32[2·V] · color u8[4·V]`, then per-feature
  `id u64[F] · faceRange u32[2·F]`. `geometryType: triangles`.

## → 3D Tiles mapping (what the draft does)
- node tree → tileset tree (children→children, **REPLACE**); `lodThreshold`/OBB diagonal → geometricError.
- **OBB → 3D Tiles `box`**: geodetic `center` → ECEF; rotate unit axes by `quaternion`, scale by
  `halfSize`. (Verified on synthetic input: ECEF(0,0,0)=(6378137,0,0); axes scale correctly.)
- mesh `DefaultGeometrySchema` → glTF **TRIANGLES** (POSITION[/NORMAL/COLOR_0]); PointCloud → **POINTS**.
- vertices placed via a tile `transform` translating to the OBB-centre ECEF.

## Why still a draft (unvalidated / out of scope)
No SLPK sample to test against, and these are gated out with warnings: **Draco** geometry, **textures/
materials**, **per-feature attributes** (→ would need `EXT_mesh_features`/3D Tiles metadata), **legacy
`3dNodeIndexDocument`** index, **Point/Building** layer types, and **non-WGS84 / vertical-CRS** nuance.
The exact resource path layout, the vertex-origin convention, and projected-CRS OBB handling all need
confirmation against real data. Full-fidelity I3S overlaps mature tooling (loaders.gl, Cesium ion).

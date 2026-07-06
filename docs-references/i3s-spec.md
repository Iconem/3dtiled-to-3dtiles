# I3S — Esri Indexed 3D Scene Layer

> Status: 🟢 **live `/stream` adapter** (`packages/tile-server/i3s-live.js`, loaders.gl-based) +
> 🟡 offline draft converter `i3s-to-3dtiles/`. Validated on `Buildings_NewYork_v18` (3DObject v1.8)
> and, for PointCloud/LEPCC, `Moro_Bay_LiDAR` + `USGSNYC_2014_LiDAR` (see LEPCC section below).
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
(`….slpk`, fetched once and read via loaders.gl). Scope: uncompressed mesh geometry only (mesh Draco
gated out); PointCloud geometry supports BOTH uncompressed and **LEPCC-compressed** (see below), no
textures yet on point clouds — same subset as the offline draft.

## LEPCC point-cloud decoding

PointCloud layers can encode `defaultGeometrySchema.encoding: "lepcc-xyz"` — a proprietary Esri
codec (Limited Error Point Cloud Compression), NOT the plain Float64/Int32 `PerAttributeArray` the
schema's `vertexAttributes` nominally describe. Decoded via `packages/i3s-to-3dtiles/src/
lepccDecode.js`, a pure-JS port of Esri's own open-source codec
(**github.com/Esri/lepcc**, Apache-2.0 — a small, actively-maintained C++ repo whose own README
says "easy to port the decoder to other languages such as JS, Python, C# etc").

Scope: **decode only**, and only the `bt_XYZ` blob type (position). RGB/Intensity/FlagBytes are
separate LEPCC blob types — not needed here since every real I3S point-cloud dataset checked so far
declares only a `position` vertexAttribute (color/intensity, if present at all, come through a
different, uncompressed channel).

Format (all little-endian): a 16-byte top header (`"LEPCC     "` file key + version + Fletcher-32
checksum), an 88-byte header (blob size, extent, max error, point count), then four **bit-stuffed,
delta-encoded arrays** in a fixed order — `yDelta`, `numPointsPerRow`, `xDelta`, `z` — recombined
into absolute positions via a running per-row Y-cursor and per-point X-cursor (LEPCC's "cut in
segments" scheme: values are split into sections, each with its own minimum, to keep the bit-width
low). `BitStuffer2`'s packing treats the byte stream as consecutive little-endian uint32 words and
packs values LSB-first, carrying across word boundaries — not a simple byte-at-a-time bit reader.

**Real wrinkle found integrating this**: LEPCC positions decode to **absolute geodetic** (lon°,
lat°, height m) coordinates — unlike the uncompressed `PerAttributeArray` layout, which stores
per-vertex offsets *relative to the node's OBB centre*. Callers must NOT add the node's OBB centre
to LEPCC-decoded positions (`decodeDefaultGeometry` signals this via a new `absolutePosition: true`
flag on its return value).

Verified against two real ArcGIS-hosted SceneServers:
- `Moro_Bay_LiDAR` (`tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/.../Moro_Bay_LiDAR/SceneServer`)
- `USGSNYC_2014_LiDAR` (same org, `.../USGSNYC_2014_LiDAR/SceneServer`)

For both: decoded byte count lands exactly on the header's `blobSize`, the Fletcher-32 checksum
matches, and decoded coordinates fall inside the blob's own extent header and the layer's
`store.extent`. Independently re-checked by parsing the actual served GLB's binary buffer and
confirming the local-frame position ranges are sane (non-NaN, physically plausible spread) — not
just trusting a 200 status code.

USGSNYC also exposed a real, separate bug (unrelated to LEPCC): its node page 0 has exactly
`nodesPerPage` nodes, forcing a background fetch of page 1, which the SceneServer answers with
**HTTP 200 + an ArcGIS error envelope** (`{"error":{"code":404,...}}`) instead of a real 404 —
crashing the naive `for (const n of pg.nodes)` node-page reader. Fixed by treating a page whose
`.nodes` isn't an array the same as end-of-pagination.

Not ported: `doLut` bit-stuffer mode (an encoder-side size optimization not observed in any real
dataset checked) and the non-XYZ LEPCC blob types (RGB/Intensity/FlagBytes) — both fail loudly with
a clear error rather than silently mis-decoding, should a dataset ever need them.

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

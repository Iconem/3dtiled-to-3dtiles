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

Scope: position (`bt_XYZ`/`LEPCC.cpp`) **and** color (`ClusterRGB.cpp`) blob types — see the RGB
section below. Intensity/FlagBytes (separate LEPCC blob types) are not ported: no dataset checked so
far both declares one and actually serves the underlying attribute resource.

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
dataset checked) and the non-XYZ/RGB LEPCC blob types (Intensity/FlagBytes) — both fail loudly with
a clear error rather than silently mis-decoding, should a dataset ever need them.

## LEPCC per-point RGB (`ClusterRGB`)

Unlike position, RGB is **not** part of `defaultGeometrySchema` at all — it's a separate per-node
resource declared in the layer's `attributeStorageInfo` array (an entry with `encoding: "lepcc-rgb"`
or `name: "RGB"`), fetched from `nodes/<resourceId>/attributes/<attributeStorageInfo.key>` — **no
trailing `/0`/page segment**.

**Real wrinkle found integrating this**: the obvious first guess — copying `@loaders.gl/i3s`'s own
`generateTilesetAttributeUrls()` URL pattern, `nodes/<res>/attributes/<key>/0` — 404s on every node,
every key, every resource id tried, even though `attributeStorageInfo` genuinely declares an `RGB`
entry and the dataset is visibly colored in Esri's own ArcGIS Scene viewer. That loaders.gl helper is
for the *legacy* per-node `3dNodeIndexDocument` layout's `attributeData[].href` convention — it does
not apply to modern nodePages-based PointCloud layers. The real spec example
(`github.com/Esri/i3s-spec/.../pcsl_ReadMe.md`) has no trailing segment at all:
`.../layers/0/nodes/20/attributes/64`. Dropping the `/0` immediately returns real binary, with a
`"ClusterRGB"` file-key header — a **separate LEPCC blob type** from the `"LEPCC     "`-keyed
position blob, decoded via a new `decodeLepccRgb()` in the same `lepccDecode.js`, ported from Esri's
`ClusterRGB.cpp`.

Format: the same 16-byte top header shape (10-byte file key `"ClusterRGB"`, uint16 version, uint32
Fletcher-32 checksum) as the XYZ blob, then a 16-byte `Header1` (int64 blobSize, uint32 numPoints,
uint16 numColorsInColormap, Byte colorLookupMethod, Byte colorIndexCompressionMethod — the two Byte
fields are 1 each, no bit-stuffing anywhere in this blob type). Decode dispatches purely on
`numColorsInColormap`, not `colorLookupMethod` (matching `ClusterRGB::Decode` exactly — the lookup
method is encoder-side bookkeeping): `0` → `numPoints` raw RGB triplets follow directly; otherwise a
`numColorsInColormap`×3 palette follows, then either one index byte per point
(`colorIndexCompressionMethod: 0`, "NoCompression") or nothing at all — every point is `colormap[0]`
(`: 1`, "AllConst"). A third mode, Huffman-coded indices, exists in the struct but is compiled out of
Esri's own reference encoder (`#ifdef TryHuffmanOnColor`, undefined) — no real file should ever set
it; fails loudly if one somehow does.

Verified against `Moro_Bay_LiDAR`'s root node: `numColorsInColormap=256`, `colorIndexCompressionMethod=0`,
and `32 (header) + 256×3 (palette) + 14,998 (indices) = 15,798` bytes — landing exactly on the
blob's own `blobSize`. Decoded palette spans a real, varied range (R/G/B each roughly 10–254 across
256 distinct colors, not degenerate).

A SEPARATE bug surfaced once real RGB reached the renderer: I3S PointCloud presets in the viewer's
`formats.ts` inherited their format group's `type: 'mesh'` default (most I3S samples ARE meshes) with
no per-asset override actually being read (`middleware.ts` built every preset's `type` from the
group only, `f.type`, ignoring `asset.type` entirely) — so point clouds got treated as meshes
client-side, which forces LIT shading; points have no `NORMAL` attribute, so lit shading always
zeroed them to black regardless of the real (correctly decoded) vertex color. And even after fixing
both of those, a THIRD, more fundamental bug remained: the point-cloud GLB writer
(`glbBuild.js`) never attached a `material` to `POINTS` primitives at all — glTF's spec-mandated
default material for a primitive with no material index is fully metallic
(`metallicFactor: 1`), which renders flat black without an environment/IBL map **regardless of
COLOR_0**, the exact same failure mode `glbBuild.js`'s own comment already documented for *mesh*
tiles (fixed 2026-07-02) but which was never extended to `POINTS` primitives. All three had to be
fixed together for real point-cloud color to actually reach the screen.

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
- **Children encoding is NOT uniform across layer types.** Mesh node pages (validated on
  `Buildings_NewYork_v18`, Rancho Mesh) carry an explicit `children:[idx…]` array per node. PointCloud
  node pages (v2.0 — `Moro_Bay_LiDAR`, `USGSNYC_2014_LiDAR`) carry **no such array at all** — only
  `firstChild`+`childCount`, a contiguous-index shorthand (`children = [firstChild, firstChild+1, …,
  firstChild+childCount-1]`). A reader that only checks `.children` silently builds a **root-only
  tree** for every point-cloud dataset — this was a real bug here (fixed in `i3s-live.js` and the
  offline draft, via a shared `childIndices()` in `i3sParse.js`), not a renderer refine/LOD issue. The
  earlier "Moro Bay .slpk exposes only a single root node" note in this repo's viewer presets was this
  same bug, not a property of that specific archive — both the `.slpk` and the live SceneServer build
  their full tree correctly now (13,775 / 2,624 tiles respectively, up from 1).

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

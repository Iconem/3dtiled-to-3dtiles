# I3S — Esri Indexed 3D Scene Layer

> Status: 🟠 **doc-referenced only — no converter built** (would be `i3s-to-3dtiles`).
> Ref: https://github.com/esri/i3s-spec (OGC Community Standard).

## Gist
I3S is Esri's streaming format for large 3D scene layers (integrated mesh, 3D objects, point clouds,
point scene layers, and building scene layers). Distributed as a **REST service** or a single-file
**SLPK** (Scene Layer Package, a zip). It is the most direct "other tiled 3D" analogue to OGC 3D Tiles
— both are OGC standards solving the same streaming-LoD problem with different document layouts.

- **Hierarchy:** a node tree with **bounding-sphere** LoD; nodes reference geometry/texture/attribute
  resources. Newer I3S uses node **pages** (`nodepages`) for compact index access.
- **Top metadata:** `3dSceneLayer.json` (layer type, store, spatial reference, default geometry schema).
- **Node docs:** per-node JSON (`3dNodeIndexDocument` / nodepage entries) → `geometries/`, `textures/`,
  `attributes/`, `shared/` resources. Geometry often Draco-compressed.
- **Refine:** REPLACE-style (a node's children supersede it), distance/SSE driven by `lodSelection`.
- **HTTP:** designed for range/REST access; SLPK is a zip with an internal index.

## Why no converter (yet)
Most I3S in the wild is **integrated mesh / point cloud**, not Gaussian splats — so an `i3s-to-3dtiles`
would primarily be a *mesh/point* tileset converter (b3dm/pnts/glTF), overlapping with mature tools
(e.g. Esri's own I3S↔3D Tiles interoperability work). Out of scope for this splat-focused repo; kept
as a reference. If built, the I3S node tree → 3D Tiles tree mapping is fairly direct (both are
bounding-volume LoD trees).

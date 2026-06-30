# MapTiler GeoSplats — format notes (reverse-engineered)

**GeoSplats** is MapTiler's georeferenced, HLOD Gaussian-splat format for streaming large splat
models onto a map. Rendered by the **`@maptiler/geosplats`** SDK (WebGPU). These notes are
reverse-engineered from a live `model.json` + `metadata.json` and the public SDK bundle
(`https://cdn.maptiler.com/maptiler-geosplats/v1.0.4/maptiler-geosplats.mjs`, 639 KB) — there is no
published byte-spec yet.

## Links
- Product: https://www.maptiler.com/geosplats/
- SDK (npm): https://www.npmjs.com/package/@maptiler/geosplats · CDN: `https://cdn.maptiler.com/maptiler-geosplats/v1.0.4/maptiler-geosplats.mjs`
- MapTiler docs: https://docs.maptiler.com/  · 3D maps/editor: https://www.maptiler.com/3d-maps/

## `model.json` (top manifest)
```jsonc
{
  "global_position": {                       // georeferencing of the whole model
    "model_scale": 0.0007,                   // uniform scale (local units → metres)
    "offset": { "x":0,"y":0,"z":0, "x_rot":0,"y_rot":-178,"z_rot":180 },  // Euler offset (deg)
    "lat": 54.829…, "lon": 18.314…, "alt": -307.6 },                       // place on the globe
  "models": [                                // N spatially-tiled sub-models
    { "baseurl": "<uuid>", "sogs": true, "progressive_lod": true,
      "lod": false, "detail": 5, "offset": { …per-model Euler/translation… } }, … ],
  "attribution": "…"
}
```

## `<baseurl>/metadata.json` (per sub-model)
- `lod_mode` (`"standalone"`), `splats_total`, `num_levels` (8), `format` (0).
- `lod_point_counts` — cumulative splat count per LOD (≈2× each level → progressive, coarse-first);
  `lod_level_point_counts` — per-level deltas.
- `bounding_box` — `{min,max}` in **local** model coords.
- `voxel_grids` — multi-resolution **octree index**: `grid_1`, `grid_8`, `grid_64`, `grid_512`. Each
  cell: `{ offset (into global splat order), total_count, counts[8] (cumulative/LOD),
  level_counts[8], center, bounding_box }`. The renderer walks these to pick in-frustum octants at
  the right LOD.
- `entries` — bundle TOC `[path, byteOffset, byteLength, flags, md5]` into one packed blob; per
  octant×LOD the **SOGS** components are `means_l.webp, means_u.webp, quats.webp, scales.webp,
  sh0.webp` (+ `meta.json`, `profile.json`). `metadata.json` itself is the tail entry of the blob.

## Data primitive = SOGS
Per-octant data is **SOGS** (PlayCanvas spatially-ordered Gaussians): WebP textures for
`means_l/means_u` (low/high position bytes), `quats`, `scales`, `sh0` (+ optional SH), described by a
small `meta.json`. This is the same primitive `@playcanvas/splat-transform`'s `writeSog`/`readSog`
produce — so an octant's components can be decoded to a `DataTable` and re-encoded (SPZ/GLB) for 3D Tiles.

## Two serving modes (from the SDK)
1. **Static hosting** — files at `…/delta_data/grid_<s>/octant_<id>_LOD<n>/{means_l,…,sh0}.webp` (+
   per-octant `meta.json`); octants may also be served as `…/<level>/octant_<n>.ply`. Decoded via the
   SDK's `decode({model_type: SPLAT, format_type: PLY|SOGS})`.
2. **MapTiler API proxy** — `https://api.maptiler.com/splats/<modelId>/<baseurl>/64/6/6?key=…`
   returns individual WebPs. The `/64/6/6` params are opaque (e.g. `/64/6/6` → 200, `/64/0/0` →
   `Invalid parameters`); the exact `grid/x/y`↔octant mapping is internal to the SDK. **API keys are
   origin-restricted** (a server-side fetch needs `Referer: https://www.maptiler.com/`; localhost
   referer is rejected).

## Coordinate convention
`global_position` (lat/lon/alt + uniform scale + Euler offset, with `y_rot≈-178`, `z_rot=180`) places
the local model frame on the globe — analogous to our ENU-anchored splat-dump output. Local splat
data is Y-up-ish; the Euler offset reconciles it with the map frame.

## Converter status (GeoSplats → OGC 3D Tiles)
Decoded & tractable: the **georeferencing** (`global_position` → ECEF root transform) and the
**octree + LOD → tileset tree** (`voxel_grids` → boundingVolumes + per-level geometricError). The
**per-tile content fetch** is the open item: for API-proxy-hosted models the `/64/6/6` octant URL
scheme must be traced out of the SDK, and the origin-locked key requires a referer-spoofing proxy.
A converter for **statically-hosted** GeoSplats exports (`delta_data/…` paths) is the cleaner first
target. See `packages/tile-server/` (`/stream` adapters) for where this would live.

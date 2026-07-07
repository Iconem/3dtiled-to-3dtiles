---
title: "LCC — Lixel CyberColor (XGrids)"
description: "LCC is XGRIDS's chunked, LOD-native, reofer-reday container for 3D Gaussian Splatting from Multi-SLAM capture"
---

> Sources: https://github.com/xgrids/LCCWhitepaper · https://developer.xgrids.com/#/document?titleId=en-1720509291851
> License: XGRIDS White Paper License (attribution required: "Data Organization Format originated from XGRIDS"; derivatives must be published under terms no less open; no AI-model training that competes with XGRIDS). Quote/cite, don't relicense.

LCC is XGRIDS's chunked, LOD-native container for 3D Gaussian Splatting from Multi-SLAM capture
(L1/L2/K1/PortCam/Drone). Smaller than PLY, progressive streaming, integrations for Three.js,
Unity, Unreal, Cesium. Target for a future `lcc-to-3dtiles` converter.

## File set
| File | Req | Purpose |
|------|-----|---------|
| `meta.lcc` | ✔ | JSON metadata (name modifiable) |
| `Index.bin` | ✔ | per-Unit node index (fixed `indexDataSize` bytes/Unit) |
| `Data.bin` | ✔ | basic per-splat data (position/normal/color/opacity/scale/rotation) |
| `Shcoef.bin` | optional | SH coefficients (present iff `fileType: "Quality"`) |
| `Environment.bin` | optional | far-field background splats (basic+SH combined) |
| `Collision.lci` | optional | collision mesh + BVH (preorder, 32 B/node) |

Terms: **Node** = a chunk at one LOD level · **Index** = uint32 packing x(low16)/y(high16) of a
partition cell · **Unit** = group of Nodes sharing one Index · **Level** = one LOD level.
`fileType`: `Portable` = RGB only (no Shcoef.bin) · `Quality` = RGB + 3rd-order SH.

## meta.lcc (key fields)
`version`, `source` (lcc/ply/splat/none), `dataType` (L1/L2/K1/…), `totalSplats`, `totalLevel`,
`cellLengthX/Y` (Node size, m), `indexDataSize` (bytes/Unit index), `offset`/`shift`/`scale`/`epsg`
(global), `splats[]` (per-LOD counts, LOD0→), `boundingBox` (min/max, no env), `encoding`
(`COMPRESS`), `fileType`, `attributes[]` (per-property min/max for dequant: position, normal,
color, shcoef, opacity, scale, + env* variants).
Observed sample `Guan_Temple`: version 3.0, 11.4M splats, 4 levels, `indexDataSize` 68
(= index uint32 4 + 4 levels × {PointsCount u32, Offset u64, Size u32 = 16} = 68).

## Index.bin (per Unit, little-endian, `indexDataSize` bytes)
`index` u32 · then per LOD level: `PointsCount` u32, `LODOffset` u64 (into Data.bin),
`LODSize` u32. Total Units = fileSize / `indexDataSize`. Unit AABB starts at `boundingBox.min`,
cell size (`cellLengthX`,`cellLengthY`).

## Data.bin per-splat (32 B basic; +64 B SH when Quality — SH offset/size = 2× the Data offset/size)
- **position** xyz: 3× `float32`, used directly.
- **scale** xyz: 6 bytes → extract xyz as Int (per axis), lerp via `attributes.scale` min/max.
- **rotation** `uint32`: 10/10/10/2 packed "smallest-three". Decode (HLSL from spec):
  `pq = ((enc&1023)/1023, (enc>>10&1023)/1023, (enc>>20&1023)/1023, (enc>>30&3)/3)`;
  `idx=round(pq.w*3)`; `q.xyz = pq.xyz*√2 − 1/√2`; `q.w = sqrt(1−dot(q.xyz))`; reorder by
  `QLut[idx]` (`{3,0,1,2, 0,3,1,2, 0,1,3,2, 0,1,2,3}`).
- **color** `uint32` RGBA → /255 → [0,1].
- **opacity**: lerp via `attributes.opacity` min/max.

## Shcoef.bin (Quality only, 64 B/splat = 15 coeffs)
Packed-11 per coeff: `DecodePacked11(enc) = ((enc&2047)/2047, (enc>>11&1023)/1023, (enc>>21&2047)/2047)`,
then lerp via `attributes.shcoef` min/max. 15 coeffs (sh1..sh15) → SH degree 3.

## Environment.bin — same decode as above but using the `env*` attribute min/max ranges.

## Collision.lci — header (`headerLen`) + mesh data (verts + tri indices) + BVH (preorder,
32 B/node; internal: bbox f32×6, right u32@24, splitAxis u16@28, flag u16@30; leaf: bbox,
faceOffset u32@24, faceCount u16@28, flag 0xFFFF@30). Optional for rendering — skippable.

## Mapping to 3D Tiles (planned `lcc-to-3dtiles`)
Units×Levels form a quadtree-ish LOD grid → 3D Tiles HLOD: each Unit's per-LOD Node = a tile,
coarsest level as ancestor (REPLACE) down to LOD0, decoded splats re-encoded to SPZ-v2 GLB
(reuse `spzGlb.js`). Position direct; rotation via the 10-10-10-2 decode above (→ xyzw); scale
lerp+exp?; color/255; opacity lerp; SH (Quality) → KHR `SH_DEGREE_*` attributes. Coordinate frame
per Fig.2 (right-handed) → emit boxes Z-up (`RX+90°`) like the RAD/SOG paths. Environment as an
always-coarse ADD child. NB: this LCC sample is **version 3.0** (whitepaper documents 5.0) — field
layouts match but confirm against the actual bytes before trusting any single field.

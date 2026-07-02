# COPC — Cloud Optimized Point Cloud (distilled local mirror)

Source: [copc.io](https://copc.io) (spec repo: [copcio/copcio.github.io](https://github.com/copcio/copcio.github.io),
©2021 Hobu, Inc.). Distilled/paraphrased here per this repo's convention (see the main README) —
copc.io itself blocks automated fetching, so this mirror was built from the spec repo's README.
Authoritative version: **COPC 1.0**, designed by Andrew Bell, Howard Butler and Connor Manning
(Hobu, Inc.).

## What it is

A COPC file is an ordinary **LAZ 1.4 file** whose point data is organized as a **clustered octree**,
plus two VLRs that describe that octree so a reader can seek directly to any node's data. The pitch
is explicitly the point-cloud analogue of **Cloud Optimized GeoTIFF**: "it's just a LAZ" (any
LAS/LAZ 1.4 reader can still read it top-to-bottom), but a COPC-aware reader can additionally
range-read just the octree nodes it needs over plain HTTP.

Its octree/hierarchy model is deliberately modeled on **Entwine Point Tile (EPT)** — same
`level-x-y-z` voxel-key addressing — but COPC stores the whole tree as byte ranges **inside one LAZ
file** (LAZ's variable-size chunk table) instead of EPT's "one file per octree node" layout, which
avoids the "collections of millions of files" problem EPT can produce at scale.

## On-disk structure (what our COPC readers/converters key off)

- **Point format**: must be ASPRS LAS PDRF **6, 7, or 8** only (no legacy PDRFs).
- **`info` VLR** (`userID="copc"`, `recordId=1`, **160 bytes**, must start at byte **offset 375**):
  octree `center_x/y/z` + `halfsize` (root node cube), `spacing` (point spacing at the root level,
  halves per octree level), and `root_hier_offset`/`root_hier_size` pointing at the first hierarchy
  page.
- **`hierarchy` VLR** (`userID="copc"`, `recordId=1000`): one or more **hierarchy pages**, each a
  flat array of 32-byte `Entry` records — `{ VoxelKey{level,x,y,z}, offset, byteSize, pointCount }`.
  `pointCount > 0` → `offset`/`byteSize` locate that node's LAZ-compressed chunk directly;
  `pointCount == -1` → they instead locate a **child hierarchy page** (so the hierarchy can itself be
  paged/lazily fetched instead of loaded whole); `pointCount == 0` → the node has no points of its
  own (but may still have populated children).
- **Differences from EPT**: no `ept.json` (that metadata lives in the LAS header + VLRs instead); LAZ
  point data only (no raw/binary point arrangement); chunks are pure point data, not full LAZ files
  with their own headers.
- A reader can identify + fully bootstrap a COPC file from its **first 589 bytes** (375-byte LAS
  header + 54-byte VLR header + 160-byte `info` VLR) — enough to confirm the `copc` signature, the
  COPC version, and the point record format/length needed to construct a LAZ decompressor, before
  touching any point data.
- **Server requirement**: HTTP **range requests** + **CORS**, nothing COPC-specific server-side — any
  static file host that supports both already works.

## Relation to this repo

This is exactly the file shape `packages/copc-to-3dtiles` and `packages/tile-server/copc-live.js`
consume: the `info` VLR gives the root box/spacing/georef anchor, the `hierarchy` VLR pages give the
octree → 3D Tiles tree mapping (1:1, ADD refine, per-node byte range → one LAZ-decompress → one
POINTS GLB), and `--tiling explicit|implicit` (offline) / `?tiling=explicit` (live) picks between an
explicit 3D Tiles tree and native 3D Tiles 1.1 implicit tiling over that same hierarchy.

Example public COPC files (from the spec repo): Autzen Stadium (~80 MB), SoFi Stadium (~2.3 GB),
Millsite Reservoir (~1.9 GB) — see [copc.io's example data](https://copc.io) for current links. An
online validator is at [validate.copc.io](https://validate.copc.io).

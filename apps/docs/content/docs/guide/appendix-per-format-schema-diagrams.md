---
title: "Appendix: per-format schema diagrams"
description: "Collapsed by default — expand a format below for its LoD/hierarchy tree as a diagram."
---

Collapsed by default — expand a format below for its LoD/hierarchy tree as a diagram.

<details><summary><b>RAD</b> (SparkJS) — LoD merge tree, REPLACE</summary>

```mermaid
flowchart TD
  R["RAD0 header (JSON)<br/>chunks[], chunkSize, splatEncoding"] --> C0["RADC chunk 0 (coarsest LoD)<br/>merged representative splats"]
  C0 --> C1["RADC chunk … (finer)"]
  C1 --> CN["RADC chunk N (finest)"]
  subgraph COL["each RADC chunk = per-splat columns"]
    P["center f32_lebytes (byte-transposed)"]
    A["alpha f16 (interleaved)"]
    G["rgb r8_delta (planar)"]
    S["scales ln_0r8 (planar)"]
    O["orientation oct88r8 (interleaved)"]
    H["sh1 s8 (planar)"]
  end
  CN -.contains.-> COL
```
</details>

<details><summary><b>Streamed SOG</b> (PlayCanvas) — binary spatial tree, REPLACE</summary>

```mermaid
flowchart TD
  M["lod-meta.json<br/>tree, filenames[], lodLevels"] --> N0["interior node (AABB)"]
  N0 --> N1["interior node"]
  N0 --> N2["interior node"]
  N1 --> L1["leaf: lods{0..L}<br/>each = {file, offset, count}"]
  N2 --> L2["leaf: lods{0..L}"]
  L1 -.run in.-> CH["chunk = unbundled SOG<br/>(WebP textures + meta.json)<br/>→ readSog → DataTable"]
```
</details>

<details><summary><b>LCC</b> (XGRIDS) — Unit grid × LODs, REPLACE</summary>

```mermaid
flowchart TD
  MT["meta.lcc (JSON) + Index.bin<br/>Units = cellX×Y grid"] --> U["Unit (cell x,y)"]
  U --> D0["LOD0 run (finest)"]
  U --> D1["LOD1 run"]
  U --> D2["LOD… (coarsest)"]
  D0 -.->|"Index → Data.bin offset"| REC["32 B/splat: pos f32×3 · color rgba8 (a=opacity)<br/>· rot u32 10-10-10-2 · scale u16×3 (geometric)"]
  U -.optional.-> SH["Shcoef.bin (Quality, 64 B/splat)"]
```
</details>

<details><summary><b>COPC</b> (LiDAR) — octree, ADD</summary>

```mermaid
flowchart TD
  HD["LAS header + COPC VLR<br/>+ hierarchy pages"] --> RT["root octree node (depth 0)"]
  RT --> O1["octant (depth 1)"]
  RT --> O2["octant (depth 1)"]
  O1 --> O11["octant (depth 2) …"]
  O1 -.->|"each node = key (D-X-Y-Z)"| PTS["LAZ-compressed LAS points<br/>(ADD: nodes accumulate detail)"]
```
</details>

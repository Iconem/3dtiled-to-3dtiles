---
title: "loaders.gl Tile Converter — @loaders.gl/tile-converter"
description: "Source: https://loaders.gl/docs/modules/tile-converter/cli-reference/tile-converter"
---

Source: https://loaders.gl/docs/modules/tile-converter/cli-reference/tile-converter

## Summary

The `tile-converter` is a CLI (and JS library) for **two-way batch conversion between I3S and 3D Tiles**.
It is maintained by the Esri/loaders.gl team.

```
npm i @loaders.gl/tile-converter

npx tile-converter --install-dependencies
npx tile-converter --input-type <I3S|3DTILES> --tileset <tileset> --name <name> [options...]
```

## Key options

| Option | Direction | Description |
|---|---|---|
| `--input-type` | both | `"I3S"` or `"3DTILES"` |
| `--tileset` | both | `.json` file (3DTiles) or `http://…/SceneServer/layers/0` (I3S) |
| `--output` | both | Output folder (default: `./data`) |
| `--name` | both | Tileset name (used in output JSON + SLPK filename) |
| `--output-version` | I3S→3DT | `"1.0"` or `"1.1"` (default) |
| `--no-draco` | I3S→3DT | Disable Draco compression on output |
| `--slpk` | 3DT→I3S | (deprecated since 4.3 — SLPK is now the default output) |
| `--max-depth` | both | Max depth of tile traversal (default: ∞) |
| `--generate-textures` | 3DT→I3S | Compress/decompress textures (KTX2 ↔ JPG/PNG) |
| `--generate-bounding-volumes` | 3DT→I3S | Recompute OBB/MBS from geometry |
| `--instant-node-writing` | 3DT→I3S | Keep node JSON on disk (saves RAM for huge datasets; ~2× slower) |
| `--split-nodes` | 3DT→I3S | One node per PBR material (prevents material merge artefacts) |
| `--egm` | both | Path to Earth Gravity Model `.pgm` for ellipsoidal→gravity height conversion |
| `--token` | 3DT→I3S | Cesium Ion access token |
| `--quiet` | both | Skip interactive prompts (resume/new, metadata class) |
| `--validate` | I3S→3DT | Count tiles; check child fits parent bounding volume |
| `--analyze` | both | Analyze without converting |
| `--metadata-class` | 3DT→I3S | Select a metadata class when multiple are detected |
| `--add-hash` | — | Add hash entry to an existing SLPK |

## Relation to this project (`i3s-to-3dtiles`)

This project's `packages/i3s-to-3dtiles/` is a **custom parser** — it does NOT use `@loaders.gl/tile-converter`. It reads I3S SLPK directories directly:

- `i3sParse.js`: reads `layers/0/` (scene-layer.json), node pages, and geometry buffers
- `glbBuild.js`: writes raw GLB (no loaders.gl dependency)

### Why not wrap `@loaders.gl/tile-converter`?

| | This project | `@loaders.gl/tile-converter` |
|---|---|---|
| **Deps** | Zero (pure Node) | ~300 MB after `--install-dependencies` |
| **Scope** | SLPK directory only | SLPK, REST service, Cesium Ion |
| **Unsupported** | Draco, LEPCC, textures | All supported |
| **API** | Direct `convert()` call | CLI / subprocess |
| **Browser future** | Possible | Node-only (native deps) |

For production I3S conversion (especially Draco-compressed or textured datasets), prefer `@loaders.gl/tile-converter`. For simple uncompressed mesh / point clouds, this project's built-in converter suffices.

### `@loaders.gl/i3s` (separate from tile-converter)

`@loaders.gl/i3s` provides `SLPKLoader`, `SLPKSource`, `I3SLoader` — read-only, no 3D Tiles writer.
Can serve SLPK tiles on-demand via `SLPKSource` (random access into the zip without full extract).
Streaming: loaders.gl I3S loaders support incremental tile loading from REST services; SLPK is file-based.

```js
import { SLPKLoader } from '@loaders.gl/i3s';
import { load } from '@loaders.gl/core';
const layer = await load('path/to/data.slpk', SLPKLoader);
```

## Docker usage

```
docker pull visgl/tile-converter
docker run --rm \
  -v /path/to/output:/loaders-bundle/data \
  -v /path/to/input:/loaders-bundle/input-data \
  visgl/tile-converter \
  --input-type 3dtiles \
  --tileset input-data/tileset.json \
  --name MyDataset \
  --output data
```

## Running a converted I3S layer locally

```sh
PORT=8080 I3sLayerPath="./data" npx i3s-server
# then open: https://loaders.gl/examples/i3s?url=http://localhost:8080/LayerName/SceneServer/layers/0
```

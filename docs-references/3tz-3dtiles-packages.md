# 3TZ and .3dtiles — single-file 3D Tiles packaging formats

Both formats package a 3D Tiles tileset (tileset.json + tile files) into a single transportable
file. They are served by this project's `/package` endpoint.

---

## .3tz — ZIP-based package

A `.3tz` file is a standard ZIP archive with one additional required entry: **`@3dtilesIndex1@`**.

### @3dtilesIndex1@ binary index

The index enables **O(1) random access** to any tile without scanning the entire ZIP central
directory. Its binary format is a flat sequence of variable-length records:

```
[uint16-LE  path-length]
[UTF-8 bytes path (path-length bytes)]
[uint64-LE  local-header-offset]   ← byte offset of the ZIP local file header in the .3tz file
[uint32-LE  data-length]           ← byte length of the compressed/stored entry data
```

After reading the index, individual tiles are fetched with a single `fs.read(fd, …)` at the
stored offset (skip the local header: 30 + nameLen + extraLen bytes), reading `data-length` bytes.
Tile entries must be STORED (method=0) or DEFLATE (method=8); the spec recommends STORED for tiles
to allow true random access.

### Spec and implementation references

- **Extension proposal**: Maxar `MAXAR_content_3tz` — original package-format proposal.
- **CesiumGS implementation**: https://github.com/CesiumGS/3d-tiles-tools/pull/86
  (`3d-tiles-tools` v0.5.3+ ships `3d-tiles-tools serve --input <file.3tz>`).
- **3d-tiles-tools source**: `src/packages/Tz3tzPackage.ts` — the TypeScript reference
  implementation for reading/writing the index.
- **Cesium PR discussion** (inline in the above PR) covers edge cases: ZIP64 offsets, stored vs
  deflated tiles, tileset.json key convention.

### Creation

```
npx 3d-tiles-tools convert -i tileset/ -o package.3tz
# or:
npx 3d-tiles-tools packageCreate -i tileset/ -o package.3tz
```

---

## .3dtiles — SQLite-based package

A `.3dtiles` file is an SQLite database with a single table:

```sql
CREATE TABLE media (
  key     TEXT PRIMARY KEY,
  content BLOB NOT NULL
);
```

`key` is the relative path within the tileset (e.g. `tileset.json`, `tiles/0/0/0.glb`).

### Spec references

- **3d-tiles-tools source**: `src/packages/TilesetSqliteDatabase.ts`.
- Served by `3d-tiles-tools serve --input file.3dtiles` (same CLI as .3tz).

### Creation

```
npx 3d-tiles-tools packageCreate -i tileset/ -o package.3dtiles
```

### This project's support

Requires `better-sqlite3` (native addon):

```
pnpm add -w better-sqlite3   # needs C++ build toolchain
```

Without it the `/package` endpoint returns **501** with install instructions. `.3tz` files work
without any additional dependencies (pure Node.js ZIP parsing + fflate for DEFLATE entries).

---

## Usage with this project's tile-server

```
# Serve a .3tz file through the live tile-server (port 3001):
GET http://localhost:3001/package/tileset.json?url=/abs/path/to/package.3tz

# Then open in Cesium:
const tileset = await Cesium.Cesium3DTileset.fromUrl(
  'http://localhost:3001/package/tileset.json?url=/abs/path/to/package.3tz'
);
```

All tile URIs in the served tileset.json are automatically rewritten to route back through
`/package/<key>?url=<same-path>`, so no viewer-side configuration is needed.

---

## Status

| Feature | .3tz | .3dtiles |
|---|---|---|
| Random-access reads | ✓ (index entry) | ✓ (SQLite primary key) |
| Implemented | ✓ | ✓ (needs `better-sqlite3`) |
| Creation | via `3d-tiles-tools` | via `3d-tiles-tools` |
| ZIP64 | ✓ (basic) | n/a |

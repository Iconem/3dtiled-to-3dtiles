/**
 * upgrade-real.js — thin wrapper around the REAL CesiumGS `3d-tiles-tools` npm package's
 * TilesetOperations.upgrade (1.0 → 1.1: b3dm/pnts/i3dm → glb, content URIs rewritten, asset
 * version bumped). This is a genuine local-filesystem BATCH operation (see gotcha below) —
 * unlike our own hand-rolled `upgradeTileset` (upgrade.js) which is CLI/offline only, and
 * unlike `3dtiles-tools-live.js`'s `serveUpgradeTile` which converts each tile ON REQUEST
 * with nothing written to disk. This wrapper writes a full converted copy to `outDir` once,
 * then the caller serves it statically (see 3dtiles-tools-live.js's `serveRealUpgrade`).
 *
 * Investigated: the real package's `TilesetSources`/`TilesetTargets` support exactly THREE
 * source/target kinds — a `.3tz` archive, a `.3dtiles` (sqlite) package, or a plain filesystem
 * directory (`TilesetSourceFs`/`TilesetTargetFs`) — there is no HTTP/remote source. So a REMOTE
 * tileset URL must be mirrored to a local temp directory first (see `mirrorRemoteTileset`)
 * before this can run; there's no way to point the real package at a live URL directly.
 *
 * Windows gotcha (confirmed by hand): `TilesetTargets.createAndBegin(name)` strips the trailing
 * `tileset.json` via `path.dirname()` to get the output directory, then `TilesetTargetFs.begin()`
 * ALSO runs `path.extname()`/`path.dirname()` on THAT directory name to decide if it's a
 * "directory" vs "some other named target" — if the directory's OWN name contains a literal dot
 * (e.g. "output-1.1" or "my.dataset"), `path.extname()` misreads it as a fake extension and a
 * tileset ends up written ONE LEVEL UP from the intended directory. Always hand it a dot-free
 * directory name (a plain hex hash, as used below) to sidestep this.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { TilesetOperations } from '3d-tiles-tools';

/**
 * Upgrade a LOCAL explicit tileset directory (containing tileset.json + tile content) to 3D
 * Tiles 1.1 using the real CesiumGS TilesetUpgrader. Writes into outDir (created if needed;
 * outDir's basename MUST be dot-free — see file header).
 *
 * @param {string} srcDir  local directory containing tilesetFile
 * @param {string} outDir  local directory to write the upgraded tileset + converted tiles into
 * @param {{ tilesetFile?: string, overwrite?: boolean }} [opts]
 */
export async function upgradeTilesetReal(srcDir, outDir, opts = {}) {
  const tilesetFile = opts.tilesetFile ?? 'tileset.json';
  const overwrite = opts.overwrite ?? true;
  const srcJson = path.join(srcDir, tilesetFile);
  const dstJson = path.join(outDir, 'tileset.json');
  await fs.mkdir(outDir, { recursive: true });
  await TilesetOperations.upgrade(srcJson, dstJson, overwrite, '1.1', {});
  return dstJson;
}

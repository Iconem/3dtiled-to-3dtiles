/**
 * threemx-live.js — live **Bentley/Acute3D 3MX → OGC 3D Tiles** streaming middleware.
 *
 * 3MX is a named-node mesh-pyramid DAG (not an octree), so — like the I3S/RAD adapters — it's served as
 * **lazy external-tileset fragments keyed by file path**: one `.3mxb` → one tileset.json fragment, whose
 * child `.3mxb` references become external-tileset refs fetched as the camera refines in. Geometry is
 * **OpenCTM** (decoded via the vendored js-openctm) + **JPEG** textures (passthrough); each node's
 * textured mesh is assembled into a glTF with glTF-Transform.
 *
 *   GET /stream/tileset.json?url=<Scene.3mx | root.3mxb URL>&format=threemx
 *   GET /stream/threemx/node/<encRelPath>.json?url=<master>[&ge=<error>&bb=<min,max>]   (lazy fragment for a child
 *       .3mxb; &ge and &bb are the error and the box of the tile that points here, which the fragment's root repeats)
 *   GET /stream/tile/<encRelPath>__<nodeIdx>.glb?url=<master>&format=threemx
 *
 * Master `.3mx` JSON: layers[0] = { SRS, SRSOrigin, root }. `.3mxb`: "3MXBO" + uint32LE headerSize +
 * JSON header { nodes:[{bbMin,bbMax,maxScreenDiameter,children,resources}], resources:[{id,type,format,size}] }
 * + concatenated payload buffers (sliced by resource size, in order). Child paths are relative to the
 * containing `.3mxb`'s directory → remote-friendly (we URL-join against the master's base).
 */
import { pathKey, pathOfKey } from './path-key.js';
import path from 'node:path';
import { georefFromCrs, memoizeAsync, fetchSource as fetchBuf, tilePool, runTileTaskOr, ownBytes, screenDiameterError } from '../core/index.js';
import { parse3mxb, threemxNodeGlb } from './mesh-tile.js';

const CTM_RE = /__\d+$/;
const baseOf = (u) => u.slice(0, u.lastIndexOf('/') + 1);
const joinRel = (relDir, child) => path.posix.normalize(path.posix.join(relDir, child));

// ── per-URL context (master .3mx parse → base + root rel path + georef) ─────────
// memoizeAsync caches FAILURES too — a broken source fails fast on retry (see cache.js's own comment).
const getCtx = memoizeAsync(async (url) => {
  const base = baseOf(url);
  let rootRel, transform = null;
  if (/\.3mx(\?|$)/i.test(url)) {
    const master = JSON.parse((await fetchBuf(url)).toString('utf8'));
    const layer = (master.layers || [])[0] || {};
    rootRel = layer.root;
    const origin = layer.SRSOrigin || layer.offset;
    if (layer.SRS && Array.isArray(origin)) transform = georefFromCrs(origin, layer.SRS, 'threemx-live');
  } else {
    rootRel = path.posix.basename(url);        // pointed straight at a root .3mxb (no master / SRS)
  }
  console.log(`[threemx-live] ${url} → root=${rootRel}, georef=${!!transform}`);
  return { base, rootRel, transform };
});

// 3D Tiles box [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz] from bbMin/bbMax (3MX SRS-origin-relative coords).
const boxOf = (mn, mx) => {
  const c = [0, 1, 2].map(k => (mn[k] + mx[k]) / 2), h = [0, 1, 2].map(k => Math.max((mx[k] - mn[k]) / 2, 1e-3));
  return [c[0], c[1], c[2], h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]];
};
const diagOf = (mn, mx) => Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
const num = (v) => Number(v.toPrecision(9));
/**
 * The geometric error of a 3MX node. `maxScreenDiameter` is the diameter, in pixels, that the node's bounding sphere
 * may reach on screen: past it the node is replaced by its children (0: always). A .3mxb stores no sphere, only
 * bbMin/bbMax, so the sphere is the box's, whose diameter is the box diagonal. A client with a 16 px target then
 * switches at the source's distance when
 *     geometricError = diagonal · 16 / maxScreenDiameter
 * which is OSGB's rule for a PagedLOD in pixel mode (osgb-live.js, core/geometric-error.js). A node without children
 * has error 0, as an OSGB unit without a finer file.
 */
export function threemxGeometricError(node) {
  if (!(node.children || []).length) return 0;
  return screenDiameterError(diagOf(node.bbMin, node.bbMax) / 2, node.maxScreenDiameter);
}

// ── lazy fragment: one .3mxb → a tileset.json (its nodes as children; child .3mxb → external refs) ──
// `from`: { ge, bb } of the tile that points at this file (the fragment's root repeats them, so that it is refined
// exactly when that tile is, and no node below is given a larger error than the node it refines).
async function buildFragment(ctx, relPath, masterUrl, isRoot, from = {}) {
  const above = Number.isFinite(from.ge) ? from.ge : Infinity;
  const enc = encodeURIComponent(masterUrl);
  const buf = await fetchBuf(ctx.base + relPath);
  const { nodes } = parse3mxb(buf);
  const relDir = path.posix.dirname(relPath);

  const tiles = nodes.map((node, i) => {
    const ge = num(Math.min(threemxGeometricError(node), above));
    const tile = { boundingVolume: { box: boxOf(node.bbMin, node.bbMax) }, geometricError: ge, refine: 'REPLACE' };
    // Absolute (not relative "tile/…"): this tree can be embedded at /stream/tileset.json OR nested
    // under /stream/threemx/node/<n>.json, where a relative ref would resolve against the FRAGMENT's
    // own path (…/threemx/node/tile/…) instead of /stream/tile/… — same fix RAD/I3S needed pre-simplification.
    if ((node.resources || []).length) tile.content = { uri: `/stream/tile/${pathKey(relPath)}__${i}.glb?url=${enc}&format=threemx` };
    const kids = [];
    for (const childRel of node.children || []) {
      const cr = joinRel(relDir, childRel);
      // Absolute: this fragment can be embedded at /stream/tileset.json OR nested under
      // /stream/threemx/node/<n>.json, where a relative ref would resolve wrong.
      // The finer file is another tileset. Its tile here has the box and the error of this node, and the fragment
      // answers with a root that has them too (&ge, &bb), as OSGB's does: it was half this node's error, which
      // showed the finer file only once the node was twice the size the source asks for.
      kids.push({ boundingVolume: { box: boxOf(node.bbMin, node.bbMax) }, geometricError: ge, refine: 'REPLACE',
                  content: { uri: `/stream/threemx/node/${pathKey(cr)}.json?url=${enc}&ge=${ge}&bb=${[...node.bbMin, ...node.bbMax].join(',')}` } });
    }
    if (kids.length) tile.children = kids;
    return tile;
  });

  // Wrap this file's nodes under one root tile (union box) so the fragment has a single root.
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], n.bbMin[k]); mx[k] = Math.max(mx[k], n.bbMax[k]); }
  // The root of the dataset is always refined into its nodes (an error no smaller than theirs nor than its own size);
  // the root of a finer file repeats the tile that points at it.
  const bb = from.bb?.length === 6 && from.bb.every(Number.isFinite) ? from.bb : null;
  const root = Number.isFinite(from.ge)
    ? { boundingVolume: { box: bb ? boxOf(bb.slice(0, 3), bb.slice(3)) : boxOf(mn, mx) }, geometricError: from.ge, refine: 'REPLACE', children: tiles }
    : { boundingVolume: { box: boxOf(mn, mx) }, geometricError: num(Math.max(diagOf(mn, mx) * 2, ...tiles.map((t) => t.geometricError))), refine: 'REPLACE', children: tiles };
  if (isRoot && ctx.transform) root.transform = ctx.transform;
  return { asset: { version: '1.1' }, geometricError: root.geometricError, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// ── per-node textured GLB (OpenCTM → glTF + JPEG/PNG baseColor) ──────────────────
const MESH_TASKS = new URL('./tile-tasks-mesh.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

// One node of a .3mxb → GLB: the CTM decode (LZMA) and the glTF write are in mesh-tile.js, on this thread or, with
// TILED_WORKERS, on a tile worker; a tile the workers had no memory for is built here instead (runTileTaskOr).
async function buildNodeGlb(ctx, relPath, nodeIdx) {
  const file = await fetchBuf(ctx.base + relPath);
  const here = async () => { const glb = await threemxNodeGlb(file, nodeIdx); return glb ? Buffer.from(glb) : null; };
  const pool = tilePool();
  if (!pool) return here();
  const bytes = ownBytes(file);
  const glb = await runTileTaskOr(pool, MESH_TASKS, 'threemxTileTask', { bytes, nodeIdx }, [bytes.buffer], here);
  return !glb || Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const threemxTileRe = /^.+__\d+$/;                    // <encodeURIComponent(relPath)>__<nodeIdx>
export async function threemxTileset(url) { const ctx = await getCtx(url); return buildFragment(ctx, ctx.rootRel, url, true); }
export async function threemxTile(url, key) {
  const us = key.lastIndexOf('__');
  return buildNodeGlb(await getCtx(url), pathOfKey(key.slice(0, us)), Number(key.slice(us + 2)));
}
// Lazy fragment continuation for a child .3mxb — 3MX is an arbitrary DAG (no persisted spatial index
// like RAD/I3S had), so unlike those two this genuinely can't collapse to "always eager": discovering
// the tree at all means fetching every .3mxb, which for a real city-scale model is the whole point of
// only doing it as the camera refines in. Called from stream-live.js's /stream/threemx/node/<path>.json.
export async function threemxNode(url, relPath, from = {}) { return buildFragment(await getCtx(url), relPath, url, false, from); }

// Direct /threemx/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=threemx&url=<…>
// (+ /stream/tile/…) now covers tileset/tile serving; the lazy node-fragment continuation moved to
// /stream/threemx/node/<path>.json (handled in stream-live.js). See CHANGELOG.

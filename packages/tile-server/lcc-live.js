/**
 * lcc-live.js — live **XGRIDS LCC → OGC 3D Tiles** middleware (on-the-fly, range-read tiles).
 *
 * LCC persists enough to build the tree WITHOUT decoding: `meta.lcc` carries the grid (`cellLengthX/Y`
 * + `boundingBox`) and `index.bin` packs each Unit's cell as x(low16)/y(high16) plus per-LOD
 * `{points, offset, size}` into `data.bin`. So we derive each Unit's box from its grid cell (X/Y) +
 * scene Z, and each tile range-reads just its `[offset,size)` slice of data.bin → SPZ-v2 splat GLB.
 *
 *   GET /lcc/tileset.json?url=<meta.lcc URL>
 *   GET /lcc/tile/<offset>_<size>_<points>.glb?url=<meta.lcc URL>   (run encoded in the name)
 *
 * Two source layouts, auto-detected from `url`:
 *   • Sibling files (the common case) — `url` points at meta.lcc itself; `index.bin`/`data.bin` are
 *     siblings at the same base path, range-read directly over HTTP.
 *   • Zip-packaged (`url` ends in `.zip`) — the whole LCC file set is bundled as ZIP entries (e.g.
 *     XGRIDS' own published samples). meta.lcc/index.bin are small — read whole via remote-zip's
 *     getFile(). data.bin is large and, in every sample seen so far, DEFLATE-compressed *inside* the
 *     zip (not STORED) — deflate isn't byte-seekable, so per-tile range reads into the compressed
 *     stream can't work. We fetch+inflate data.bin ONCE (cached on ctx, same lifetime as meta/index)
 *     and slice tiles out of the decompressed buffer in memory instead of re-reading over HTTP.
 */
import { lccSplatGlb } from './splat-tile.js';
import { tilePool, runTileTaskOr, ownBytes, lccGeoref, LCC_LOCAL_UPRIGHT, memoizeAsync, fetchSource as fetchBuf, fetchSourceRange } from '../core/index.js';
import { remoteZipFileSystem } from './remote-zip.js';

const ROOT_GE_FACTOR = 0.05, DEPTH_RATIO = 0.5;

// Right-handed source AABB → 3D Tiles Z-up box (RX +90°): centre (cx,cy,cz)→(cx,−cz,cy); halves y↔z.
function boundToZUpBox(min, max) {
  const cx=(min[0]+max[0])/2, cy=(min[1]+max[1])/2, cz=(min[2]+max[2])/2;
  const hx=Math.max((max[0]-min[0])/2,1e-4), hy=Math.max((max[1]-min[1])/2,1e-4), hz=Math.max((max[2]-min[2])/2,1e-4);
  return [cx, -cz, cy, hx,0,0, 0,hz,0, 0,0,hy];
}

async function rangeGet(url, begin, length) {
  try { return await fetchSourceRange(url, begin, length); }
  catch (e) {
    if (e.status === 404) e.message += " (this file doesn't exist — the LCC export at this URL is missing its required sibling data.bin, not a range-request issue)";
    throw e;
  }
}

// Build { metaBuf, indexBuf, readData } for either source layout. `readData` is an async
// (off,size)→Buffer reader over data.bin, resolved once up front so serveTileGlb doesn't need to
// know which layout it's in.
async function openSiblingSource(url) {
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  // index.bin's URL only depends on `url` itself, not on meta.lcc's PARSED contents — fetching it
  // sequentially after meta.lcc (as if it were a dependency) just adds meta.lcc's own round-trip to
  // every cold cache=none load for no reason. index.bin has no partial-read path (need the whole
  // thing up front to know where every Unit's LOD chunks live in data.bin — see the file header
  // above), so this concurrent fetch is the only real lever on that part of first-load latency.
  const [metaBuf, indexBuf] = await Promise.all([fetchBuf(url), fetchBuf(base + 'index.bin')]);
  const dataUrl = base + 'data.bin';
  return { metaBuf, indexBuf, readData: (off, size) => rangeGet(dataUrl, off, size) };
}

// Find a zip entry by basename, case-insensitively (XGRIDS' own sample zips nest everything under a
// top-level `<Name>/` dir, and casing of e.g. Index.bin/index.bin isn't guaranteed across exports).
function findEntry(names, base) {
  const name = names.find(n => n.toLowerCase().endsWith('/' + base) || n.toLowerCase() === base);
  if (!name) throw new Error(`zip has no "${base}" entry (found: ${names.join(', ')})`);
  return name;
}

async function openZipSource(url) {
  const zfs = await remoteZipFileSystem(url);
  const metaName = findEntry(zfs.names, 'meta.lcc');
  const indexName = findEntry(zfs.names, 'index.bin');
  const dataName = findEntry(zfs.names, 'data.bin');
  const [metaBuf, indexBuf] = await Promise.all([zfs.getFile(metaName), zfs.getFile(indexName)]);

  const dataInfo = await zfs.stat(dataName);
  let readData;
  if (dataInfo.method === 0) {
    // STORED in the zip — true range reads, no decompression, no full-entry fetch.
    console.log(`[lcc-live] zip ${url}: data.bin is STORED — byte-range reads`);
    readData = (off, size) => zfs.rawEntryRange(dataName, off, size);
  } else {
    // DEFLATE — not byte-seekable. Fetch + inflate the whole entry once, cache it on this ctx, and
    // slice tiles out of the in-memory decompressed buffer. Honest one-time cost instead of a fake
    // "range read" that would actually re-fetch/re-inflate on every tile.
    console.log(`[lcc-live] zip ${url}: data.bin is DEFLATE (${dataInfo.compressedSize} → ${dataInfo.uncompressedSize} bytes) — decompressing once…`);
    const t0 = Date.now();
    const full = await zfs.getFullDecompressed(dataName);
    console.log(`[lcc-live] zip ${url}: data.bin decompressed in ${Date.now() - t0}ms`);
    readData = async (off, size) => full.subarray(off, off + size);
  }
  return { metaBuf, indexBuf, readData };
}

// Per-URL context: meta.lcc + index.bin parsed into per-Unit grid boxes + per-LOD runs. memoizeAsync
// caches FAILURES too — a broken source fails fast on retry (see cache.js's own comment).
const getCtx = memoizeAsync(async (url) => {
  const { metaBuf, indexBuf, readData } = /\.zip(\?|$)/i.test(url) ? await openZipSource(url) : await openSiblingSource(url);
  const meta = JSON.parse(metaBuf.toString('utf8'));
  const scaleAttr = (meta.attributes || []).find(a => a.name === 'scale');
  if (!scaleAttr) throw new Error('meta.lcc missing attributes.scale min/max');
  const { indexDataSize } = meta, levelsInIndex = (indexDataSize - 4) / 16;
  const numUnits = indexBuf.length / indexDataSize;
  const bb = meta.boundingBox, cellX = meta.cellLengthX, cellY = meta.cellLengthY;

  const units = [];                                       // { box, lods:[{level,pts,off,size}] }
  for (let u = 0; u < numUnits; u++) {
    const b = u * indexDataSize;
    const idx = indexBuf.readUInt32LE(b);
    const cx = idx & 0xFFFF, cy = (idx >>> 16) & 0xFFFF;
    const min = [bb.min[0] + cx*cellX, bb.min[1] + cy*cellY, bb.min[2]];
    const max = [min[0] + cellX, min[1] + cellY, bb.max[2]];
    const lods = [];
    for (let L = 0; L < levelsInIndex; L++) {
      const r = b + 4 + L*16;
      const pts = indexBuf.readUInt32LE(r), off = Number(indexBuf.readBigUInt64LE(r + 4)), size = indexBuf.readUInt32LE(r + 12);
      if (pts > 0 && size > 0) lods.push({ level: L, pts, off, size });
    }
    if (lods.length) units.push({ box: boundToZUpBox(min, max), lods });
  }
  const diag = Math.hypot(bb.max[0]-bb.min[0], bb.max[1]-bb.min[1], bb.max[2]-bb.min[2]) || 1;
  const geo = lccGeoref(meta, 'lcc-live');
  const transform = geo || LCC_LOCAL_UPRIGHT;   // no usable EPSG → still flip upright, just not geolocated
  console.log(`[lcc-live] ${url} → ${units.length} units, georef=${!!geo}${meta.epsg ? ' (EPSG:'+meta.epsg+')' : ' (local upright, no EPSG)'}`);
  return { readData, units, scaleMin: scaleAttr.min, scaleMax: scaleAttr.max, sceneBox: boundToZUpBox(bb.min, bb.max), rootGE: diag * ROOT_GE_FACTOR, transform };
});

function buildTileset(ctx, urlParam, centroids = false) {
  const enc = encodeURIComponent(urlParam);
  const geAt = d => ctx.rootGE * Math.pow(DEPTH_RATIO, d);
  const children = [];
  for (const unit of ctx.units) {
    const maxL = unit.lods[unit.lods.length - 1].level;
    let child = null;                                     // nest coarsest (outer) → finest (inner), REPLACE
    for (const { level, pts, off, size } of unit.lods) {  // ascending level (0 = finest)
      const tile = { boundingVolume: { box: unit.box }, geometricError: geAt(maxL - level), refine: 'REPLACE', content: { uri: `tile/${off}_${size}_${pts}.glb?url=${enc}` } };
      if (child) tile.children = [child];
      child = tile;
    }
    children.push(child);
  }
  const root = { boundingVolume: { box: ctx.sceneBox }, geometricError: ctx.rootGE * 2, refine: 'REPLACE', children };
  if (ctx.transform) root.transform = ctx.transform;        // ENU→ECEF placement from meta.lcc epsg+offset
  const ts = { asset: { version: '1.1' }, geometricError: ctx.rootGE * 2, root, extensionsUsed: ['3DTILES_content_gltf'] };
  // centroids mode emits glTF POINTS tiles → do NOT advertise the gaussian-splatting extension.
  if (!centroids) ts.extensions = { '3DTILES_content_gltf': {
    extensionsUsed: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
  }};
  return ts;
}

const SPLAT_TASKS = new URL('./tile-tasks-splats.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

async function serveTileGlb(ctx, off, size, pts, centroids = false) {
  const buf = await ctx.readData(off, size);
  const here = async () => Buffer.from(await lccSplatGlb(buf, pts, ctx.scaleMin, ctx.scaleMax, centroids));
  const pool = tilePool();
  if (!pool) return here();
  // TILED_WORKERS: a worker decodes the splats and encodes the GLB; a tile it had no memory for is built here instead.
  const bytes = ownBytes(buf);
  const glb = await runTileTaskOr(pool, SPLAT_TASKS, 'lccTileTask', { buf: bytes, pts, scaleMin: ctx.scaleMin, scaleMax: ctx.scaleMax, centroids }, [bytes.buffer], here);
  return Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Pure builders for the /stream dispatcher.
export const lccTileRe = /^\d+_\d+_\d+$/;
// hierarchy/prefetch are no-ops (LCC's unit grid lives in one index.bin — monolithic flat index,
// cache=none ≡ cache=hierarchy; cache=full routes to /convert). `centroids` → POINTS preview.
export async function lccTileset(url, opts = {}) { return buildTileset(await getCtx(url), url, opts.centroids); }
export async function lccTile(url, key, opts = {}) { const [o, s, p] = key.split('_').map(Number); return serveTileGlb(await getCtx(url), o, s, p, opts.centroids); }

// Direct /lcc/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=lcc&url=<…> (+
// /stream/tile/…) already cover every case these exposed. See CHANGELOG.

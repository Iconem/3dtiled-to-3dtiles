/**
 * extract-core.js — **crop and extract from any 3D Tiles tileset**, the part that is the same on the server and in a
 * browser: walk the tileset, keep what is inside a geographic box, write a LAS, a merged GLB, a splat file or a zip of
 * the tiles.
 *
 * No Node imports and no Buffer. Everything that differs between the two environments is handed in (`deps`):
 *   fetchBytes(url) → Uint8Array            how a tileset, a subtree or a tile is fetched
 *   readGlb(bytes)  → glTF-Transform Document   NodeIO after the server's decompress, or WebIO with its decoders
 *   Document                                  glTF-Transform's class, to build the merged GLB
 *   splat                                     @playcanvas/splat-transform's module
 * and the output goes to a `sink` ({ write(bytes), rewrite?(position, bytes) }): an HTTP response, a file handle, a
 * browser's file stream or a list of chunks.
 *
 * The tile server's /extract routes (tile-server/extract-live.js) and the viewer's "in the browser" extract
 * (apps/viewer/src/lib/browserExtract.ts) are both thin callers of this module. A tile that cannot be fetched or
 * read is skipped, and reported through `onSkip(tileUrl, error)` when given; a cancelled `signal` stops the walk.
 *
 * `bb` is GEOGRAPHIC: [west°, south°, minH m, east°, north°, maxH m], optionally turned about its centre
 * (`orientBox(bb, heading)`: an oriented box, for a street or a building that does not run north-south). The walk honours each tile's refine: **ADD**
 * tiles contribute at every level down to `maxGE`; **REPLACE** tiles only at the refinement frontier (geometric error
 * ≤ maxGE, or a leaf). Explicit children, external tilesets and implicit tilings are followed.
 */
import { llhToEcef, ecefToLlh, enuFrame } from './ecef.js';
import { lasHeaderBytes, writeLasRecord, LAS_RECORD_LEN } from './las-format.js';

export const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
// 3D Tiles glTF content is Y-up; Cesium applies RX(+90): (x,y,z)→(x,−z,y). `YUP_ZUP` is that matrix (verified against
// a real `Cesium.Axis.Y_UP_TO_Z_UP`), `YUP_ZUP_P90` its inverse, (x,y,z)→(x,z,−y).
export const YUP_ZUP     = [1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1];
export const YUP_ZUP_P90 = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];
const R2D = 180 / Math.PI;

/** Column-major 4×4 product a·b. */
export function matMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
  return o;
}
export const xform = (m, x, y, z) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];

const decoder = new TextDecoder();
const text = (bytes) => decoder.decode(bytes);
const bytesOf = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const viewOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const absUrl = (uri, base) => (/^https?:/i.test(uri) ? uri : new URL(uri, base).href);
const isJsonUri = (uri) => /\.json(\?|$)/i.test(uri || '');
/** Is a point (degrees, metres) inside the box? An oriented box (`orientBox`) is tested in its own turned axes. */
export function inBbox(lon, lat, h, bb) {
  if (h < bb[2] || h > bb[5]) return false;
  const r = bb.rot;
  if (!r) return lon >= bb[0] && lon <= bb[3] && lat >= bb[1] && lat <= bb[4];
  const de = (lon - r.lon) * r.mLon, dn = (lat - r.lat) * r.mLat;        // metres east and north of the centre
  return Math.abs(de * r.cos - dn * r.sin) <= r.halfE && Math.abs(de * r.sin + dn * r.cos) <= r.halfN;
}
// the lon/lat box that encloses an oriented one (`bb.outer`) is what whole tiles are tested against
const overlap = (mn, mx, box) => { const bb = box.outer ?? box; return mx[0] >= bb[0] && mn[0] <= bb[3] && mx[1] >= bb[1] && mn[1] <= bb[4] && mx[2] >= bb[2] && mn[2] <= bb[5]; };

const EARTH_R = 6378137;
/**
 * Turn a box about its centre: `heading` degrees clockwise from north, as a compass reads. The six numbers keep
 * their meaning (the box before it is turned: its centre, and its size east-west and north-south in metres at that
 * latitude); the turned box is what `inBbox` then tests. 0, or nothing, leaves the plain lon/lat box.
 * @param {number[]} bb  [west°, south°, minH, east°, north°, maxH]
 * @param {number} [heading]  degrees
 * @returns {number[]} `bb` itself, with `rot` and `outer` set when turned
 */
export function orientBox(bb, heading) {
  const h = Number(heading) || 0;
  delete bb.rot; delete bb.outer;
  if (!(Math.abs(h % 360) > 1e-9)) return bb;
  const lon = (bb[0] + bb[3]) / 2, lat = (bb[1] + bb[4]) / 2, a = h / R2D;
  const mLat = EARTH_R / R2D, mLon = mLat * Math.max(0.01, Math.cos(lat / R2D));
  const halfE = (bb[3] - bb[0]) / 2 * mLon, halfN = (bb[4] - bb[1]) / 2 * mLat, cos = Math.cos(a), sin = Math.sin(a);
  bb.rot = { heading: h, lon, lat, mLon, mLat, halfE, halfN, cos, sin };
  // corners: u along the turned east axis (cos, −sin), v along the turned north axis (sin, cos), in (east, north)
  const ext = (ax, ay) => Math.abs(halfE * ax) + Math.abs(halfN * ay);
  const dE = ext(cos, sin), dN = ext(sin, cos);
  bb.outer = [lon - dE / mLon, lat - dN / mLat, bb[2], lon + dE / mLon, lat + dN / mLat, bb[5]];
  return bb;
}
const checkAbort = (signal) => { if (signal?.aborted) throw signal.reason ?? new Error('extract cancelled'); };

/** `bbox=w,s,minH,e,n,maxH` → six numbers, or null when it is not that. */
export function parseBbox(str) {
  const bb = String(str ?? '').split(',').map(Number);
  return bb.length === 6 && !bb.some(Number.isNaN) ? bb : null;
}

/**
 * Optional ECEF → local-ENU projection (East/North/Up metres at the box centre). The default LAS is ECEF (EPSG:4978);
 * `enu` gives a usable local metric frame instead of a global geocentric one.
 */
export function makeProject(bb, enu) {
  if (!enu) return { proj: (X, Y, Z) => [X, Y, Z], offset: llhToEcef((bb[0]+bb[3])/2, (bb[1]+bb[4])/2, (bb[2]+bb[5])/2) };
  const cLon = (bb[0]+bb[3])/2, cLat = (bb[1]+bb[4])/2, c = llhToEcef(cLon, cLat, (bb[2]+bb[5])/2);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(cLon, cLat);
  return { proj: (X, Y, Z) => { const dx = X-c[0], dy = Y-c[1], dz = Z-c[2];
    return [dx*E[0]+dy*E[1]+dz*E[2], dx*N[0]+dy*N[1]+dz*N[2], dx*U[0]+dy*U[1]+dz*U[2]]; }, offset: [0, 0, 0] };
}

// ── the walk ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Does a tile's bounding volume (geographic, after its world transform `m`) intersect the box? Essential pruning:
// without it the whole tileset is walked. Handles `region` (cartographic) and `box`.
export function tileIntersects(node, m, bb) {
  const bv = node.boundingVolume; if (!bv) return true;     // no bv → can't prune, descend
  if (bv.region) {
    const [w, s, e, n, mnh, mxh] = bv.region;
    return overlap([w * R2D, s * R2D, mnh], [e * R2D, n * R2D, mxh], bb);
  }
  if (bv.box) {
    const c = bv.box, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
      const lx = c[0] + sx*c[3] + sy*c[6] + sz*c[9], ly = c[1] + sx*c[4] + sy*c[7] + sz*c[10], lz = c[2] + sx*c[5] + sy*c[8] + sz*c[11];
      const w = xform(m, lx, ly, lz), ll = ecefToLlh(w[0], w[1], w[2]);
      for (let k = 0; k < 3; k++) { if (ll[k] < mn[k]) mn[k] = ll[k]; if (ll[k] > mx[k]) mx[k] = ll[k]; }
    }
    return overlap(mn, mx, bb);
  }
  return true;
}

// A 3D Tiles 1.1 subtree, binary or JSON → its availability accessors. The same reading as core/tiling.js's
// loadSubtree, on plain Uint8Arrays so that a browser runs it too.
async function readSubtree(buf, fetchBuffer) {
  const b = bytesOf(buf);
  let json, bin = null;
  if (b[0] === 0x73 && b[1] === 0x75 && b[2] === 0x62 && b[3] === 0x74) {            // 'subt'
    const jsonLen = Number(viewOf(b).getBigUint64(8, true));
    json = JSON.parse(text(b.subarray(24, 24 + jsonLen))); bin = b.subarray(24 + jsonLen);
  } else json = JSON.parse(text(b));
  const buffers = json.buffers ?? [], views = json.bufferViews ?? [];
  const viewIndex = (a) => (a && a.constant === undefined ? a.bitstream ?? a.bufferView : null);
  const content0 = Array.isArray(json.contentAvailability) ? json.contentAvailability[0] : json.contentAvailability;
  const used = new Set();
  for (const a of [json.tileAvailability, content0, json.childSubtreeAvailability]) { const v = views[viewIndex(a)]; if (v) used.add(v.buffer ?? 0); }
  const external = await Promise.all(buffers.map(async (bf, i) => (bf.uri != null && used.has(i) ? bytesOf(await fetchBuffer(bf.uri)) : null)));
  const accessor = (avail) => {
    if (!avail) return () => 0;
    if (avail.constant !== undefined) return () => (avail.constant ? 1 : 0);
    const bv = views[viewIndex(avail)]; if (!bv) return () => 0;
    const data = buffers[bv.buffer ?? 0]?.uri != null ? external[bv.buffer ?? 0] : bin;
    if (!data) return () => 0;
    const bits = data.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    return (i) => (bits[i >> 3] >> (i & 7)) & 1;
  };
  return { tileBit: accessor(json.tileAvailability), contentBit: accessor(content0), childBit: accessor(json.childSubtreeAvailability) };
}

const morton = (dims, co) => { let m = 0; for (let i = 0; i < 16; i++) for (let d = 0; d < dims; d++) m |= ((co[d] >> i) & 1) << (dims * i + d); return m; };
const subst = (tpl, l, x, y, z) => tpl.replace(/\{level\}/g, l).replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{z\}/g, z);
// axis-aligned sub-box of `rootBox` at implicit coord (level,x,y[,z]).
function cellBox(rootBox, level, x, y, z, dims) {
  const n = 2 ** level, hx = rootBox[3], hy = rootBox[7], hz = rootBox[11];
  const sx = 2*hx/n, sy = 2*hy/n, sz = 2*hz/n;
  const ccx = rootBox[0]-hx + (x+0.5)*sx, ccy = rootBox[1]-hy + (y+0.5)*sy, ccz = dims === 3 ? rootBox[2]-hz + (z+0.5)*sz : rootBox[2];
  return [ccx, ccy, ccz, sx/2,0,0, 0,sy/2,0, 0,0, dims === 3 ? sz/2 : hz];
}
async function expandImplicit(node, worldM, base, bb, o, onContent) {
  const { maxGE, maxDepth, fetchBytes, signal } = o;
  const it = node.implicitTiling, dims = it.subdivisionScheme === 'OCTREE' ? 3 : 2, SL = it.subtreeLevels;
  const rootGE = node.geometricError ?? 0, rootBox = node.boundingVolume?.box, contentTpl = node.content?.uri, subTpl = it.subtrees?.uri;
  if (!rootBox || !contentTpl || !subTpl) return;
  const add = (node.refine || 'REPLACE').toUpperCase() === 'ADD', cells = (2 ** dims), cache = new Map();
  const getSub = async (l, x, y, z) => { const k = `${l}-${x}-${y}-${z}`; if (cache.has(k)) return cache.get(k);
    let s = null; const subUrl = absUrl(subst(subTpl, l, x, y, z), base);
    try { s = await readSubtree(await fetchBytes(subUrl), (uri) => fetchBytes(absUrl(uri, subUrl))); } catch {} cache.set(k, s); return s; };
  const walk = async (level, x, y, z) => {
    if (level > maxDepth) return;
    checkAbort(signal);
    const sroot = Math.floor(level / SL) * SL, d = level - sroot;
    const sub = await getSub(sroot, x >> d, y >> d, dims === 3 ? z >> d : 0); if (!sub) return;
    const lx = x & ((1 << d) - 1), ly = y & ((1 << d) - 1), lz = dims === 3 ? z & ((1 << d) - 1) : 0;
    const tIdx = (cells ** d - 1) / (cells - 1) + morton(dims, dims === 3 ? [lx, ly, lz] : [lx, ly]);
    if (!sub.tileBit(tIdx)) return;
    const box = cellBox(rootBox, level, x, y, z, dims);
    if (!tileIntersects({ boundingVolume: { box } }, worldM, bb)) return;
    const descend = rootGE / 2 ** level > maxGE && level < maxDepth;
    if (sub.contentBit(tIdx) && (add || !descend)) await onContent(absUrl(subst(contentTpl, level, x, y, z), base), worldM, { boundingVolume: { box } });
    if (!descend) return;
    for (let i = 0; i < cells; i++) await walk(level + 1, x*2 + (i&1), y*2 + ((i>>1)&1), dims === 3 ? z*2 + ((i>>2)&1) : 0);
  };
  await walk(0, 0, 0, 0);
}

/**
 * Walk a tileset; call `onContent(tileUrl, worldMatrix, node)` for each content tile to harvest, in tree order.
 * @param {string} tilesetUrl
 * @param {number[]} bb  the geographic box
 * @param {{maxGE?:number, maxDepth?:number, initM?:number[], fetchBytes:(url:string)=>Promise<Uint8Array>, signal?:AbortSignal}} o
 *        `initM` (column-major 4×4) seeds the world chain: the viewer's extra model matrix (height nudge, placement
 *        of a local scene), so the extract lands where the data is on screen
 * @param {(url:string, worldM:number[], node:object)=>Promise<void>|void} onContent
 */
export async function walkTileset(tilesetUrl, bb, o, onContent) {
  const { maxGE = 0, maxDepth = 99, initM = IDENT, fetchBytes, signal } = o;
  const opts = { maxGE, maxDepth, fetchBytes, signal };
  const ts = JSON.parse(text(await fetchBytes(tilesetUrl)));
  const root = ts.root; if (!root) return;
  const recur = async (node, parentM, base, depth) => {
    if (!node || depth > maxDepth) return;
    checkAbort(signal);
    const m = node.transform ? matMul(parentM, node.transform) : parentM;
    if (!tileIntersects(node, m, bb)) return;               // prune: skip subtrees outside the box
    if (node.implicitTiling) return expandImplicit(node, m, base, bb, opts, onContent);
    const ge = node.geometricError ?? 0;
    const isJsonContent = node.content && isJsonUri(node.content.uri);
    const hasContent = node.content && !isJsonContent;
    const hasKids = (node.children && node.children.length) || isJsonContent;
    // Descend while finer than maxGE, OR while this branch hasn't hit content yet (Bing/sparse trees have
    // content-less coarse tiles: without this, a coarse maxGE stops above the content and yields nothing).
    const descend = hasKids && (ge > maxGE || !hasContent);
    const refine = (node.refine || 'REPLACE').toUpperCase();
    const takeContent = hasContent && (refine === 'ADD' || !descend);  // ADD: every level; REPLACE: frontier
    if (takeContent) await onContent(absUrl(node.content.uri, base), m, node);
    if (!descend) return;
    if (isJsonContent) {                                     // external tileset as content → recurse into it
      const childUrl = absUrl(node.content.uri, base);
      const cts = JSON.parse(text(await fetchBytes(childUrl)));
      if (cts.root) await recur(cts.root, m, childUrl, depth + 1);
    }
    for (const c of node.children || []) await recur(c, m, base, depth + 1);
  };
  await recur(root, initM, tilesetUrl, 0);
}

// ECEF position of the SOURCE tileset's own origin (root bounding-volume centre), seeded with the same initM the
// extract uses. A STABLE output frame for splats: every crop of one source shares one coordinate system.
async function rootOriginEcef(tilesetUrl, initM, fetchBytes) {
  try {
    const ts = JSON.parse(text(await fetchBytes(tilesetUrl)));
    const root = ts.root; if (!root) return null;
    const m = root.transform ? matMul(initM, root.transform) : initM;
    const bv = root.boundingVolume;
    if (bv?.box) return xform(m, bv.box[0], bv.box[1], bv.box[2]);                 // box centre (tile-local → ECEF)
    if (bv?.region) { const [w, s, e, n, mn, mx] = bv.region; return llhToEcef((w+e)/2*R2D, (s+n)/2*R2D, (mn+mx)/2); }
    return xform(m, 0, 0, 0);                                                       // fallback: transformed origin
  } catch { return null; }
}

const cropRoot = (box, children) => { const bb = box.outer ?? box; return { asset: { version: '1.1' }, geometricError: 1e7,
  root: { boundingVolume: { region: [bb[0]/R2D, bb[1]/R2D, bb[3]/R2D, bb[4]/R2D, bb[2], bb[5]] }, geometricError: 1e7, refine: 'ADD', children } }; };
const UNIT_BOX = [0,0,0, 1,0,0, 0,1,0, 0,0,1];

// ── cropped tileset (JSON only, tiles left where they are) ────────────────────────────────────────────────────────

/** A tileset of the tiles that touch the box, each with its world transform and pointing at the original tile. */
export async function extractTilesetJson(o) {
  const children = [];
  await walkTileset(o.url, o.bb, { ...o, fetchBytes: o.deps.fetchBytes }, (tileUrl, worldM, node) => {
    children.push({ transform: Array.from(worldM), boundingVolume: { box: node?.boundingVolume?.box || UNIT_BOX }, geometricError: 0, refine: 'ADD', content: { uri: tileUrl } });
  });
  return { tileset: cropRoot(o.bb, children), tiles: children.length };
}

// ── zip of untouched tiles ────────────────────────────────────────────────────────────────────────────────────────

let crcTable = null;
/** CRC-32 (the ZIP one) of bytes. */
export function crc32(u8) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A STORE-mode (no compression) ZIP written as it goes: each entry's data is in hand before add(), so its crc and
 * size are in the local header. Tiles are already compressed, so storing is right. An entry is one tile, under
 * 4 GB; the archive may be larger and hold more than 65 535 of them: an entry that starts past 4 GB carries its
 * offset in a ZIP64 extra field, and the archive then ends with the ZIP64 end records (what 7-Zip, Windows, unzip
 * 6 and Python read). An archive under both limits is byte for byte the plain ZIP it was.
 * @param {(bytes:Uint8Array)=>Promise<void>|void} write
 */
export function zipStore(write) {
  const entries = []; let offset = 0;
  const enc = new TextEncoder();
  const w = async (buf) => { await write(buf); offset += buf.length; };
  return {
    async add(name, data) {
      const nameBuf = enc.encode(name), crc = crc32(data), size = data.length, localOffset = offset;
      const lh = new Uint8Array(30), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(6, 0, true);     // sig, ver, flags+method(store)
      v.setUint32(10, 0, true); v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true);
      v.setUint16(26, nameBuf.length, true); v.setUint16(28, 0, true);
      await w(lh); await w(nameBuf); await w(data);
      entries.push({ nameBuf, crc, size, localOffset });
    },
    async end() {
      const cdStart = offset, MAX32 = 0xffffffff;
      for (const e of entries) {
        const far = e.localOffset >= MAX32;                  // its offset does not fit 32 bits: a ZIP64 extra field
        const c = new Uint8Array(46 + (far ? 12 : 0)), v = new DataView(c.buffer);
        v.setUint32(0, 0x02014b50, true); v.setUint16(4, far ? 45 : 20, true); v.setUint16(6, far ? 45 : 20, true); v.setUint32(8, 0, true);
        v.setUint32(12, 0, true); v.setUint32(16, e.crc, true); v.setUint32(20, e.size, true); v.setUint32(24, e.size, true);
        v.setUint16(28, e.nameBuf.length, true); v.setUint16(30, far ? 12 : 0, true); v.setUint16(32, 0, true); v.setUint32(34, 0, true); v.setUint32(38, 0, true);
        v.setUint32(42, far ? MAX32 : e.localOffset, true);
        await w(c.subarray(0, 46)); await w(e.nameBuf);
        if (far) { v.setUint16(46, 0x0001, true); v.setUint16(48, 8, true); v.setBigUint64(50, BigInt(e.localOffset), true); await w(c.subarray(46)); }
      }
      const cdSize = offset - cdStart;
      const zip64 = entries.length > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      if (zip64) {
        const z = new Uint8Array(56 + 20), v = new DataView(z.buffer), at = offset;
        v.setUint32(0, 0x06064b50, true); v.setBigUint64(4, 44n, true); v.setUint16(12, 45, true); v.setUint16(14, 45, true);   // ZIP64 end of central directory
        v.setUint32(16, 0, true); v.setUint32(20, 0, true);
        v.setBigUint64(24, BigInt(entries.length), true); v.setBigUint64(32, BigInt(entries.length), true);
        v.setBigUint64(40, BigInt(cdSize), true); v.setBigUint64(48, BigInt(cdStart), true);
        v.setUint32(56, 0x07064b50, true); v.setUint32(60, 0, true); v.setBigUint64(64, BigInt(at), true); v.setUint32(72, 1, true);   // its locator
        await w(z);
      }
      const eocd = new Uint8Array(22), v = new DataView(eocd.buffer);
      v.setUint32(0, 0x06054b50, true); v.setUint16(4, 0, true); v.setUint16(6, 0, true);
      v.setUint16(8, Math.min(entries.length, 0xffff), true); v.setUint16(10, Math.min(entries.length, 0xffff), true);
      v.setUint32(12, Math.min(cdSize, MAX32), true); v.setUint32(16, Math.min(cdStart, MAX32), true); v.setUint16(20, 0, true);
      await w(eocd);
      return { entries: entries.length, bytes: offset, zip64 };
    },
  };
}

/**
 * The tiles that touch the box, untouched, with a tileset.json that places them: one zip, one tile in memory at a time.
 * Works for meshes, points and splats alike, since nothing is decoded.
 * @returns {Promise<{tiles:number, bytes:number}>}
 */
export async function extractZip(o, sink) {
  const zip = zipStore((b) => sink.write(b)); const children = []; let i = 0;
  await walkTileset(o.url, o.bb, { ...o, fetchBytes: o.deps.fetchBytes }, async (tileUrl, worldM, node) => {
    const name = `tiles/tile_${i++}.glb`;
    try { await zip.add(name, bytesOf(await o.deps.fetchBytes(tileUrl))); } catch (e) { o.onSkip?.(tileUrl, e); return; }   // one tile in RAM at a time
    children.push({ transform: Array.from(worldM), boundingVolume: { box: node?.boundingVolume?.box || UNIT_BOX }, geometricError: 0, refine: 'ADD', content: { uri: name } });
    o.onProgress?.({ tiles: children.length });
  });
  await zip.add('tileset.json', new TextEncoder().encode(JSON.stringify(cropRoot(o.bb, children))));
  const { bytes } = await zip.end();
  return { tiles: children.length, bytes };
}

// ── points → LAS ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The points of one tile that are inside the box, as LAS records (ECEF, or the local frame of `las.proj`).
 * Every POSITION accessor counts, whatever the primitive's mode: a mesh's vertices are points too.
 * @param {object} doc     the tile, a glTF-Transform Document
 * @param {number[]} worldM the tile's world matrix
 * @param {{proj:Function, scale:number[], offset:number[], stats:{count:number, min:number[], max:number[]}, countOnly?:boolean}} las
 *        `stats` is updated; with `countOnly` nothing is written
 * @returns {Uint8Array|null} the records
 */
export function tilePointRecords(doc, worldM, bb, las) {
  const { proj, scale, offset, stats, countOnly = false } = las;
  const chunks = []; let total = 0;
  const p = [0, 0, 0], c = [0, 0, 0, 1];
  const root = doc.getRoot(), nodes = root.listNodes();
  for (const mesh of root.listMeshes()) {
    const node = nodes.find((nd) => nd.getMesh() === mesh);
    const M = matMul(matMul(worldM, YUP_ZUP), node ? node.getWorldMatrix() : IDENT);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const col = prim.getAttribute('COLOR_0'), n = pos.getCount();
      const s = col ? (col.getNormalized() ? 65535 : 257) : 0;
      const out = countOnly ? null : new Uint8Array(n * LAS_RECORD_LEN), view = out ? new DataView(out.buffer) : null;
      let o = 0;
      for (let i = 0; i < n; i++) {
        pos.getElement(i, p);
        const X = M[0]*p[0]+M[4]*p[1]+M[8]*p[2]+M[12], Y = M[1]*p[0]+M[5]*p[1]+M[9]*p[2]+M[13], Z = M[2]*p[0]+M[6]*p[1]+M[10]*p[2]+M[14];
        const ll = ecefToLlh(X, Y, Z); if (!inBbox(ll[0], ll[1], ll[2], bb)) continue;
        const q = proj(X, Y, Z);
        stats.count++;
        for (let k = 0; k < 3; k++) { if (q[k] < stats.min[k]) stats.min[k] = q[k]; if (q[k] > stats.max[k]) stats.max[k] = q[k]; }
        if (!out) continue;
        let r = 0, g = 0, b = 0;
        if (col) { c[0] = 0; c[1] = 0; c[2] = 0; col.getElement(i, c); r = (c[0]*s)|0; g = (c[1]*s)|0; b = (c[2]*s)|0; }
        writeLasRecord(view, o, Math.round((q[0] - offset[0]) / scale[0]), Math.round((q[1] - offset[1]) / scale[1]), Math.round((q[2] - offset[2]) / scale[2]), 0, r, g, b);
        o += LAS_RECORD_LEN;
      }
      if (o) { chunks.push(out.subarray(0, o)); total += o; }
    }
  }
  if (!total) return null;
  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(total); let at = 0;
  for (const ch of chunks) { all.set(ch, at); at += ch.length; }
  return all;
}

const newStats = () => ({ count: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

/**
 * The points inside the box → a LAS 1.4 file, written tile by tile: memory stays one tile whatever the size.
 *
 * The header holds the point count and the bounds, known only at the end. With a sink that can `rewrite`, it is
 * written first as a placeholder and again at the end (one walk). Without, or with `twoPass`, the tileset is walked
 * twice: once to count, once to write.
 * @param {{url:string, bb:number[], maxGE?:number, maxDepth?:number, initM?:number[], enu?:boolean, twoPass?:boolean,
 *          deps:{fetchBytes:Function, readGlb:Function}, signal?:AbortSignal, onProgress?:Function, onCounted?:Function}} o
 *        `onCounted({points})` is called before the first byte of a two-pass run (an HTTP response's headers)
 * @param {{write:(bytes:Uint8Array)=>Promise<void>|void, rewrite?:(position:number, bytes:Uint8Array)=>Promise<void>|void}} sink
 * @returns {Promise<{points:number, tiles:number, bbox:{min:number[], max:number[]}|null}>}
 */
export async function extractLas(o, sink) {
  const scale = [0.001, 0.001, 0.001], { proj, offset } = makeProject(o.bb, o.enu);
  const walkOpts = { ...o, fetchBytes: o.deps.fetchBytes };
  let tiles = 0;
  const pass = async (stats, countOnly) => {
    tiles = 0;
    await walkTileset(o.url, o.bb, walkOpts, async (tileUrl, worldM) => {
      let doc; try { doc = await o.deps.readGlb(await o.deps.fetchBytes(tileUrl)); } catch (e) { if (!countOnly) o.onSkip?.(tileUrl, e); return; }
      tiles++;
      const records = tilePointRecords(doc, worldM, o.bb, { proj, scale, offset, stats, countOnly });
      if (records) await sink.write(records);
      o.onProgress?.({ tiles, points: stats.count, pass: countOnly ? 'count' : 'write' });
    });
  };
  const header = (stats) => lasHeaderBytes({ scale, offset, count: stats.count, bbox: stats.count ? { min: stats.min, max: stats.max } : null });
  const stats = newStats();
  if (o.twoPass || !sink.rewrite) {
    await pass(stats, true);
    await o.onCounted?.({ points: stats.count });
    await sink.write(header(stats));
    await pass(newStats(), false);
  } else {
    await sink.write(lasHeaderBytes({ scale, offset }));     // placeholder
    await pass(stats, false);
    await sink.rewrite(0, header(stats));
  }
  return { points: stats.count, tiles, bbox: stats.count ? { min: stats.min, max: stats.max } : null };
}

// ── meshes → one GLB ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Merge the triangle primitives that touch the box into one glTF-Transform Document, vertices in ECEF, each keeping
 * its UVs and base-colour texture (copied as it is, not re-encoded).
 * @param {{url:string, bb:number[], maxGE?:number, maxDepth?:number, initM?:number[],
 *          deps:{fetchBytes:Function, readGlb:Function, Document:Function, onTexture?:(out:object, mimeType:string)=>void},
 *          signal?:AbortSignal, onProgress?:Function}} o
 *        `deps.onTexture` lets the caller declare an extension the copied texture needs (KTX2, WebP)
 * @returns {Promise<{document:object, primitives:number, tiles:number}>}
 */
export async function extractMeshDocument(o) {
  const out = new o.deps.Document();
  const outBuf = out.createBuffer(), outScene = out.createScene();
  let tiles = 0, prims = 0;
  const p = [0, 0, 0];
  await walkTileset(o.url, o.bb, { ...o, fetchBytes: o.deps.fetchBytes }, async (tileUrl, worldM) => {
    let doc; try { doc = await o.deps.readGlb(await o.deps.fetchBytes(tileUrl)); } catch (e) { o.onSkip?.(tileUrl, e); return; }
    tiles++;
    const root = doc.getRoot(), nodes = root.listNodes();
    for (const mesh of root.listMeshes()) {
      // node matrix for this mesh (first referencing node) × tile world × Y-up→Z-up
      const node = nodes.find((n) => n.getMesh() === mesh);
      const M = matMul(matMul(worldM, YUP_ZUP), node ? node.getWorldMatrix() : IDENT);
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION'); if (!pos) continue;
        const mode = prim.getMode();                         // 0=POINTS, 4=TRIANGLES
        if (!(mode === 4 || mode === undefined)) continue;
        const n = pos.getCount();
        const posArr = new Float32Array(n * 3); let any = false;
        for (let i = 0; i < n; i++) { pos.getElement(i, p); const w = xform(M, p[0], p[1], p[2]);
          const ll = ecefToLlh(w[0], w[1], w[2]); if (inBbox(ll[0], ll[1], ll[2], o.bb)) any = true;
          posArr[i*3]=w[0]; posArr[i*3+1]=w[1]; posArr[i*3+2]=w[2]; }
        if (!any) continue;                                  // primitive entirely outside the box
        const np = out.createPrimitive().setMode(4)
          .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(posArr).setBuffer(outBuf));
        const idx = prim.getIndices(); if (idx) np.setIndices(out.createAccessor().setType('SCALAR').setArray(Uint32Array.from(idx.getArray())).setBuffer(outBuf));
        const uv = prim.getAttribute('TEXCOORD_0');
        const mat = prim.getMaterial();
        if (uv && mat?.getBaseColorTexture()) {
          // UVs through getElement: a quantized (normalized integer) accessor comes out as the 0..1 values it stands for
          const uvArr = new Float32Array(n * 2), t = [0, 0];
          if (uv.getNormalized()) for (let i = 0; i < n; i++) { uv.getElement(i, t); uvArr[i*2] = t[0]; uvArr[i*2+1] = t[1]; }
          else uvArr.set(uv.getArray().subarray(0, n * 2));
          np.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uvArr).setBuffer(outBuf));
          const srcTex = mat.getBaseColorTexture(), mime = srcTex.getMimeType() || 'image/jpeg';
          o.deps.onTexture?.(out, mime);
          const tex = out.createTexture().setImage(srcTex.getImage()).setMimeType(mime);
          np.setMaterial(out.createMaterial().setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(1));
        }
        outScene.addChild(out.createNode().setMesh(out.createMesh().addPrimitive(np)));
        prims++;
      }
    }
    o.onProgress?.({ tiles, primitives: prims });
  });
  return { document: out, primitives: prims, tiles };
}

// ── splats → one file ─────────────────────────────────────────────────────────────────────────────────────────────

// The raw SPZ payload of a splat tile GLB, read without glTF-Transform (which does not know the required
// KHR_gaussian_splatting_compression_spz_2 extension): JSON chunk → the primitive's SPZ bufferView → the BIN chunk.
// Also the splat node's local matrix: SPZ positions are node-local, so per-splat clipping needs
// worldM·flip·nodeM, the chain the mesh path uses. Null when the tile is not an SPZ splat GLB.
export function spzOfTile(glbBytes) {
  const glb = bytesOf(glbBytes);
  if (glb.length < 28 || glb[0] !== 0x67 || glb[1] !== 0x6c || glb[2] !== 0x54 || glb[3] !== 0x46) return null;   // 'glTF'
  const jl = viewOf(glb).getUint32(12, true);
  let json; try { json = JSON.parse(text(glb.subarray(20, 20 + jl))); } catch { return null; }
  const prim = json.meshes?.[0]?.primitives?.[0];
  const ext = prim?.extensions?.KHR_gaussian_splatting?.extensions?.KHR_gaussian_splatting_compression_spz_2;
  if (!ext || ext.bufferView == null) return null;
  const bv = json.bufferViews?.[ext.bufferView]; if (!bv) return null;
  const binStart = 28 + jl;                                  // 12 B header + JSON chunk (8 B + jl) + BIN chunk header (8 B)
  const blob = glb.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);
  const node = (json.nodes || []).find((n) => n.mesh === 0) || json.nodes?.[0];
  return { blob, nodeM: nodeMatrix(node), hasNodeMatrix: Array.isArray(node?.matrix) && node.matrix.length === 16 };
}

// Local matrix of the GLB node that carries the splat mesh: its `matrix`, else its TRS, else identity. Column-major.
function nodeMatrix(node) {
  if (!node) return IDENT;
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r, x2 = x+x, y2 = y+y, z2 = z+z;
  const xx = x*x2, xy = x*y2, xz = x*z2, yy = y*y2, yz = y*z2, zz = z*z2, wx = w*x2, wy = w*y2, wz = w*z2;
  return [ (1-(yy+zz))*s[0], (xy+wz)*s[0], (xz-wy)*s[0], 0,
           (xy-wz)*s[1], (1-(xx+zz))*s[1], (yz+wx)*s[1], 0,
           (xz+wy)*s[2], (yz-wx)*s[2], (1-(xx+yy))*s[2], 0,
           t[0], t[1], t[2], 1 ];
}

// Which flip a splat tile without a node matrix needs depends on what that FORMAT's own root transform already
// assumes, which the GLB alone does not say; so this is a per-format table. Two conventions among our converters:
//  'auto'  (default): the root transform assumes a renderer applies the real Y_UP_TO_Z_UP (RX+90°) to content; no
//           renderer here, so it is supplied (`YUP_ZUP`). RAD is here (its root transform is an RX(180°) on top of
//           that assumption), and so are third-party splat GLBs with their OWN node matrix.
//  'baked': the root transform bakes the FULL Y-up→Z-up correction itself, so the INVERSE is supplied
//           (`YUP_ZUP_P90`) or it is turned twice. LCC (`lccGeoref`'s [East,−Up,North] columns), LCC2 (LCC's
//           transform) and streamed SOG (a fixed RX90 root transform). Each was found by sampling real tiles and
//           comparing the placed splat centroid to the tile's own box.
const SPLAT_FLIP_BAKED = new Set(['lcc', 'lcc2', 'sog']);
// `srcFormat` is the nested /stream URL's own `format=`; absent for a prebuilt tileset.json, so the well-known
// per-format sample-data path segment is sniffed instead.
function splatFlip(srcFormat, hasNodeMatrix, url) {
  if (hasNodeMatrix) return YUP_ZUP;
  const fmt = srcFormat || (/\/lcc\//i.test(url) ? 'lcc' : /\/sog\//i.test(url) ? 'sog' : null);
  return SPLAT_FLIP_BAKED.has(fmt) ? YUP_ZUP_P90 : YUP_ZUP;
}

// A column-major 4×4 (rigid + uniform scale) → a splat-transform TRS `Transform`. Setting each tile's
// DataTable.transform to its world placement lets combine() and the writers BAKE positions, quaternions, scales AND
// spherical harmonics into one frame. Uniform scale = mean of the column norms.
function matToTransform(M, Transform) {
  const sx = Math.hypot(M[0],M[1],M[2]) || 1, sy = Math.hypot(M[4],M[5],M[6]) || 1, sz = Math.hypot(M[8],M[9],M[10]) || 1;
  const s = (sx + sy + sz) / 3;
  const m00=M[0]/sx, m10=M[1]/sx, m20=M[2]/sx, m01=M[4]/sy, m11=M[5]/sy, m21=M[6]/sy, m02=M[8]/sz, m12=M[9]/sz, m22=M[10]/sz;
  let qx, qy, qz, qw; const tr = m00 + m11 + m22;
  if (tr > 0)                     { const S = Math.sqrt(tr + 1) * 2;        qw = 0.25*S; qx = (m21-m12)/S; qy = (m02-m20)/S; qz = (m10-m01)/S; }
  else if (m00 > m11 && m00 > m22){ const S = Math.sqrt(1+m00-m11-m22) * 2; qw = (m21-m12)/S; qx = 0.25*S; qy = (m01+m10)/S; qz = (m02+m20)/S; }
  else if (m11 > m22)             { const S = Math.sqrt(1+m11-m00-m22) * 2; qw = (m02-m20)/S; qx = (m01+m10)/S; qy = 0.25*S; qz = (m12+m21)/S; }
  else                            { const S = Math.sqrt(1+m22-m00-m11) * 2; qw = (m10-m01)/S; qx = (m02+m20)/S; qy = (m12+m21)/S; qz = 0.25*S; }
  const t = new Transform();
  t.translation.set(M[12], M[13], M[14]);
  t.rotation.set(qx, qy, qz, qw);                            // pc.Quat order is (x, y, z, w)
  t.scale = s;
  return t;
}

export const SPLAT_FORMATS = ['spz', 'glb', 'sog', 'ply'];

/**
 * Merge the splat tiles that touch the box into ONE file (SPZ, GLB, SOG or PLY) with PlayCanvas splat-transform.
 * Tile-level crop keeps every tile that touches the box; `clip` (default on) also drops the splats whose centre is
 * outside it.
 *
 * Output frame: a local **Y-up** frame anchored at the SOURCE scene's own origin (not the box centre), so every crop
 * of one source shares one coordinate system. Y-up because splat-transform's own space is PlayCanvas Y-up (Z-up
 * would tilt the model in SuperSplat). Axes: X = East, Y = Up, Z = −North. Each tile's splats are baked into it
 * (positions, rotations, scales, spherical harmonics), and coordinates stay small (raw ECEF overflows SPZ's fixed point).
 * @param {{url:string, bb:number[], maxGE?:number, maxDepth?:number, initM?:number[], format?:string, clip?:boolean,
 *          rx?:string|null, deps:{fetchBytes:Function, splat:object}, signal?:AbortSignal, onProgress?:Function}} o
 * @returns {Promise<{bytes:Uint8Array, name:string, tiles:number, splats:number, raw:number, clipped:number}|null>}
 *          null when no splat tile touches the box
 */
export async function extractSplats(o) {
  const st = o.deps.splat, { bb, url } = o, initM = o.initM ?? IDENT;
  const fmt = SPLAT_FORMATS.includes(o.format) && o.format !== 'spz' ? o.format : 'spz';
  const clip = o.clip !== false;
  let srcFormat = null; try { srcFormat = new URL(url).searchParams.get('format'); } catch {}
  const rxPick = (hasNodeMatrix) => (o.rx === '90' ? YUP_ZUP_P90 : o.rx === '-90' ? YUP_ZUP : splatFlip(srcFormat, hasNodeMatrix, url));
  const c = (await rootOriginEcef(url, initM, o.deps.fetchBytes)) || llhToEcef((bb[0]+bb[3])/2, (bb[1]+bb[4])/2, (bb[2]+bb[5])/2);
  const [refLon, refLat] = ecefToLlh(c[0], c[1], c[2]);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(refLon, refLat);
  const Edot = E[0]*c[0]+E[1]*c[1]+E[2]*c[2], Ndot = N[0]*c[0]+N[1]*c[1]+N[2]*c[2], Udot = U[0]*c[0]+U[1]*c[1]+U[2]*c[2];
  const Menu = [ E[0], U[0], -N[0], 0,  E[1], U[1], -N[1], 0,  E[2], U[2], -N[2], 0,  -Edot, -Udot, Ndot, 1 ];  // rows E / U / −N
  const pool = o.deps.splatPool ?? st.createChunkDataPool();
  const dts = []; let totIn = 0, totRaw = 0;
  await walkTileset(url, bb, { ...o, fetchBytes: o.deps.fetchBytes }, async (tileUrl, worldM) => {
    let glb; try { glb = await o.deps.fetchBytes(tileUrl); } catch (e) { o.onSkip?.(tileUrl, e); return; }
    const sp = spzOfTile(glb); if (!sp) return;
    const rfs = new st.MemoryReadFileSystem(); rfs.set('t.spz', new Uint8Array(sp.blob));
    let dt; try { const src = await st.readSpz(await rfs.createSource('t.spz'), pool); dt = await st.materializeToDataTable(src, pool); await src.close?.(); } catch (e) { return void o.deps.warn?.(`readSpz: ${e.message}`); }
    totRaw += dt.numRows;
    const Mfull = matMul(matMul(worldM, rxPick(sp.hasNodeMatrix)), sp.nodeM);
    if (clip) {                                              // drop splats whose centre is outside the box
      const xs = dt.getColumnByName('x')?.data, ys = dt.getColumnByName('y')?.data, zs = dt.getColumnByName('z')?.data;
      if (xs && ys && zs) {
        const keep = [];
        for (let i = 0; i < dt.numRows; i++) { const [X, Y, Z] = xform(Mfull, xs[i], ys[i], zs[i]); const [lon, lat, h] = ecefToLlh(X, Y, Z); if (inBbox(lon, lat, h, bb)) keep.push(i); }
        dt = dt.clone({ rows: keep });
      }
    }
    totIn += dt.numRows;
    if (dt.numRows) {
      dt.transform = matToTransform(matMul(Menu, Mfull), st.Transform);   // tile-local → the output frame, baked by combine()
      dts.push(dt);
    }
    o.onProgress?.({ tiles: dts.length, splats: totIn });
  });
  if (!dts.length) return null;
  const merged = st.combine(dts);
  const mfs = new st.MemoryFileSystem(), name = `crop.${fmt}`;
  if (fmt === 'sog') await st.writeSog({ filename: name, dataTable: merged, bundle: true, iterations: 10, logging: 'silent' }, mfs);   // bundle: one self-contained .sog
  else if (fmt === 'glb') await st.writeGlb({ filename: name, dataTable: merged }, mfs);   // KHR_gaussian_splatting GLB
  else if (fmt === 'ply') await st.writePly({ filename: name, plyData: { comments: [], elements: [{ name: 'vertex', dataTable: merged }] } }, mfs);
  else await st.writeSpz({ filename: name, dataTable: merged }, mfs);
  // The result is a VIEW into splat-transform's scratch buffer (its byteLength is the real size, its .buffer is not):
  // a copy of exactly the written bytes is returned.
  const out = mfs.results.get(name), u8 = out instanceof Uint8Array ? out : new Uint8Array(out);
  return { bytes: u8.slice(), name, tiles: dts.length, splats: merged.numRows, raw: totRaw, clipped: clip ? totRaw - totIn : 0 };
}

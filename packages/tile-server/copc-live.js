/**
 * copc-live.js — live **COPC → OGC 3D Tiles** middleware (true online range-streaming).
 *
 * The original "TiTiler for 3D" endpoint, extracted from server.js so every streamed format is a
 * uniform `*-live.js` module (copc, potree, …) the `/stream` dispatcher can delegate to. Nothing is
 * pre-converted: range-read the COPC header + hierarchy to emit the tileset, then range-read just one
 * octree node's point block per tile request → glTF POINTS GLB. The COPC octree maps ~1:1 onto 3D Tiles.
 *
 *   GET /copc/tileset.json?url=<COPC_URL>          → 3D Tiles 1.1 tileset (explicit tree, ADD refine)
 *   GET /copc/tile/<D-X-Y-Z>.glb?url=<COPC_URL>    → that node's points as a POINTS GLB
 */
import { Copc, Getter } from 'copc';
import { buildPointsGlb, keyToCoords, coordsToKey, buildSubtreeBuffer, georefFromCrs, buildImplicitTileset } from '../core/index.js';

const SUBTREE_LEVELS = 3;

// Read the LASF_Projection/2112 WKT VLR via a range read (copc exposes offset+length, not bytes).
async function readWkt(getter, copc) {
  const vlr = (copc.vlrs ?? []).find(v => v.userId === 'LASF_Projection' && v.recordId === 2112);
  if (!vlr || !vlr.contentOffset || !vlr.contentLength) return null;
  const buf = await getter(vlr.contentOffset, vlr.contentOffset + vlr.contentLength);
  let raw = Buffer.from(buf).toString('utf8').replace(/\0/g, '').trim();
  if (raw.startsWith('COMPD_CS[')) {                       // strip vertical CRS; proj4 wants the 2D part
    const inner = raw.slice(raw.indexOf(',') + 1).trim();
    let depth = 0, end = 0;
    for (let i = 0; i < inner.length; i++) { if (inner[i]==='[') depth++; else if (inner[i]===']' && --depth===0) { end = i+1; break; } }
    if (end > 0) raw = inner.slice(0, end);
  }
  return raw || null;
}

// Per-URL context (COPC header + full node hierarchy + georef), cached.
const ctxCache = new Map();
async function getCtx(url) {
  if (ctxCache.has(url)) return ctxCache.get(url);
  const getter = Getter.http(url);
  // Cheap guard: every LAS/COPC file starts with "LASF". Without this, pointing /copc at a non-LAS
  // resource (e.g. a JSON metadata.json / meta.lcc by mistake) makes copc + laz-perf hang and can
  // abort the whole process. Fail fast with a clear error instead.
  const magic = Buffer.from(await getter(0, 4)).toString('latin1');
  if (magic !== 'LASF') throw new Error(`not a LAS/COPC file (got "${magic}" not "LASF") — is this the right URL for /copc?`);
  const copc = await Copc.create(getter);
  const nodeMap = new Map();
  const pendingPages = new Map();    // key → pageRef (known but not yet loaded)

  // Load ONE hierarchy page: fold its nodes into nodeMap, its sub-pages into pendingPages.
  const loadOnePage = async (ref) => {
    const { nodes: pn, pages: pp } = await Copc.loadHierarchyPage(getter, ref);
    for (const k of Object.keys(pn)) nodeMap.set(k, pn[k]);
    for (const k of Object.keys(pp)) if (pp[k] && !nodeMap.has(k)) pendingPages.set(k, pp[k]);
  };
  // Eagerly load only the root page (fast — small, contains the top levels).
  await loadOnePage(copc.info.rootHierarchyPage);

  const cube = copc.info.cube;
  const origin = [(cube[0]+cube[3])/2, (cube[1]+cube[4])/2, (cube[2]+cube[5])/2];
  let transform = null;
  try {
    const wkt = await readWkt(getter, copc);
    if (wkt) transform = georefFromCrs(origin, wkt, 'copc-live');
    else console.warn(`[copc-live] no WKT CRS in ${url} — local-origin (not geo-referenced)`);
  } catch (e) { console.warn('[copc-live] georef failed:', e.message); }
  const rootDiag = Math.hypot(cube[3]-cube[0], cube[4]-cube[1], cube[5]-cube[2]);

  // For subtree (L,x,y,z): load pending pages whose cells overlap the [L, L+SUBTREE_LEVELS] block.
  const ensureForSubtree = async (L, x, y, z) => {
    const maxLvl = L + SUBTREE_LEVELS;
    const cells = 2 ** L;
    const span = [(cube[3]-cube[0])/cells, (cube[4]-cube[1])/cells, (cube[5]-cube[2])/cells];
    const tMin = [cube[0]+x*span[0], cube[1]+y*span[1], cube[2]+z*span[2]];
    const tMax = [tMin[0]+span[0], tMin[1]+span[1], tMin[2]+span[2]];
    let changed = true;
    while (changed) {
      changed = false;
      const toLoad = [];
      for (const [pageKey, pageRef] of pendingPages) {
        const { level: pl, x: px, y: py, z: pz } = keyToCoords(pageKey);
        if (pl > maxLvl) continue;
        const pCells = 2 ** pl;
        const pSp = [(cube[3]-cube[0])/pCells, (cube[4]-cube[1])/pCells, (cube[5]-cube[2])/pCells];
        const pMin = [cube[0]+px*pSp[0], cube[1]+py*pSp[1], cube[2]+pz*pSp[2]];
        const pMax = [pMin[0]+pSp[0], pMin[1]+pSp[1], pMin[2]+pSp[2]];
        if ([0,1,2].every(k => pMin[k] < tMax[k] && pMax[k] > tMin[k])) toLoad.push([pageKey, pageRef]);
      }
      if (toLoad.length) {
        changed = true;
        await Promise.all(toLoad.map(async ([k, ref]) => { pendingPages.delete(k); await loadOnePage(ref); }));
      }
    }
  };

  // cache=hierarchy: drain ALL pending pages into the shared ctx (whole index in RAM, warm forever).
  // Mutates the single cached ctx (like Potree's drainAll2) so later subtree requests reuse it.
  let drained = false;
  const drainAll = async () => {
    if (drained) return; drained = true;
    while (pendingPages.size) { const batch = [...pendingPages]; pendingPages.clear(); await Promise.all(batch.map(([, ref]) => loadOnePage(ref))); }
  };

  let warmed = false;   // guard so background prefetch fires at most once per ctx
  const ctx = { getter, copc, nodeMap, origin, transform, rootDiag, cube, ensureForSubtree, drainAll,
                get warmed() { return warmed; }, set warmed(v) { warmed = v; } };
  ctxCache.set(url, ctx);
  console.log(`[copc-live] ${url} → root page loaded (${nodeMap.size} nodes), pending=${pendingPages.size} child pages, georef=${!!transform}`);
  return ctx;
}

const subCube = (cube, level, x, y, z) => {
  const n = 2**level, dx = (cube[3]-cube[0])/n, dy = (cube[4]-cube[1])/n, dz = (cube[5]-cube[2])/n;
  return [cube[0]+x*dx, cube[1]+y*dy, cube[2]+z*dz, cube[0]+(x+1)*dx, cube[1]+(y+1)*dy, cube[2]+(z+1)*dz];
};

// Explicit 3D Tiles tree from the COPC hierarchy. Boxes = octree sub-cube relative to the origin.
function buildTilesetExplicit(ctx, urlParam) {
  const { nodeMap, origin, transform, rootDiag, cube } = ctx;
  const enc = encodeURIComponent(urlParam);
  const tileFor = (key) => {
    const { level, x, y, z } = keyToCoords(key);
    const sc = subCube(cube, level, x, y, z);
    const c = [(sc[0]+sc[3])/2-origin[0], (sc[1]+sc[4])/2-origin[1], (sc[2]+sc[5])/2-origin[2]];
    const h = [Math.max((sc[3]-sc[0])/2,0.01), Math.max((sc[4]-sc[1])/2,0.01), Math.max((sc[5]-sc[2])/2,0.01)];
    const node = nodeMap.get(key);
    const tile = { boundingVolume: { box: [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]] }, geometricError: rootDiag / (2**level), refine: 'ADD' };
    if (node && node.pointCount > 0) tile.content = { uri: `tile/${key}.glb?url=${enc}` };
    const kids = [];
    for (let i = 0; i < 8; i++) {
      const ck = `${level+1}-${2*x+(i&1)}-${2*y+((i>>1)&1)}-${2*z+((i>>2)&1)}`;
      if (nodeMap.has(ck)) kids.push(tileFor(ck));
    }
    if (kids.length) tile.children = kids;
    return tile;
  };
  const root = tileFor('0-0-0-0');
  if (transform) root.transform = transform;
  return { asset: { version: '1.1' }, geometricError: rootDiag, root, extensionsUsed: ['3DTILES_content_gltf'] };
}

// Implicit octree: one root with implicitTiling + content/subtree templates (subtrees built on the fly).
function buildTilesetImplicit(ctx, urlParam) {
  const { transform, rootDiag, cube } = ctx;
  let maxLevel = 0;
  for (const key of ctx.nodeMap.keys()) { const l = keyToCoords(key).level; if (l > maxLevel) maxLevel = l; }
  if (maxLevel < 8) maxLevel = 8;   // generous floor: lazy root page may cover only a few levels
  const box = [0,0,0, (cube[3]-cube[0])/2,0,0, 0,(cube[4]-cube[1])/2,0, 0,0,(cube[5]-cube[2])/2];
  return buildImplicitTileset({ box, rootGeometricError: rootDiag, contentGeometricError: rootDiag,
    maxLevel, subtreeLevels: SUBTREE_LEVELS, transform, urlParam });
}

async function serveTileGlb(ctx, key) {
  const node = ctx.nodeMap.get(key);
  if (!node || !node.pointCount) return null;
  const view = await Copc.loadPointDataView(ctx.getter, ctx.copc, node);
  const n = view.pointCount, [ox, oy, oz] = ctx.origin;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i*3] = gx(i)-ox; pos[i*3+1] = gy(i)-oy; pos[i*3+2] = gz(i)-oz; }
  const d = view.dimensions; let colors = null;
  if (d.Red && d.Green && d.Blue) {
    const gr = view.getter('Red'), gg = view.getter('Green'), gb = view.getter('Blue'), s = d.Red.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { colors[i*4]=gr(i)*s; colors[i*4+1]=gg(i)*s; colors[i*4+2]=gb(i)*s; colors[i*4+3]=1; }
  } else if (d.Intensity) {
    // T5: no RGB — use Intensity as greyscale so the point cloud isn't a featureless white blob.
    const gi = view.getter('Intensity'), s = d.Intensity.size === 2 ? 1/65535 : 1/255;
    colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const v = gi(i)*s; colors[i*4]=v; colors[i*4+1]=v; colors[i*4+2]=v; colors[i*4+3]=1; }
  }
  return Buffer.from(await buildPointsGlb(pos, colors, n));   // core applies the (E,U,−N) Y-up swizzle
}

// Pure builders the /stream dispatcher reuses. Tiles/subtrees are keyed "level-x-y-z" (explicit and
// implicit both use that token, so one tile route serves both modes).
export const copcTileRe = /^[0-9]+-[0-9]+-[0-9]+-[0-9]+$/;
export async function copcTileset(url, opts = {}) {
  const ctx = await getCtx(url);
  if (opts.hierarchy === 'eager') {
    await ctx.drainAll();                                   // cache=hierarchy: full index resident now
  } else if (!ctx.warmed) {                                 // cache=none: background prefetch (once)
    ctx.warmed = true;
    const pf = opts.prefetch ?? 1;                          // 0 = none · N = N levels · -1 = all
    if (pf === -1) Promise.resolve().then(() => { try { return ctx.drainAll(); } catch {} });
    else if (pf > 0) Promise.resolve().then(async () => { try { for (let L = 0; L < pf; L++) await ctx.ensureForSubtree(L, 0, 0, 0); } catch {} });
  }
  return opts.tiling === 'explicit' ? buildTilesetExplicit(ctx, url) : buildTilesetImplicit(ctx, url);
}
export async function copcTile(url, key) { return serveTileGlb(await getCtx(url), key); }
export async function copcSubtree(url, key) {
  const ctx = await getCtx(url);
  if (ctx.ensureForSubtree) {
    const { level, x, y, z } = keyToCoords(key);
    await ctx.ensureForSubtree(level, x, y, z);
  }
  return buildSubtreeBuffer(key, ctx.nodeMap, SUBTREE_LEVELS);
}

// Direct /copc/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=copc&url=<…> (+
// /stream/tile/…, /stream/subtrees/…) already cover every case these exposed. See CHANGELOG.

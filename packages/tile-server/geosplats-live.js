/**
 * geosplats-live.js — **MapTiler GeoSplats → OGC 3D Tiles** live stream converter.
 *
 *   GET /geosplats/tileset.json?url=<model.json URL>[&lod=1..8]
 *   GET /geosplats/tile.glb?url=<model.json URL>&m=<submodel#>&grid=<1|8|64|512>&oct=<n>&lod=<1..8>
 *
 * GeoSplats (https://www.maptiler.com/geosplats/) is a georeferenced HLOD splat format: a `model.json`
 * (global_position georef + N sub-models) and per-sub-model `metadata.json` (voxel-grid octree + LOD +
 * an `entries` TOC). Per-octant data is **SOGS** (means_l/u, quats, scales, sh0 WebP) served by the API
 * proxy at `…/<modelId>/<subBaseurl>/<grid>/<octant>/<lod>` as one bundle = the dir's entries concatenated
 * in array order (verified: bundle size == Σ entry lengths). We:
 *   1. fetch the octant bundle, slice it by the entries TOC, feed meta.json + the 5 WebPs to
 *      splat-transform `readSog` → DataTable, re-encode as a KHR_gaussian_splatting GLB (`writeGlb`);
 *   2. georeference via `global_position` (lat/lon/alt + model_scale + Euler offset) → 3D Tiles transform.
 *
 * MVP: one tile per sub-model (grid_1 / octant_0 / LOD=lod). HLOD over the voxel_grids octree is a TODO.
 *
 * KEYS: MapTiler keys are origin-restricted — the upstream fetch is done HERE with a
 * `Referer: https://www.maptiler.com/` (server-side); the browser only ever talks to this middleware.
 * Reverse-engineered structure: docs-references/maptiler-geosplats.md.
 */
import { readSog, MemoryReadFileSystem } from '@playcanvas/splat-transform';
import { CORS, sendJson, sendGlb, llhToEcef, enuFrame, buildSplatTileGlb, computeBounds } from '../core/index.js';

const SH_C0 = 0.28209479177387814;
// readSog yields a PLY-convention DataTable (SH-DC colour, logit opacity, ln scale, quat rot_0=w). Convert
// to the renderer-ready linear arrays buildSplatTileGlb wants and emit a KHR_gaussian_splatting_compression
// _spz_2 GLB — the SAME format every other splat tile in this repo uses (the uncompressed writeGlb variant
// is not read by our viewer's GaussianSplat plugin, which is why those tiles failed to load).
function dataTableToSplatGlb(dt) {
  const n = dt.numRows;
  const col = (nm) => dt.getColumnByName(nm)?.data;
  const x=col('x'), y=col('y'), z=col('z'), op=col('opacity');
  const s0=col('scale_0'), s1=col('scale_1'), s2=col('scale_2');
  const c0=col('f_dc_0'), c1=col('f_dc_1'), c2=col('f_dc_2');
  const r0=col('rot_0'), r1=col('rot_1'), r2=col('rot_2'), r3=col('rot_3');   // rot_0 = w
  const positions=new Float32Array(n*3), alphas=new Float32Array(n), rgb=new Float32Array(n*3), scales=new Float32Array(n*3), rotations=new Float32Array(n*4);
  const cl01=(v)=>v<0?0:v>1?1:v;
  for (let i=0;i<n;i++){
    positions[i*3]=x[i]; positions[i*3+1]=y[i]; positions[i*3+2]=z[i];
    alphas[i]= op ? 1/(1+Math.exp(-op[i])) : 1;                               // logit → [0,1]
    rgb[i*3]  = c0 ? cl01(0.5+SH_C0*c0[i]) : 0.5;                             // SH-DC → linear colour
    rgb[i*3+1]= c1 ? cl01(0.5+SH_C0*c1[i]) : 0.5;
    rgb[i*3+2]= c2 ? cl01(0.5+SH_C0*c2[i]) : 0.5;
    scales[i*3]  = s0 ? Math.exp(s0[i]) : 0.01;                               // ln → linear
    scales[i*3+1]= s1 ? Math.exp(s1[i]) : 0.01;
    scales[i*3+2]= s2 ? Math.exp(s2[i]) : 0.01;
    rotations[i*4]= r1?r1[i]:0; rotations[i*4+1]= r2?r2[i]:0; rotations[i*4+2]= r3?r3[i]:0; rotations[i*4+3]= r0?r0[i]:1;  // xyzw
  }
  return buildSplatTileGlb({ positions, alphas, rgb, scales, rotations }, n, computeBounds(positions, n));
}

const REFERER = 'https://www.maptiler.com/';
const gfetch = (u) => fetch(u, { headers: { Referer: REFERER, Origin: 'https://www.maptiler.com' } });
const ui = (grid) => ({ 1: 1, 8: 3, 64: 6, 512: 9 }[grid] ?? 1);   // octant-id bit width per grid (SDK ne.ui)

// tiny cache so per-tile requests don't re-fetch model.json / metadata.json each time
const _cache = new Map();
const cached = async (k, fn) => { if (_cache.has(k)) return _cache.get(k); const v = await fn(); _cache.set(k, v); return v; };

// Parse the model.json URL → { origin base, modelId, key }. URL shape:
//   https://api.maptiler.com/splats/<modelId>/model.json?key=<K>
function parseModelUrl(modelUrl) {
  const u = new URL(modelUrl);
  const parts = u.pathname.split('/').filter(Boolean);       // [splats, <modelId>, model.json]
  const modelId = parts[parts.length - 2];
  const splatsBase = u.origin + '/' + parts.slice(0, parts.length - 2).join('/');  // …/splats
  return { splatsBase, modelId, key: u.searchParams.get('key') || '' };
}
const fetchModel = (modelUrl) => cached('model:' + modelUrl, async () => (await gfetch(modelUrl)).json());
const fetchMeta = (splatsBase, modelId, baseurl, key) =>
  cached(`meta:${modelId}/${baseurl}`, async () => (await gfetch(`${splatsBase}/${modelId}/${baseurl}/metadata.json?key=${key}`)).json());

// column-major 4×4 multiply (a·b)
function matMul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3]; return o; }
const D2R = Math.PI / 180;
// GeoSplats model rotation from global_position.offset, decoded from the SDK: quat Rx(x)·Ry(y)·Rz(z)
// (axis-angle, right-multiplied) applied in the MapLibre Y-up model world (X=East, Y=Up, Z=South) —
// which is exactly our [East, Up, −North] placement frame. Column-major, order Rx·Ry·Rz.
function eulerXYZ(xd, yd, zd) {
  const cx=Math.cos(xd*D2R), sx=Math.sin(xd*D2R), cy=Math.cos(yd*D2R), sy=Math.sin(yd*D2R), cz=Math.cos(zd*D2R), sz=Math.sin(zd*D2R);
  const Rx = [1,0,0,0, 0,cx,sx,0, 0,-sx,cx,0, 0,0,0,1];
  const Ry = [cy,0,-sy,0, 0,1,0,0, sy,0,cy,0, 0,0,0,1];
  const Rz = [cz,sz,0,0, -sz,cz,0,0, 0,0,1,0, 0,0,0,1];
  return matMul(matMul(Rx, Ry), Rz);
}

// 3D Tiles root transform placing GeoSplats local coords on the globe from `global_position`.
// NOTE: readSog already decodes means via the meta.json codebook to REAL local units (~hundreds of m),
// so `model_scale` (which the SDK applies to its raw-texture pipeline, even `/=256`) must NOT be applied
// here — doing so shrank the scene to sub-metre and broke refinement. We place 1:1: translate the whole
// scene by −center (so it sits at lat/lon/alt), apply the model Euler (offset.[xyz]_rot), then a Y-up ENU
// frame [East, Up, −North] = the MapLibre model world the SDK rotates in (X=East, Y=Up, Z=South). The
// Euler offset is per-model (A y_rot=-178, B y_rot=217) — real orientation, applied as Rx·Ry·Rz (SDK order).
// `center` = union bbox centre of all sub-models. model_scale is NOT applied (readSog gives real units).
function georefTransform(gp, center) {
  const e = llhToEcef(gp.lon, gp.lat, gp.alt || 0);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(gp.lon, gp.lat);
  const place = [ E[0],E[1],E[2],0,  U[0],U[1],U[2],0,  -N[0],-N[1],-N[2],0,  e[0],e[1],e[2],1 ];  // [East, Up, −North, origin]
  const o = gp.offset || {};
  const rot = eulerXYZ(o.x_rot || 0, o.y_rot || 0, o.z_rot || 0);
  const recenter = [ 1,0,0,0, 0,1,0,0, 0,0,1,0, -center[0], -center[1], -center[2], 1 ];
  return matMul(matMul(place, rot), recenter);
}

// ── HLOD over the voxel-grid octree ─────────────────────────────────────────────
// Each sub-model's metadata.voxel_grids has DENSE octant arrays per grid (grid_1→8→64→512; array index =
// octant id, offset<0 = empty), each cell = { offset, total_count, counts[8] (cumulative per LOD), center,
// bounding_box }. We map the grid hierarchy to a 3D Tiles REPLACE octree: grid_1 (whole sub-model, coarse
// LOD) → grid_8 → grid_64 (finer octants, higher LOD). Parent→child by spatial containment (child centre
// inside parent bbox), so we don't depend on the octant-id bit layout. geometricError = octant diagonal
// (decreases with depth → correct REPLACE). Only visible octants stream. grid_512 omitted (grid_64 depth).
const LOD_FOR_GRID = { 1: 4, 8: 6, 64: 8 };                  // finer grid → higher-detail LOD
const CHILD_GRID = { 1: 8, 8: 64, 64: null };
function octantsOf(meta, g) {
  const arr = meta.voxel_grids?.['grid_' + g] || [];
  const out = [];
  arr.forEach((c, i) => { if (c && c.offset >= 0 && c.total_count > 0 && c.bounding_box) out.push({ oct: i, bb: c.bounding_box, center: c.center, counts: c.counts }); });
  return out;
}
function boxOf(bb) {
  const cx=(bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz=(bb.min.z+bb.max.z)/2;
  const hx=Math.max(0.5,(bb.max.x-bb.min.x)/2), hy=Math.max(0.5,(bb.max.y-bb.min.y)/2), hz=Math.max(0.5,(bb.max.z-bb.min.z)/2);
  return { box: [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz], diag: 2*Math.hypot(hx,hy,hz) };
}
const inside = (c, bb) => !!c && c.x>=bb.min.x && c.x<=bb.max.x && c.y>=bb.min.y && c.y<=bb.max.y && c.z>=bb.min.z && c.z<=bb.max.z;
function pickLod(counts, target) {                          // clamp target to a LOD that actually has splats
  if (!counts) return target;
  if (counts[target-1] > 0) return target;
  for (let L = 1; L <= 8; L++) if (counts[L-1] > 0) return L;
  return target;
}
// Build the octree subtree for one sub-model. Returns the grid_1 tile (nested), or null.
function buildSubmodelOctree(meta, m, modelUrl, enc) {
  const byGrid = { 1: octantsOf(meta, 1), 8: octantsOf(meta, 8), 64: octantsOf(meta, 64) };
  // grid_1's single cell usually omits bounding_box (only finer cells carry it) → synthesize from the
  // sub-model bbox so the root octant still gets content + a proper geometricError.
  if (!byGrid[1].length && meta.bounding_box) {
    const g1 = meta.voxel_grids?.grid_1?.[0], bb = meta.bounding_box;
    byGrid[1] = [{ oct: 0, bb, center: g1?.center || { x:(bb.min.x+bb.max.x)/2, y:(bb.min.y+bb.max.y)/2, z:(bb.min.z+bb.max.z)/2 }, counts: g1?.counts }];
  }
  const mk = (g, cell) => {
    const b = boxOf(cell.bb), cg = CHILD_GRID[g];
    const lod = pickLod(cell.counts, LOD_FOR_GRID[g] || 8);
    const kids = cg ? byGrid[cg].filter(cc => inside(cc.center, cell.bb)).map(cc => mk(cg, cc)) : [];
    return { boundingVolume: { box: b.box }, geometricError: cg ? b.diag : b.diag / 4, refine: 'REPLACE',
      content: { uri: `/geosplats/tile.glb?url=${enc(modelUrl)}&m=${m}&grid=${g}&oct=${cell.oct}&lod=${lod}` }, children: kids };
  };
  if (byGrid[1].length) return mk(1, byGrid[1][0]);
  if (byGrid[8].length) return { boundingVolume: { box: boxOf(meta.bounding_box).box }, geometricError: 1e5, refine: 'REPLACE', children: byGrid[8].map(c => mk(8, c)) };
  return null;
}

// Fetch one octant bundle and decode it to a splat DataTable via readSog.
async function octantDataTable(splatsBase, modelId, baseurl, key, grid, oct, lod) {
  const meta = await fetchMeta(splatsBase, modelId, baseurl, key);
  const octBin = oct.toString(2).padStart(ui(grid), '0');
  const dir = `delta_data/grid_${grid}/octant_${octBin}_LOD${lod}/`;
  const want = meta.entries.filter(en => en[0].includes(`grid_${grid}/octant_${octBin}_LOD${lod}/`));
  if (!want.length) throw new Error(`no entries for ${dir}`);
  const buf = new Uint8Array(await (await gfetch(`${splatsBase}/${modelId}/${baseurl}/${grid}/${oct}/${lod}?key=${key}`)).arrayBuffer());
  const fs = new MemoryReadFileSystem();
  let off = 0;                                                // bundle = entries concatenated in array order
  for (const en of want) { const name = en[0].split('/').pop(); fs.set(name, buf.subarray(off, off + en[2])); off += en[2]; }
  return readSog(fs, 'meta.json');
}

export async function handleGeoSplats(req, res, u) {
  if (!u.pathname.startsWith('/geosplats/')) return false;
  const modelUrl = u.searchParams.get('url');
  if (!modelUrl) { res.writeHead(400, CORS); res.end('GET /geosplats/tileset.json?url=<model.json URL>[&lod=1..8]'); return true; }
  const { splatsBase, modelId, key } = parseModelUrl(modelUrl);
  const lod = Math.min(8, Math.max(1, Number(u.searchParams.get('lod')) || 6));

  try {
    if (u.pathname === '/geosplats/tileset.json') {
      const model = await fetchModel(modelUrl);
      const gp = model.global_position || {};
      const enc = (o) => encodeURIComponent(o);
      // Fetch every sub-model's metadata (voxel_grids) → per-sub-model octree + the union bbox (for centering).
      const gmin = [Infinity,Infinity,Infinity], gmax = [-Infinity,-Infinity,-Infinity];
      const subs = await Promise.all((model.models || []).map(async (sm, i) => {
        let meta = null; try { meta = await fetchMeta(splatsBase, modelId, sm.baseurl, key); } catch {}
        const bb = meta?.bounding_box;
        if (bb) { for (const k of [0,1,2]) { const lo=[bb.min.x,bb.min.y,bb.min.z][k], hi=[bb.max.x,bb.max.y,bb.max.z][k]; if(lo<gmin[k])gmin[k]=lo; if(hi>gmax[k])gmax[k]=hi; } }
        return { i, meta };
      }));
      const center = gmin[0] === Infinity ? [0,0,0] : [(gmin[0]+gmax[0])/2,(gmin[1]+gmax[1])/2,(gmin[2]+gmax[2])/2];
      const ghalf = gmin[0] === Infinity ? 1000 : Math.max(gmax[0]-gmin[0], gmax[1]-gmin[1], gmax[2]-gmin[2]) / 2;
      // HLOD: each sub-model → its voxel-grid octree (grid_1→8→64). Falls back to a single full-LOD tile.
      const children = subs.map(({ i, meta }) => {
        const tree = meta && buildSubmodelOctree(meta, i, modelUrl, enc);
        if (tree) return tree;
        const bb = meta?.bounding_box; const b = bb ? boxOf(bb) : { box: [center[0],center[1],center[2], ghalf,0,0, 0,ghalf,0, 0,0,ghalf], diag: ghalf*2 };
        return { boundingVolume: { box: b.box }, geometricError: b.diag/4, refine: 'REPLACE',
          content: { uri: `/geosplats/tile.glb?url=${enc(modelUrl)}&m=${i}&grid=1&oct=0&lod=${lod}` } };
      });
      // octant boxes are in raw local coords; root.transform recenters (−center) + places them on the globe.
      const root = { transform: georefTransform(gp, center), geometricError: ghalf * 4, refine: 'ADD',
        boundingVolume: { box: [center[0],center[1],center[2], ghalf,0,0, 0,ghalf,0, 0,0,ghalf] }, children };
      const ts = { asset: { version: '1.1', tilesetVersion: 'geosplats' }, geometricError: ghalf * 4, root };
      return void sendJson(res, ts), true;
    }

    if (u.pathname === '/geosplats/tile.glb') {
      const model = await fetchModel(modelUrl);
      const sm = (model.models || [])[Number(u.searchParams.get('m')) || 0];
      if (!sm) { res.writeHead(404, CORS); res.end('submodel not found'); return true; }
      const grid = Number(u.searchParams.get('grid')) || 1, oct = Number(u.searchParams.get('oct')) || 0;
      const dt = await octantDataTable(splatsBase, modelId, sm.baseurl, key, grid, oct, lod);
      const glb = await dataTableToSplatGlb(dt);             // _spz_2 splat GLB (viewer-renderable)
      return void sendGlb(res, Buffer.isBuffer(glb) ? glb : Buffer.from(glb)), true;
    }

    res.writeHead(404, CORS); res.end('try /geosplats/tileset.json?url=<model.json>'); return true;
  } catch (e) {
    console.error('[geosplats-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end();
    return true;
  }
}

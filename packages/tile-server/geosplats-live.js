/**
 * geosplats-live.js — **MapTiler GeoSplats → OGC 3D Tiles** live stream converter.
 *
 *   GET /stream/tileset.json?url=<model.json URL>&format=geosplats[&lod=1..8]
 *   GET /stream/tile/<m>-<grid>-<oct>-<lod>.glb?url=<model.json URL>&format=geosplats
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
 * HLOD over the voxel_grids octree (grid_1→8→64, REPLACE refine, per-level LOD auto-picked — see
 * LOD_FOR_GRID below) is the normal path; the flat single-tile-per-sub-model mode (`&lod=1..8`) is
 * only a FALLBACK for a sub-model missing voxel_grids metadata, not a user-facing quality toggle.
 *
 * KEYS: MapTiler keys are origin-restricted — the upstream fetch is done HERE with a
 * `Referer: https://www.maptiler.com/` (server-side); the browser only ever talks to this middleware.
 * Reverse-engineered structure: docs-references/maptiler-geosplats.md.
 */
import { llhToEcef, enuFrame, fetchSource, tilePool, runTileTaskOr, ownBytes } from '../core/index.js';
import { geosplatsBundleGlb } from './splat-tile.js';

const SPLAT_TASKS = new URL('./tile-tasks-splats.js', import.meta.url).href;   // what a tile worker runs (TILED_WORKERS)

const REFERER = 'https://www.maptiler.com/';
// The viewer streams many octants in parallel; MapTiler rate-limits bursts (429) and occasionally drops a
// connection, which surfaced as sporadic "Request has failed" tile errors + visible gaps. Retry transient
// failures (429/5xx/network) with exponential backoff so tiles fill in instead of failing.
const gfetch = (u) => fetchSource(u, { attempts: 4, headers: { Referer: REFERER, Origin: 'https://www.maptiler.com' } });
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
const fetchModel = (modelUrl) => cached('model:' + modelUrl, async () => JSON.parse(await gfetch(modelUrl)));
const fetchMeta = (splatsBase, modelId, baseurl, key) =>
  cached(`meta:${modelId}/${baseurl}`, async () => JSON.parse(await gfetch(`${splatsBase}/${modelId}/${baseurl}/metadata.json?key=${key}`)));

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
// NOTE: readSog decodes means via the meta.json codebook; the local units are per-model (A ≈ 300 m aerial,
// B ≈ 4 m object — verified union extents). `model_scale` is NOT applied (it maps to MapTiler's MapLibre
// mercator frame, not metres — applying it shrinks every scene to sub-metre). We place 1:1: translate by
// −center (so the scene sits at lat/lon), apply the ENU frame.
// ORIENTATION (verified in-browser 2026-07-02 on the upright Biltmore Hotel, model B): use 'enu2' =
// [East, −North, −Up]. Both renderers apply the glTF Y-up→Z-up correction to the content before this
// transform; the content's up is then −Z, so plain ENU [East,North,Up] renders FLAT but UPSIDE-DOWN. 'enu2'
// is a 180° flip about East (a proper rotation, not a mirror) that rights it. ([East,Up,−North] / [East,−Up,
// North] pre-bake ANOTHER Y-up→Z-up rotation → vertical slab.) N/S heading ends up flipped 180° (we don't
// apply the SDK offset Euler); nudge with &yaw if needed. DEBUG sweep: &frame=enu|enu2|eun|e-un|e-nu.
// The per-model SDK Euler (offset.[xyz]_rot) is OFF by default (authored in MapLibre's frame; &euler=1).
// ALTITUDE: global_position.alt is in MapTiler's model_scale-normalised MapLibre frame, NOT our 1:1 ellipsoidal
// metres — using it raw buries the scene (model A alt=−307.6 → ~300 m underground; alt·model_scale≈−0.2 m ≈ 0).
// So we default the placement height to 0 (scene origin on the ellipsoid ≈ ground for these near-sea-level
// captures). TUNING knobs: &frame=<name> pick ENU variant; &yaw=<deg> heading; &euler=1 SDK Euler; &alt=<m>.
// Named ENU frames: which world axis each CONTENT column (X,Y,Z) maps to. Cesium AND 3d-tiles-renderer both
// apply the glTF Y-up→Z-up correction BEFORE this transform, so 'enu' (standard [East,North,Up]) is the
// right one for Z-up-corrected content. DEBUG sweep knob &frame=<name> picks one without a redeploy.
const FRAMES = (E, N, U) => ({
  enu:   [ E, N, U ],           // [East, North, Up]  — standard; correct once Cesium/3DTRJS un-swap glTF Y-up
  eun:   [ E, U, neg(N) ],      // [East, Up, −North]
  'e-un':[ E, neg(U), N ],      // [East, −Up, North] (lcc convention)
  'e-nu':[ E, neg(N), U ],      // [East, −North, Up]
  enu2:  [ E, neg(N), neg(U) ], // [East, −North, −Up]
});
const neg = (v) => [-v[0], -v[1], -v[2]];
function georefTransform(gp, center, opt = {}) {
  const alt = opt.alt != null ? opt.alt : 0;
  const e = llhToEcef(gp.lon, gp.lat, alt);
  let { EAST: E, NORTH: N, UP: U } = enuFrame(gp.lon, gp.lat);
  // HEADING: rotate the horizontal ENU basis (E,N) about Up by `yaw` degrees. This spins the whole scene
  // about the vertical regardless of which frame variant is used — the clean way to correct the compass
  // heading (the SDK offset.y_rot lives in MapLibre's frame and does not compose with ours; &euler tilts).
  if (opt.yaw) { const c = Math.cos(opt.yaw * D2R), s = Math.sin(opt.yaw * D2R);
    const E2 = [c*E[0]+s*N[0], c*E[1]+s*N[1], c*E[2]+s*N[2]], N2 = [-s*E[0]+c*N[0], -s*E[1]+c*N[1], -s*E[2]+c*N[2]];
    E = E2; N = N2; }
  const [C0, C1, C2] = (FRAMES(E, N, U)[opt.frame] || FRAMES(E, N, U).enu);
  const s = opt.scale || 1;                                  // uniform metric scale baked into the ENU basis
  const place = [ s*C0[0],s*C0[1],s*C0[2],0,  s*C1[0],s*C1[1],s*C1[2],0,  s*C2[0],s*C2[1],s*C2[2],0,  e[0],e[1],e[2],1 ];
  const o = gp.offset || {};
  const rot = opt.euler ? eulerXYZ(o.x_rot || 0, o.y_rot || 0, o.z_rot || 0) : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
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
    // Relative (resolved against the tileset.json's own URL) — the /stream/tile/<key>.glb generic
    // route handles it; tagContentUris appends &format=geosplats.
    return { boundingVolume: { box: b.box }, geometricError: cg ? b.diag : b.diag / 4, refine: 'REPLACE',
      content: { uri: `tile/${m}-${g}-${cell.oct}-${lod}.glb?url=${enc(modelUrl)}` }, children: kids };
  };
  if (byGrid[1].length) return mk(1, byGrid[1][0]);
  if (byGrid[8].length) return { boundingVolume: { box: boxOf(meta.bounding_box).box }, geometricError: 1e5, refine: 'REPLACE', children: byGrid[8].map(c => mk(8, c)) };
  return null;
}

// Fetch one octant bundle: its bytes, and the files it holds in order ([name, size]), for geosplatsBundleGlb.
async function octantBundle(splatsBase, modelId, baseurl, key, grid, oct, lod) {
  const meta = await fetchMeta(splatsBase, modelId, baseurl, key);
  const octBin = oct.toString(2).padStart(ui(grid), '0');
  const prefix = `grid_${grid}/octant_${octBin}_LOD`;
  // cell.counts[] can claim a LOD that has no delta_data entries (data was only baked to a coarser LOD for
  // this octant). Rather than 500, fall back to the highest available LOD ≤ requested (else the lowest).
  const avail = [...new Set(meta.entries
    .map(en => { const m = en[0].match(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)/')); return m ? +m[1] : null; })
    .filter(v => v != null))].sort((a, b) => a - b);
  if (!avail.length) throw new Error(`no entries for octant ${octBin} (grid ${grid})`);
  const useLod = avail.includes(lod) ? lod : (avail.filter(v => v <= lod).pop() ?? avail[0]);
  const want = meta.entries.filter(en => en[0].includes(`${prefix}${useLod}/`));
  const buf = new Uint8Array(await gfetch(`${splatsBase}/${modelId}/${baseurl}/${grid}/${oct}/${useLod}?key=${key}`));
  return { buf, files: want.map((en) => [en[0].split('/').pop(), en[2]]) };   // bundle = entries concatenated in array order
}

// Pure builders for the /stream dispatcher.
export async function geosplatsTileset(modelUrl, opts = {}) {
  const { splatsBase, modelId, key } = parseModelUrl(modelUrl);
  const lod = Math.min(8, Math.max(1, opts.lod || 6));
  const model = await fetchModel(modelUrl);
  const gp = model.global_position || {};
  const enc = (o) => encodeURIComponent(o);
  // Fetch every sub-model's metadata (voxel_grids) → per-sub-model octree + the union bbox (for centering).
  const gmin = [Infinity,Infinity,Infinity], gmax = [-Infinity,-Infinity,-Infinity];
  const subs = await Promise.all((model.models || []).map(async (sm, i) => {
    let meta = null; try { meta = await fetchMeta(splatsBase, modelId, sm.baseurl, key); } catch (e) { if (e.transient) throw e; }
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
      content: { uri: `tile/${i}-1-0-${lod}.glb?url=${enc(modelUrl)}` } };
  });
  // SCALE to real-world metres. readSog units are per-model (A ≈ raw thousands, B ≈ raw single-digits) and
  // do NOT match; `model_scale` normalises them into MapTiler's WEB-MERCATOR tile frame. From the SDK the
  // mercator-tile→metre factor is 512·ZOOM_TO_METER[14] = 2445.98, but that's at the EQUATOR — web mercator
  // stretches by 1/cos(lat), so REAL metres = mercator·cos(lat). Without the cos() the scene overscaled by
  // 1/cos(lat): model A (lat 55° → ×1.74) was clearly too big, B (lat 26° → ×1.11) slightly. So:
  //   S = model_scale · 512·ZOOM_TO_METER[14] · cos(lat)   (verified: A ≈ 0.9 km, B footprint matches map).
  // `&scale=<f>` overrides the whole S if a specific model still needs tuning.
  const SCALE_K = 512 * 4.7773 * Math.cos((gp.lat || 0) * D2R);   // equator tile-metre × cos(lat) latitude correction
  const S = opts.scale != null ? opts.scale : ((gp.model_scale || 0) * SCALE_K || 1);
  // octant boxes are in raw local coords; root.transform recenters (−center), scales by S, places on globe.
  // HEADING: auto-derive from the SDK per-model offset.y_rot. In the enu2 frame the compass heading that
  // aligns the scene with the map is y_rot−180° (verified on model B / Biltmore: y_rot=217 → 37°, tennis
  // courts land east, golf west; model A y_rot=−178 → ≈+2°, negligible). &yaw=<deg> adds a fine-tune on top.
  const autoYaw = (gp.offset?.y_rot ?? 0) - 180;
  const opt = { frame: opts.frame || 'enu2', euler: !!opts.euler,
    scale: S, yaw: autoYaw + (opts.yaw || 0), alt: opts.alt != null ? opts.alt : null };
  // geometricError is world-space metres and is NOT affected by the tile transform's scale, so multiply
  // every GE by S to keep LOD selection consistent with the now-scaled geometry (boxes inherit S via the
  // transform automatically). Root box stays raw (center/ghalf) — it too inherits S from root.transform.
  const scaleGE = (node) => { if (node.geometricError != null) node.geometricError *= S; (node.children || []).forEach(scaleGE); };
  children.forEach(scaleGE);
  const root = { transform: georefTransform(gp, center, opt), geometricError: ghalf * 4 * S, refine: 'ADD',
    boundingVolume: { box: [center[0],center[1],center[2], ghalf,0,0, 0,ghalf,0, 0,0,ghalf] }, children };
  // Declare the gaussian-splatting glTF extension at the tileset level. Cesium routes a tileset to its
  // native Gaussian-splat renderer ONLY when 3DTILES_content_gltf.extensionsRequired lists
  // KHR_gaussian_splatting (see GaussianSplat3DTileContent.tilesetRequiresGaussianSplattingExt). Without
  // this block Cesium loads our splat GLBs as ordinary meshes → "attribute.value.length must be in [1,4]"
  // on the splat-only SCALE/ROTATION attributes. Every other splat converter here emits the same block.
  return { asset: { version: '1.1', tilesetVersion: 'geosplats' }, geometricError: ghalf * 4 * S, root,
    extensionsUsed: ['3DTILES_content_gltf'],
    extensions: { '3DTILES_content_gltf': {
      extensionsUsed:     ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
      extensionsRequired: ['KHR_gaussian_splatting', 'KHR_gaussian_splatting_compression_spz_2'],
    }} };
}

export const geosplatsTileRe = /^\d+-\d+-\d+-\d+$/;         // <submodel#>-<grid>-<octant>-<lod>
export async function geosplatsTile(modelUrl, key) {
  const [m, grid, oct, lod] = key.split('-').map(Number);
  const { splatsBase, modelId, key: apiKey } = parseModelUrl(modelUrl);
  const model = await fetchModel(modelUrl);
  const sm = (model.models || [])[m];
  if (!sm) return null;
  const { buf, files } = await octantBundle(splatsBase, modelId, sm.baseurl, apiKey, grid, oct, lod);
  // _spz_2 splat GLB (viewer-renderable): the SOG decode and the SPZ encode are in splat-tile.js, on this thread or,
  // with TILED_WORKERS, on a tile worker; a tile the workers had no memory for is built here instead.
  const here = async () => Buffer.from(await geosplatsBundleGlb(buf, files));
  const pool = tilePool();
  if (!pool) return here();
  const bytes = ownBytes(buf);
  const glb = await runTileTaskOr(pool, SPLAT_TASKS, 'geosplatsTileTask', { buf: bytes, files }, [bytes.buffer], here);
  return Buffer.isBuffer(glb) ? glb : Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength);
}

// Direct /geosplats/* HTTP routes were removed 2026-07-02 — /stream/tileset.json?format=geosplats&url=<…>
// (+ /stream/tile/…) now covers tileset/tile serving. See CHANGELOG.

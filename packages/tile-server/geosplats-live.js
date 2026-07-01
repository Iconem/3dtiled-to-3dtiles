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

// 3D Tiles root transform placing GeoSplats local coords on the globe from `global_position`.
// NOTE: readSog already decodes means via the meta.json codebook to REAL local units (~hundreds of m),
// so `model_scale` (which the SDK applies to its raw-texture pipeline, even `/=256`) must NOT be applied
// here — doing so shrank the scene to sub-metre and broke refinement. We place 1:1: translate the whole
// scene by −center (so it sits at lat/lon/alt), then a **Y-up** ENU frame. GeoSplats local data is Y-up
// (smallest extent = height on Y; X/Z are the ~square ground footprint), so the frame columns are
// [East, Up, −North] (local +Y → ECEF Up = upright; right-handed). The `global_position.offset` Euler
// (y_rot≈-178, z_rot=180) is the SDK's own raw-pipeline convention and does NOT compose with this frame
// (it tipped the scene vertical) — omitted. `center` = union bbox centre of all sub-models.
function georefTransform(gp, center) {
  const e = llhToEcef(gp.lon, gp.lat, gp.alt || 0);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(gp.lon, gp.lat);
  const place = [ E[0],E[1],E[2],0,  U[0],U[1],U[2],0,  -N[0],-N[1],-N[2],0,  e[0],e[1],e[2],1 ];  // [East, Up, −North, origin]
  const recenter = [ 1,0,0,0, 0,1,0,0, 0,0,1,0, -center[0], -center[1], -center[2], 1 ];
  return matMul(place, recenter);
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
      // Gather each sub-model's local bbox (grid_1 octant) → per-tile boxes + the union (for centering).
      const gmin = [Infinity,Infinity,Infinity], gmax = [-Infinity,-Infinity,-Infinity];
      const subs = await Promise.all((model.models || []).map(async (sm, i) => {
        let bb = null; try { bb = (await fetchMeta(splatsBase, modelId, sm.baseurl, key)).bounding_box; } catch {}
        if (bb) { for (const k of [0,1,2]) { const lo=[bb.min.x,bb.min.y,bb.min.z][k], hi=[bb.max.x,bb.max.y,bb.max.z][k]; if(lo<gmin[k])gmin[k]=lo; if(hi>gmax[k])gmax[k]=hi; } }
        return { i, bb };
      }));
      const center = gmin[0] === Infinity ? [0,0,0] : [(gmin[0]+gmax[0])/2,(gmin[1]+gmax[1])/2,(gmin[2]+gmax[2])/2];
      const ghalf = gmin[0] === Infinity ? 1000 : Math.max(gmax[0]-gmin[0], gmax[1]-gmin[1], gmax[2]-gmin[2]) / 2;
      const children = subs.map(({ i, bb }) => {
        let box = [center[0],center[1],center[2], ghalf,0,0, 0,ghalf,0, 0,0,ghalf], ge = ghalf/8;
        if (bb) { const cx=(bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz=(bb.min.z+bb.max.z)/2;
          const hx=Math.max(1,(bb.max.x-bb.min.x)/2), hy=Math.max(1,(bb.max.y-bb.min.y)/2), hz=Math.max(1,(bb.max.z-bb.min.z)/2);
          box=[cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz]; ge=Math.max(hx,hy,hz)/8; }
        return { boundingVolume: { box }, geometricError: ge, refine: 'ADD',
          content: { uri: `/geosplats/tile.glb?url=${enc(modelUrl)}&m=${i}&grid=1&oct=0&lod=${lod}` } };
      });
      // boxes are in raw local coords; root.transform recenters (−center) + places them on the globe.
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

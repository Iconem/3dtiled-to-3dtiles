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
import { readSog, writeGlb, MemoryReadFileSystem, MemoryFileSystem } from '@playcanvas/splat-transform';
import { CORS, sendJson, sendGlb, llhToEcef, enuFrame } from '../core/index.js';

const REFERER = 'https://www.maptiler.com/';
const D2R = Math.PI / 180;
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
// Euler (deg) → column-major rotation, order Rz·Ry·Rx.
function euler(xd, yd, zd) {
  const cx=Math.cos(xd*D2R), sx=Math.sin(xd*D2R), cy=Math.cos(yd*D2R), sy=Math.sin(yd*D2R), cz=Math.cos(zd*D2R), sz=Math.sin(zd*D2R);
  // R = Rz*Ry*Rx (row-major), emitted column-major
  const m = [
    cz*cy,            sz*cy,           -sy,
    cz*sy*sx - sz*cx, sz*sy*sx + cz*cx, cy*sx,
    cz*sy*cx + sz*sx, sz*sy*cx - cz*sx, cy*cx,
  ];
  return [ m[0],m[1],m[2],0, m[3],m[4],m[5],0, m[6],m[7],m[8],0, 0,0,0,1 ];
}

// 3D Tiles root transform placing GeoSplats local (Y-up) coords on the globe from `global_position`.
// Frame columns [East, −Up, North] bake the splat Y-up→ECEF Z-up (the lccGeoref convention), then
// model_scale + the Euler offset orient the model. Column-major.
function georefTransform(gp) {
  const e = llhToEcef(gp.lon, gp.lat, gp.alt || 0);
  const { EAST: E, NORTH: N, UP: U } = enuFrame(gp.lon, gp.lat);
  const place = [ E[0],E[1],E[2],0,  -U[0],-U[1],-U[2],0,  N[0],N[1],N[2],0,  e[0],e[1],e[2],1 ];  // [East,−Up,North,origin]
  const s = gp.model_scale || 1, o = gp.offset || {};
  const scale = [ s,0,0,0, 0,s,0,0, 0,0,s,0, (o.x||0),(o.y||0),(o.z||0),1 ];
  const rot = euler(o.x_rot || 0, o.y_rot || 0, o.z_rot || 0);
  return matMul(matMul(place, scale), rot);
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
      const root = { transform: georefTransform(gp), geometricError: 1e6, refine: 'ADD',
        boundingVolume: { sphere: [0, 0, 0, 5e5] }, children: [] };
      const enc = (o) => encodeURIComponent(o);
      // One tile per sub-model (grid_1 / octant_0). bbox from its metadata (local coords → tile space).
      await Promise.all((model.models || []).map(async (sm, i) => {
        let box = [0,0,0, 500,0,0, 0,500,0, 0,0,500], ge = 32;
        try {
          const meta = await fetchMeta(splatsBase, modelId, sm.baseurl, key);
          const bb = meta.bounding_box; if (bb) {
            const cx=(bb.min.x+bb.max.x)/2, cy=(bb.min.y+bb.max.y)/2, cz=(bb.min.z+bb.max.z)/2;
            const hx=Math.max(1,(bb.max.x-bb.min.x)/2), hy=Math.max(1,(bb.max.y-bb.min.y)/2), hz=Math.max(1,(bb.max.z-bb.min.z)/2);
            box = [cx,cy,cz, hx,0,0, 0,hy,0, 0,0,hz]; ge = Math.max(hx,hy,hz)/8;
          }
        } catch {}
        root.children.push({ boundingVolume: { box }, geometricError: ge, refine: 'ADD',
          content: { uri: `/geosplats/tile.glb?url=${enc(modelUrl)}&m=${i}&grid=1&oct=0&lod=${lod}` } });
      }));
      const ts = { asset: { version: '1.1', tilesetVersion: 'geosplats' }, geometricError: 1e6, root };
      return void sendJson(res, ts), true;
    }

    if (u.pathname === '/geosplats/tile.glb') {
      const model = await fetchModel(modelUrl);
      const sm = (model.models || [])[Number(u.searchParams.get('m')) || 0];
      if (!sm) { res.writeHead(404, CORS); res.end('submodel not found'); return true; }
      const grid = Number(u.searchParams.get('grid')) || 1, oct = Number(u.searchParams.get('oct')) || 0;
      const dt = await octantDataTable(splatsBase, modelId, sm.baseurl, key, grid, oct, lod);
      const mfs = new MemoryFileSystem();
      await writeGlb({ filename: 'o.glb', dataTable: dt }, mfs);
      const out = mfs.results.get('o.glb');
      const u8 = out instanceof Uint8Array ? out : new Uint8Array(out);
      return void sendGlb(res, Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)), true;
    }

    res.writeHead(404, CORS); res.end('try /geosplats/tileset.json?url=<model.json>'); return true;
  } catch (e) {
    console.error('[geosplats-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end();
    return true;
  }
}

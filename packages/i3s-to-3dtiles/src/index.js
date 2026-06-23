#!/usr/bin/env node
/**
 * i3s-to-3dtiles  —  DRAFT, UNTESTED (no I3S sample available in this repo to validate against)
 *
 *   node src/index.js <extracted-slpk-dir | service-mirror-dir> <outDir>
 *
 * Converts the SUPPORTED SUBSET of Esri I3S → OGC 3D Tiles 1.1:
 *   ✓ Explicit nodePage-indexed trees (I3S has no implicit/template tiling — always explicit)
 *   ✓ IntegratedMesh / 3DObject layers with UNCOMPRESSED DefaultGeometrySchema  → glTF TRIANGLES
 *   ✓ PointCloud layers (uncompressed positions)                                 → glTF POINTS
 *   ✓ OBB bounding volumes → 3D Tiles `box`;  node tree → REPLACE-refine tileset tree
 *
 * EXPLICITLY NOT SUPPORTED (the converter detects and WARNs/skips, per the user's request to
 * gate to a few standard schemes):
 *   ✗ Draco-compressed geometry      ✗ textures / PBR materials      ✗ per-feature attributes
 *   ✗ legacy per-node 3dNodeIndexDocument index (pre-1.7)            ✗ Point (symbol/instance) layers
 *   ✗ Building Scene Layer (composite of sublayers)                  ✗ non-WGS84 / vertical CRS nuance
 *
 * SLPK input: an `.slpk` is a plain zip — extract it first (`unzip foo.slpk -d dir/`) and pass dir.
 * Resource files may be gzip'd inside; that is handled transparently.
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { readSceneLayer, loadNodePages, decodeDefaultGeometry, obbToBox, readMaybeGzip, geodeticToEcef } from './i3sParse.js';
import { buildGlb } from './glbBuild.js';

const MESH_TYPES  = new Set(['IntegratedMesh', '3DObject']);
const POINT_TYPES = new Set(['PointCloud']);

function die(msg)  { throw new Error(msg); }   // in-process: throw (CLI shim catches → exit 1)
function warn(msg) { console.warn('  ⚠️  ' + msg); }

/** Uniform in-process entry: convert an extracted I3S SLPK / REST-mirror dir → 3D Tiles. */
export async function convert(inDir, outDir, opts = {}) {
  if (!inDir || !outDir) die('Usage: i3s-to-3dtiles <extracted-slpk-dir> <outDir>');

  console.log('┌─ i3s-to-3dtiles (DRAFT — validate output before trusting it) ─┐');

  const layer = await readSceneLayer(inDir);
  console.log(`  layerType=${layer.layerType}  version=${layer.version}  geometry=${layer.geometryEncoding}  sr=${JSON.stringify(layer.sr)}`);

  const isMesh  = MESH_TYPES.has(layer.layerType);
  const isPoint = POINT_TYPES.has(layer.layerType);
  if (!isMesh && !isPoint)
    die(`layerType "${layer.layerType}" is out of this draft's scope. Supported: ${[...MESH_TYPES, ...POINT_TYPES].join(', ')}. `
      + `(Point/symbol-instance layers and Building Scene Layers are not implemented.)`);
  if (layer.geometryEncoding === 'draco')
    die('Layer uses Draco-compressed geometry only — not supported by this draft (no Draco decoder). '
      + 'Re-export the layer uncompressed, or use a full I3S loader (loaders.gl / Cesium ion).');
  if (layer.geometryEncoding === 'lepcc')
    // PointCloud layers store positions LEPCC/PCSL-compressed (encoding "lepcc-xyz", files
    // nodes/<id>/geometries/0.bin.pccxyz with a "LEPCC" magic). This draft has no LEPCC decoder.
    // Grounded against SMALL_AUTZEN_LAS_All.slpk, which is exactly this case.
    die('PointCloud layer uses LEPCC/PCSL-compressed positions (store.defaultGeometrySchema.encoding '
      + '"lepcc-xyz", *.bin.pccxyz) — not supported by this draft (no LEPCC decoder). '
      + 'Use a full I3S loader (loaders.gl) to read this point cloud.');

  const schema = layer.raw.store?.defaultGeometrySchema || null;
  const isGeographic = (layer.sr?.latestWkid === 4326 || layer.sr?.wkid === 4326);
  if (!isGeographic) warn(`spatial reference is not WGS84 geographic (wkid ${layer.sr?.wkid}); OBB→ECEF mapping is unverified for projected CRS.`);

  const nodes = await loadNodePages(inDir, layer.nodesPerPage);
  console.log(`  ${nodes.length} nodes in node pages`);

  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });

  let textureSkips = 0, attrSkips = 0, written = 0, emptyNodes = 0;

  // ONE shared LOCAL ENU frame for the whole tileset, at the root node's OBB centre. Geometry +
  // boxes are stored in East/North/Up METRES relative to that origin (so up is vertical, the ground
  // is horizontal, and boxes are axis-aligned to the local horizon — not tilted ECEF). Only the ROOT
  // tile carries the ENU→ECEF `transform`; descendants inherit it. (A per-tile transform would
  // COMPOUND down the tree — 3D Tiles multiplies child×parent — and fling deep tiles off the planet.)
  const originGeo = isGeographic ? nodes[0].obb.center : [0, 0, 0];
  const originEcef = geodeticToEcef(originGeo);
  // ENU basis at the origin (unit East/North/Up vectors in ECEF).
  const lon0 = originGeo[0] * Math.PI/180, lat0 = originGeo[1] * Math.PI/180;
  const sLon = Math.sin(lon0), cLon = Math.cos(lon0), sLat = Math.sin(lat0), cLat = Math.cos(lat0);
  const EAST  = [-sLon, cLon, 0];
  const NORTH = [-sLat*cLon, -sLat*sLon, cLat];
  const UP    = [cLat*cLon, cLat*sLon, sLat];
  // ECEF → ENU-local metres (dot the ECEF offset with each basis vector).
  const toEnu = (e) => { const dx=e[0]-originEcef[0], dy=e[1]-originEcef[1], dz=e[2]-originEcef[2];
    return [dx*EAST[0]+dy*EAST[1]+dz*EAST[2], dx*NORTH[0]+dy*NORTH[1]+dz*NORTH[2], dx*UP[0]+dy*UP[1]+dz*UP[2]]; };

  // Axis-aligned bounding box in the shared-origin frame, built from the ACTUAL geometry (then
  // unioned with children). This guarantees geometry ⊆ box (the I3S OBB quaternion is in a local
  // frame that doesn't match our per-vertex-geodetic placement, so using it gave boxes that were
  // rotated wrong and didn't contain the mesh). No rotation → clean culling/refinement.
  const newAabb = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const expand = (a, x, y, z) => { if (x<a.min[0])a.min[0]=x; if(y<a.min[1])a.min[1]=y; if(z<a.min[2])a.min[2]=z; if(x>a.max[0])a.max[0]=x; if(y>a.max[1])a.max[1]=y; if(z>a.max[2])a.max[2]=z; };
  const unionAabb = (a, b) => { for (let k=0;k<3;k++){ if(b.min[k]<a.min[k])a.min[k]=b.min[k]; if(b.max[k]>a.max[k])a.max[k]=b.max[k]; } };
  const aabbToBox = (a) => { const c=[0,1,2].map(k=>(a.min[k]+a.max[k])/2); const h=[0,1,2].map(k=>Math.max((a.max[k]-a.min[k])/2,0.5)); return [c[0],c[1],c[2], h[0],0,0, 0,h[1],0, 0,0,h[2]]; };

  // Build a 3D Tiles tile per I3S node (recursively). Returns { tile, aabb } so the parent can
  // grow its bounding box to enclose all descendants (3D Tiles requires parent ⊇ children).
  const buildTile = async (idx) => {
    const node = nodes[idx];
    if (!node) return null;
    const aabb = newAabb();
    const tile = {
      geometricError: 0,   // set from the final AABB below (so it shrinks with depth → camera-dependent refine)
      refine: 'REPLACE',
    };

    // Mesh layers (v1.7+) reference geometry via node.mesh.geometry.resource (validated on
    // Buildings_NewYork_v18). Uncompressed point clouds carry a top-level resourceId and no `mesh`
    // block (cf. Autzen) — support both. The uncompressed buffer is geometries/<bufferIndex>.bin.
    const bufIdx = layer.uncompressedBufferIndex >= 0 ? layer.uncompressedBufferIndex : 0;
    const mesh = node.mesh;
    const res = mesh?.geometry ? mesh.geometry.resource
              : (Number.isInteger(node.resourceId) ? node.resourceId : null);
    if (res != null) {
      if (mesh?.material && mesh.material.resource >= 0) textureSkips++;  // texture resource present → dropped
      if (mesh?.attribute) attrSkips++;           // per-feature attributes present → dropped
      const buf = await readMaybeGzip(inDir, `nodes/${res}/geometries/${bufIdx}.bin`)
        .catch(() => readMaybeGzip(inDir, `geometries/${res}.bin`).catch(() => null));
      if (!buf) { warn(`node ${idx}: geometry resource ${res} not found; emitting empty node`); emptyNodes++; }
      else {
        const g = decodeDefaultGeometry(buf, schema);
        if (g.vertexCount > 0) {
          // I3S geographic vertices = (Δlon°, Δlat°, Δheight_m) rel. to the node OBB centre →
          // per-vertex geodetic → ECEF → local ENU metres (East,North,Up). The bounding box is stored
          // in the tileset ENU frame (E,N,U); the glTF POSITION is pre-swizzled to (E, U, −N) so the
          // renderer's glTF-Y-up → tileset-Z-up RX(+90°) yields (E,N,U), and the root ENU→ECEF transform
          // places it upright on the globe. (Storing ECEF axes instead left content tilted ~40° vs the
          // local horizon — the "boxes rotated / plane perpendicular to ground" artefact.)
          let positions = g.position;
          if (isGeographic) {
            const c = node.obb.center;
            positions = new Float32Array(g.vertexCount * 3);
            for (let i = 0; i < g.vertexCount; i++) {
              const e = geodeticToEcef([c[0] + g.position[i*3], c[1] + g.position[i*3+1], c[2] + g.position[i*3+2]]);
              const u = toEnu(e);                                  // (East, North, Up) — tileset frame
              expand(aabb, u[0], u[1], u[2]);                      // box in tileset ENU frame
              positions[i*3] = u[0]; positions[i*3+1] = u[2]; positions[i*3+2] = -u[1];  // glTF: (E, U, −N)
            }
          } else {
            for (let i = 0; i < g.vertexCount; i++) expand(aabb, positions[i*3], positions[i*3+1], positions[i*3+2]);
          }
          const glb = buildGlb({ mode: isPoint ? 'POINTS' : 'TRIANGLES', positions, normals: g.normal, colors: g.color });
          const uri = `tiles/node_${idx}.glb`;
          await fs.writeFile(path.join(outDir, uri), glb);
          tile.content = { uri };
          written++;
        }
      }
    }

    if (node.children && node.children.length) {
      const kids = [];
      for (const ci of node.children) { const r = await buildTile(ci); if (r) { kids.push(r.tile); unionAabb(aabb, r.aabb); } }
      if (kids.length) tile.children = kids;
    }

    // Fallback for an empty node (no geometry, no children): a small box at its OBB centre (ENU).
    if (!isFinite(aabb.min[0])) {
      const lc = isGeographic ? toEnu(geodeticToEcef(node.obb.center)) : [0, 0, 0];
      expand(aabb, lc[0]-1, lc[1]-1, lc[2]-1); expand(aabb, lc[0]+1, lc[1]+1, lc[2]+1);
    }
    const box = aabbToBox(aabb);
    tile.boundingVolume = { box };
    // geometricError = half the tile's bounding-box diagonal → shrinks as tiles subdivide, so the
    // renderer only refines tiles that are large on screen (leaves = 0). Fixes "all tiles always load".
    const diag = 2 * Math.hypot(box[3], box[7], box[11]);
    tile.geometricError = (tile.children && tile.children.length) ? diag * 0.5 : 0;
    return { tile, aabb };
  };

  const rootResult = await buildTile(0);
  if (!rootResult) die('root node (index 0) missing');
  const root = rootResult.tile;

  // The ONE transform for the whole tileset: ENU→ECEF at the origin (column-major; columns =
  // East, North, Up basis vectors, then the origin translation). Maps the local ENU-metre frame —
  // in which all geometry + boxes are expressed — onto the globe, upright. Descendants inherit it.
  if (isGeographic) {
    root.transform = [
      EAST[0],  EAST[1],  EAST[2],  0,
      NORTH[0], NORTH[1], NORTH[2], 0,
      UP[0],    UP[1],    UP[2],    0,
      originEcef[0], originEcef[1], originEcef[2], 1,
    ];
  }

  const tileset = {
    asset: { version: '1.1' },
    geometricError: root.geometricError || 1e6,
    root,
    extensionsUsed: ['3DTILES_content_gltf'],
  };
  await fs.writeFile(path.join(outDir, 'tileset.json'), JSON.stringify(tileset, null, 2));

  console.log(`└─ done → ${outDir}/tileset.json  (${written} GLB tiles)`);
  if (textureSkips) warn(`${textureSkips} nodes had materials/textures — DROPPED (geometry only).`);
  if (attrSkips)    warn(`${attrSkips} nodes had per-feature attributes — DROPPED.`);
  if (emptyNodes)   warn(`${emptyNodes} nodes had no readable geometry.`);
  console.log('  NOTE: draft — geographic-WGS84 mesh placement validated on NYC; projected CRS unverified.');
  return { format: 'i3s', outDir, tiles: written };
}

// ── CLI shim: run only when invoked directly (not when imported by the meta-converter) ──
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [inDir, outDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  convert(inDir, outDir).then(() => process.exit(0)).catch(e => { console.error('ERROR: ' + (e.stack || e.message)); process.exit(1); });
}

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
import { readSceneLayer, loadNodePages, decodeDefaultGeometry, obbToBox, readMaybeGzip } from './i3sParse.js';
import { buildGlb } from './glbBuild.js';

const MESH_TYPES  = new Set(['IntegratedMesh', '3DObject']);
const POINT_TYPES = new Set(['PointCloud']);

function die(msg)  { console.error('ERROR: ' + msg); process.exit(1); }
function warn(msg) { console.warn('  ⚠️  ' + msg); }

async function convert() {
  const [inDir, outDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!inDir || !outDir) die('Usage: node src/index.js <extracted-slpk-dir> <outDir>');

  console.log('┌─ i3s-to-3dtiles (DRAFT — UNTESTED; validate output before trusting it) ─┐');

  const layer = await readSceneLayer(inDir);
  console.log(`  layerType=${layer.layerType}  version=${layer.version}  geometry=${layer.geometryEncoding}  sr=${JSON.stringify(layer.sr)}`);

  const isMesh  = MESH_TYPES.has(layer.layerType);
  const isPoint = POINT_TYPES.has(layer.layerType);
  if (!isMesh && !isPoint)
    die(`layerType "${layer.layerType}" is out of this draft's scope. Supported: ${[...MESH_TYPES, ...POINT_TYPES].join(', ')}. `
      + `(Point/symbol-instance layers and Building Scene Layers are not implemented.)`);
  if (layer.geometryEncoding === 'draco')
    die('Layer uses Draco-compressed geometry — not supported by this draft (no Draco decoder). '
      + 'Re-export the layer uncompressed, or use a full I3S loader (loaders.gl / Cesium ion).');

  const schema = layer.raw.store?.defaultGeometrySchema || null;
  const isGeographic = (layer.sr?.latestWkid === 4326 || layer.sr?.wkid === 4326);
  if (!isGeographic) warn(`spatial reference is not WGS84 geographic (wkid ${layer.sr?.wkid}); OBB→ECEF mapping is unverified for projected CRS.`);

  const nodes = await loadNodePages(inDir, layer.nodesPerPage);
  console.log(`  ${nodes.length} nodes in node pages`);

  await fs.mkdir(path.join(outDir, 'tiles'), { recursive: true });

  let textureSkips = 0, attrSkips = 0, written = 0, emptyNodes = 0;

  // Build a 3D Tiles tile per I3S node (recursively), mirroring children.
  const buildTile = async (idx) => {
    const node = nodes[idx];
    if (!node) return null;
    const box = obbToBox(node.obb, isGeographic);
    const halfMax = Math.max(...node.obb.halfSize);
    const tile = {
      boundingVolume: { box },
      geometricError: (node.children && node.children.length) ? halfMax * 2 : 0,
      refine: 'REPLACE',
    };

    const mesh = node.mesh;
    if (mesh?.geometry) {
      if (mesh.material) textureSkips++;          // material/texture present → dropped (geometry only)
      if (mesh.attribute) attrSkips++;            // per-feature attributes present → dropped
      const res = mesh.geometry.resource;
      const buf = await readMaybeGzip(inDir, `nodes/${res}/geometries/0.bin`)
        .catch(() => readMaybeGzip(inDir, `geometries/${res}.bin`).catch(() => null));
      if (!buf) { warn(`node ${idx}: geometry resource ${res} not found; emitting empty node`); emptyNodes++; }
      else {
        const g = decodeDefaultGeometry(buf, schema);
        if (g.vertexCount > 0) {
          const glb = buildGlb({
            mode: isPoint ? 'POINTS' : 'TRIANGLES',
            positions: g.position, normals: g.normal, colors: g.color,
          });
          // I3S vertices are relative to the node origin; place via a translation to the OBB
          // centre in ECEF. ⚠️ If a layer stores ENU-rotated locals this needs the OBB rotation too.
          const c = box.slice(0, 3);
          const uri = `tiles/node_${idx}.glb`;
          await fs.writeFile(path.join(outDir, uri), glb);
          tile.content = { uri };
          tile.transform = [1,0,0,0, 0,1,0,0, 0,0,1,0, c[0],c[1],c[2],1];  // column-major translate
          written++;
        }
      }
    }

    if (node.children && node.children.length) {
      const kids = [];
      for (const ci of node.children) { const t = await buildTile(ci); if (t) kids.push(t); }
      if (kids.length) tile.children = kids;
    }
    return tile;
  };

  const root = await buildTile(0);
  if (!root) die('root node (index 0) missing');

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
  console.log('  NOTE: this is a draft. Offsets, CRS/ECEF placement, and the resource path layout');
  console.log('        are spec-derived but UNVALIDATED. Verify against your data before relying on it.');
}

convert().catch(e => die(e.stack || String(e)));

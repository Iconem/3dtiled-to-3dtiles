/**
 * i3sParse.js  (i3s-to-3dtiles)  — DRAFT, UNTESTED
 *
 * Readers for Esri I3S (Indexed 3D Scene Layer) v1.7/1.8, scoped to the subset this draft
 * targets: nodePage-indexed trees with UNCOMPRESSED `DefaultGeometrySchema` meshes, plus
 * point clouds. Grounded in the spec (https://github.com/esri/i3s-spec, docs/1.8) but NOT yet
 * validated against a real SLPK — there is no I3S sample in this repo. Treat every offset/CRS
 * assumption as provisional until run against actual data; see the WARN gates in index.js.
 *
 * Input is a *pre-extracted* SLPK directory (an SLPK is a plain zip — `unzip foo.slpk -d dir/`)
 * or a REST-service mirror with the same on-disk layout. Resources inside an SLPK are commonly
 * gzip-compressed (`.json.gz`, `.bin.gz`); readMaybeGzip transparently handles both.
 */

import fs   from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

/** Read a file that may be stored plain or gzip'd (`name` or `name.gz`); returns a Buffer. */
export async function readMaybeGzip(dir, name) {
  for (const cand of [name, name + '.gz']) {
    const p = path.join(dir, cand);
    const buf = await fs.readFile(p).catch(() => null);
    if (buf) return cand.endsWith('.gz') ? zlib.gunzipSync(buf) : buf;
  }
  throw new Error(`I3S resource not found: ${name} (nor ${name}.gz) in ${dir}`);
}

const readJson = async (dir, name) => JSON.parse((await readMaybeGzip(dir, name)).toString('utf8'));

/** Parse 3dSceneLayer.json (the layer root metadata). */
export async function readSceneLayer(dir) {
  const sl = await readJson(dir, '3dSceneLayer.json');
  const enc = detectGeometryEncoding(sl);
  return {
    raw: sl,
    layerType: sl.layerType,                                   // 'IntegratedMesh' | '3DObject' | 'Point' | 'PointCloud' | 'Building' ...
    version: sl.store?.version,
    sr: sl.spatialReference || sl.store?.spatialReference,     // {wkid, latestWkid, vcsWkid?}
    // nodesPerPage lives under `nodePages` (top level, validated on NY v1.8) for mesh layers and
    // under `store.index` (validated on Autzen PointCloud v2.0) for point-cloud layers.
    nodesPerPage: sl.nodePages?.nodesPerPage ?? sl.store?.index?.nodesPerPage ?? 64,
    geometryEncoding: enc.encoding,                            // 'uncompressed' | 'draco' | 'lepcc' | 'unknown'
    // Index into geometryDefinitions[def].geometryBuffers of an UNCOMPRESSED buffer, or -1.
    // I3S mesh layers ship BOTH an uncompressed buffer (buffer 0) AND a Draco buffer (buffer 1)
    // in the same geometryDefinition; we pick the uncompressed one and ignore Draco entirely.
    uncompressedBufferIndex: enc.uncompressedBufferIndex,
  };
}

/**
 * Detect the geometry encoding the layer actually stores on disk.
 *
 * MESH layers (`geometryDefinitions[].geometryBuffers[]`): Esri commonly ships TWO buffers per
 * definition — an UNCOMPRESSED one (buffer 0, the `position/normal/uv0/color` arrays referenced
 * by `store.defaultGeometrySchema`) and a Draco-compressed one (buffer 1, `compressedAttributes`).
 * The layer is convertible whenever ANY buffer is uncompressed — we use that one. Only a layer with
 * NO uncompressed buffer (Draco-only) is genuinely unsupported. (Verified on Buildings_NewYork_v18:
 * buffers[0]=uncompressed Float32 pos/nrm/uv0 + U8 color, buffers[1]=draco — so it IS convertible.)
 *
 * POINT-CLOUD layers carry no geometryDefinitions; the encoding is on
 * `store.defaultGeometrySchema.encoding` ("lepcc-xyz" → LEPCC/PCSL compressed, NOT the plain
 * Float64 PerAttributeArray the schema's vertexAttributes nominally describe). LEPCC has no decoder
 * here, so it is reported as 'lepcc' and gated out. (Verified on SMALL_AUTZEN_LAS_All: encoding
 * "lepcc-xyz", geometry file nodes/0/geometries/0.bin.pccxyz with a "LEPCC" magic header.)
 */
function detectGeometryEncoding(sl) {
  const defs = sl.geometryDefinitions || [];
  if (defs.length) {
    let uncompressedBufferIndex = -1, hasDraco = false;
    for (const d of defs) {
      const bufs = d.geometryBuffers || [];
      for (let i = 0; i < bufs.length; i++) {
        if (bufs[i].compressedAttributes) hasDraco = true;     // I3S Draco lives under compressedAttributes
        else if (uncompressedBufferIndex < 0) uncompressedBufferIndex = i;
      }
      if (uncompressedBufferIndex >= 0) break;                 // first definition with a plain buffer wins
    }
    if (uncompressedBufferIndex >= 0) return { encoding: 'uncompressed', uncompressedBufferIndex };
    if (hasDraco) return { encoding: 'draco', uncompressedBufferIndex: -1 };
  }
  // Point-cloud / legacy single-schema layers: look at the defaultGeometrySchema encoding.
  const schemaEnc = sl.store?.defaultGeometrySchema?.encoding;
  if (typeof schemaEnc === 'string' && schemaEnc.toLowerCase().startsWith('lepcc'))
    return { encoding: 'lepcc', uncompressedBufferIndex: -1 };
  // No geometryDefinitions and no compressed encoding flag → assume uncompressed PerAttributeArray.
  return { encoding: 'uncompressed', uncompressedBufferIndex: -1 };
}

/**
 * Load and flatten all node pages into a single array indexed by node index.
 * nodePages live at `nodepages/<pageId>.json[.gz]`, each `{ nodes: [...] }`.
 */
export async function loadNodePages(dir, nodesPerPage) {
  const nodes = [];
  for (let page = 0; ; page++) {
    let pg;
    try { pg = await readJson(dir, `nodepages/${page}.json`); }
    catch { break; }                                     // first missing page => done
    // Mesh nodes (v1.7+) carry an explicit global `index`; place by it so the tree's child
    // indices resolve regardless of page ordering/gaps. Point-cloud nodes (Autzen) omit `index`
    // — fall back to append order, which equals the global index for a single contiguous page set.
    for (const n of pg.nodes) {
      if (Number.isInteger(n.index)) nodes[n.index] = n;
      else nodes.push(n);
    }
    if (pg.nodes.length < nodesPerPage) break;           // short page => last page
  }
  if (!nodes.length) throw new Error('No node pages found (nodepages/0.json). Legacy 3dNodeIndexDocument layers are not supported by this draft.');
  return nodes;
}

/**
 * I3S OBB → 3D Tiles `box` [cx,cy,cz, x.x,x.y,x.z, y.x,y.y,y.z, z.x,z.y,z.z] in ECEF.
 * obb.center is in the layer CRS (global layers: WGS84 lon°,lat°,height m). obb.quaternion
 * orients an ECEF-axis-aligned box; halfSize scales each local axis. We convert the center to
 * ECEF and rotate the three unit axes by the quaternion.  ⚠️ CRS handling unverified.
 */
const WGS84_A = 6378137.0, WGS84_E2 = 6.69437999014e-3;
export function geodeticToEcef([lonDeg, latDeg, h]) {
  const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat);
  return [ (N + h) * cLat * Math.cos(lon), (N + h) * cLat * Math.sin(lon), (N * (1 - WGS84_E2) + h) * sLat ];
}
function rotateByQuat([x, y, z, w], [vx, vy, vz]) {
  // v + 2*cross(q.xyz, cross(q.xyz, v) + w*v)
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [ vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx) ];
}
export function obbToBox(obb, isGeographic = true) {
  const c = isGeographic ? geodeticToEcef(obb.center) : obb.center;
  const q = obb.quaternion || [0, 0, 0, 1];
  const [hx, hy, hz] = obb.halfSize;
  const ax = rotateByQuat(q, [1, 0, 0]), ay = rotateByQuat(q, [0, 1, 0]), az = rotateByQuat(q, [0, 0, 1]);
  return [ c[0], c[1], c[2],
           ax[0]*hx, ax[1]*hx, ax[2]*hx,
           ay[0]*hy, ay[1]*hy, ay[2]*hy,
           az[0]*hz, az[1]*hz, az[2]*hz ];
}

/**
 * Decode an UNCOMPRESSED DefaultGeometrySchema buffer (`topology: PerAttributeArray`).
 * Layout = header {vertexCount u32, featureCount u32} then SEQUENTIAL arrays in `ordering`:
 *   position f32[3·V] · normal f32[3·V] · uv0 f32[2·V] · color u8[4·V]
 * then per-feature: id u64[F] · faceRange u32[2·F]. (Only the attributes present in the schema
 * are written; we read in declared order.) Positions are relative to the node origin in the
 * layer's Cartesian frame.  ⚠️ origin/offset application unverified without a sample.
 */
export function decodeDefaultGeometry(buf, schema) {
  const dv = buf;
  let o = 0;
  const vertexCount  = dv.readUInt32LE(o); o += 4;
  const featureCount = dv.readUInt32LE(o); o += 4;
  const order = (schema?.ordering) || ['position', 'normal', 'uv0', 'color'];
  const attr = schema?.vertexAttributes || {
    position: { valueType: 'Float32', valuesPerElement: 3 },
    normal:   { valueType: 'Float32', valuesPerElement: 3 },
    uv0:      { valueType: 'Float32', valuesPerElement: 2 },
    color:    { valueType: 'UInt8',   valuesPerElement: 4 },
  };
  const out = { vertexCount, featureCount };
  for (const key of order) {
    const a = attr[key]; if (!a) continue;
    const n = vertexCount * a.valuesPerElement;
    if (a.valueType === 'Float32') {
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) { arr[i] = dv.readFloatLE(o); o += 4; }
      out[key] = arr;
    } else if (a.valueType === 'UInt8') {
      out[key] = Uint8Array.prototype.slice.call(dv, o, o + n); o += n;
    } else {
      throw new Error(`Unsupported vertexAttribute valueType: ${a.valueType} (${key})`);
    }
  }
  // feature arrays (id u64, faceRange u32×2) are skipped — not needed for geometry-only output.
  return out;
}

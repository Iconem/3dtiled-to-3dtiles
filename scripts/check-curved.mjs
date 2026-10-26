// Checks a /stream COPC tileset's placement: for the tile farthest from the origin, the ellipsoidal
// heights of its points after the root transform. A tangent-plane placement of a country-wide
// overview puts those kilometres above the ground; a curved one keeps them at terrain heights.
//   node scripts/check-curved.mjs "http://localhost:3001/stream/tileset.json?format=copc&url=…&crs=EPSG:2154"
import { ecefToLlh } from '../packages/core/geo.js';

const tsUrl = process.argv[2];
const ts = await (await fetch(tsUrl)).json();
const M = ts.root.transform;
const tiles = [];
(function walk(t, depth) { tiles.push({ t, depth }); for (const c of t.children || []) walk(c, depth + 1); })(ts.root, 0);
console.log(`tiles=${tiles.length} implicit=${!!ts.root.implicitTiling} transform=${!!M}`);
const withContent = tiles.filter((x) => x.t.content?.uri);
const far = withContent.reduce((a, b) => (Math.hypot(...b.t.boundingVolume.box.slice(0, 2)) > Math.hypot(...a.t.boundingVolume.box.slice(0, 2)) ? b : a));
const box = far.t.boundingVolume.box;
console.log(`farthest content tile: depth ${far.depth}, box centre ${box.slice(0, 3).map((v) => Math.round(v))}, half ${[box[3], box[7], box[11]].map((v) => Math.round(v))}`);
const glbUrl = new URL(far.t.content.uri, tsUrl).toString();
const buf = new Uint8Array(await (await fetch(glbUrl)).arrayBuffer());
const dv = new DataView(buf.buffer);
const jsonLen = dv.getUint32(12, true);
const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
const binStart = 20 + jsonLen + 8;
const acc = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
const bv = json.bufferViews[acc.bufferView];
// gltf-transform interleaves POSITION with COLOR_0: honour the bufferView stride
const stride = bv.byteStride || 12;
const base = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
const pos = new Float32Array(acc.count * 3);
for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) pos[i*3 + k] = dv.getFloat32(base + i * stride + k * 4, true);
let hMin = Infinity, hMax = -Infinity, outside = 0;
const apply = (x, y, z) => [M[0]*x + M[4]*y + M[8]*z + M[12], M[1]*x + M[5]*y + M[9]*z + M[13], M[2]*x + M[6]*y + M[10]*z + M[14]];
for (let i = 0; i < acc.count; i += Math.max(1, Math.floor(acc.count / 5000))) {
  // glTF Y-up → tile Z-up: (x, y, z) → (x, −z, y)
  const l = [pos[i*3], -pos[i*3 + 2], pos[i*3 + 1]];
  if (Math.abs(l[0] - box[0]) > box[3] || Math.abs(l[1] - box[1]) > box[7] || Math.abs(l[2] - box[2]) > box[11]) outside++;
  const h = ecefToLlh(...apply(...l))[2];
  if (h < hMin) hMin = h; if (h > hMax) hMax = h;
}
console.log(`points=${acc.count} height range ${Math.round(hMin)}..${Math.round(hMax)} m, outside own box: ${outside}`);

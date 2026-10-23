// Repro for "Potree 1.x (Geghard) streaming stops at a given depth".
// 1) Client-side walk: BFS the implicit tiling via potreeSubtree() exactly like 3d-tiles-renderer
//    would (root subtree -> childSubtreeAvailability -> deeper subtrees), counting available tiles
//    per level.
// 2) Ground truth: drill the .hrc chunk chain along the densest branch via loadPotree1's loadChunk
//    to find the true tree depth along that branch.
import { potreeTileset, potreeSubtree, potreeTile } from '../packages/tile-server/potree-live.js';
import { loadPotree1 } from '../packages/potree-to-3dtiles/src/potree1.js';

const URL_ = process.argv[2] || 'https://raw.githubusercontent.com/potree/potree/develop/pointclouds/lion_takanawa/cloud.js';
const SUBTREE_LEVELS = 3;
const MAX_LEVEL = Number(process.argv[3] || 15);

function parseSubtree(buf) {
  const jl = Number(buf.readBigUInt64LE(8));
  const json = JSON.parse(buf.toString('utf8', 24, 24 + jl));
  const bin = buf.subarray(24 + jl);
  const view = (i) => { const bv = json.bufferViews[i]; return bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength); };
  const getBit = (bytes, i) => (bytes[i >> 3] >> (i & 7)) & 1;
  return {
    tileBit: (i) => getBit(view(json.tileAvailability.bitstream), i),
    childBit: (i) => getBit(view(json.childSubtreeAvailability.bitstream), i),
  };
}
function mortonDecode(m) { let x=0,y=0,z=0; for (let i=0;i<7;i++){ x|=((m>>(3*i))&1)<<i; y|=((m>>(3*i+1))&1)<<i; z|=((m>>(3*i+2))&1)<<i; } return {x,y,z}; }

console.log('tileset...');
const ts = await potreeTileset(URL_, { lazy: true });
console.log('root GE', ts.geometricError, 'content GE', ts.root.geometricError, 'availableLevels', ts.root.implicitTiling.availableLevels);

const perLevel = new Map();     // level -> count of available tiles
let frontier = [[0, 0, 0, 0]];  // subtree roots (level,x,y,z)
while (frontier.length) {
  const next = [];
  for (const [L, x, y, z] of frontier) {
    if (L > MAX_LEVEL) continue;
    const buf = await potreeSubtree(URL_, `${L}-${x}-${y}-${z}`);
    const st = parseSubtree(buf);
    let bit = 0;
    for (let d = 0; d < SUBTREE_LEVELS; d++) {
      const stride = 2 ** d, total = stride ** 3;
      for (let m = 0; m < total; m++) {
        if (st.tileBit(bit)) perLevel.set(L + d, (perLevel.get(L + d) || 0) + 1);
        bit++;
      }
    }
    const cs = 2 ** SUBTREE_LEVELS;
    for (let m = 0; m < cs ** 3; m++) {
      if (st.childBit(m)) { const { x: dx, y: dy, z: dz } = mortonDecode(m); next.push([L + SUBTREE_LEVELS, x * cs + dx, y * cs + dy, z * cs + dz]); }
    }
  }
  frontier = next;
  const maxL = Math.max(0, ...perLevel.keys());
  console.log(`  frontier -> ${frontier.length} child subtrees; max avail level so far ${maxL}`);
  if (!frontier.length) break;
  if (frontier.length > 400) { console.log('  (trimming frontier to 400 densest for speed)'); frontier = frontier.slice(0, 400); }
}
console.log('\nCLIENT-SIDE availability per level (via subtree walk):');
for (const [l, c] of [...perLevel.entries()].sort((a, b) => a[0] - b[0])) console.log(`  level ${l}: ${c} tiles`);

// ── ground truth: drill the .hrc chain down the densest branch ──
console.log('\nGROUND TRUTH (.hrc drill):');
const src = await loadPotree1('', { read: async (rel) => { const r = await fetch(URL_.slice(0, URL_.lastIndexOf('/') + 1) + rel); if (!r.ok) throw new Error(`${r.status}`); return Buffer.from(await r.arrayBuffer()); }, lazy: true });
let chunkRoot = 'r', box = src.rootBox, truthMax = 0;
for (let hop = 0; hop < 6; hop++) {
  const boundary = await src.loadChunk(chunkRoot, box);
  let deepest = null;
  for (const [nm, node] of src.nodes) if (node.numPoints > 0 && nm.length - 1 > truthMax) { truthMax = nm.length - 1; }
  // pick the boundary child with most points beneath: just take first boundary that startsWith deepest path
  if (!boundary.length) break;
  // choose boundary whose parent node has max numPoints
  boundary.sort((a, b) => (src.nodes.get(b.name.slice(0, -1))?.numPoints || 0) - (src.nodes.get(a.name.slice(0, -1))?.numPoints || 0));
  deepest = boundary[0];
  console.log(`  chunk ${chunkRoot} loaded; nodes=${src.nodes.size}; boundary=${boundary.length}; next chunk ${deepest.name}`);
  chunkRoot = deepest.name; box = deepest.box;
}
console.log(`  ground-truth max node depth along drilled branch: ${truthMax}`);
console.log(`  client-side max level reached: ${Math.max(...perLevel.keys())}`);

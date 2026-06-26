/**
 * potree1.js — Potree 1.x reader. Handles BOTH hierarchy layouts and BOTH node encodings:
 *
 *   layout: `.hrc`  (1.7) — cloud.js has `hierarchyStepSize`; hierarchy in `<name>.hrc` chunks;
 *                            node files chunked under `data/r/<5-char dirs>/<name>.<ext>`.
 *           inline (1.4) — cloud.js has an inline `hierarchy: [[name,numPoints], …]` array, NO
 *                            hierarchyStepSize, NO `.hrc`; node files FLAT at `data/<name>.<ext>`.
 *   encoding: `.bin` — POSITION_CARTESIAN uint32×3 → pos·scale + NODE.box.min (per-node origin),
 *                       colour uint8×3/4. (`pointAttributes` is an array of attribute names.)
 *             `.laz` — `pointAttributes:"LAZ"`: each node is a standalone LAZ file (absolute LAS
 *                       coords via its own header scale/offset); decoded with laz-perf (copc `Las`).
 *
 * This makes "tiled LAZ" Potree clouds (one .laz per octree node) convertible, e.g. lion_takanawa_laz.
 */
import fs   from 'fs/promises';
import path from 'path';
import { Las } from 'copc';

const ATTR_SIZE = { // bytes per attribute name (Potree 1.x .bin point attribute sizes)
  POSITION_CARTESIAN: 12, RGBA_PACKED: 4, COLOR_PACKED: 4, RGB_PACKED: 3, RGBA: 4, RGB: 3,
  INTENSITY: 2, CLASSIFICATION: 1, RETURN_NUMBER: 1, NUMBER_OF_RETURNS: 1, SOURCE_ID: 2,
  GPS_TIME: 8, NORMAL_FLOATS: 12, NORMAL_OCT16: 2, NORMAL: 12, NORMAL_SPHEREMAPPED: 2,
};

// Potree octant→sub-box mapping (Potree `PointCloudOctreeGeometryNode.createChildAABB`):
// child index bit 0 (0b001) → Z, bit 1 (0b010) → Y, bit 2 (0b100) → X. (NOT bit0→X — that
// X/Z swap put deep nodes in the wrong octant; verified via child→root NN: 0.03 vs 0.81.)
function childBox(box, oct) {
  const mid = [0,1,2].map(k => (box.min[k]+box.max[k])/2);
  const mn = box.min.slice(), mx = box.max.slice();
  if (oct & 1) mn[2] = mid[2]; else mx[2] = mid[2];   // bit0 → Z
  if (oct & 2) mn[1] = mid[1]; else mx[1] = mid[1];   // bit1 → Y
  if (oct & 4) mn[0] = mid[0]; else mx[0] = mid[0];   // bit2 → X
  return { min: mn, max: mx };
}

/**
 * @param {string} dir  dataset dir (used only by the default fs reader)
 * @param {object} [opts] opts.read(relPath) → Promise<Buffer>; relPath is forward-slash relative to
 *   the dataset root (e.g. "cloud.js", "data/r/00000/r00000.bin"). Default reads from local fs.
 *   The live tile-server passes a fetch-based reader so the SAME 1.x logic serves over HTTP.
 */
// Parse cloud.js leniently: it's pure JSON on disk, but when served over HTTP by a dev server that
// transforms .js (e.g. Vite appends an HMR/module footer), there's trailing non-JSON. Extract the
// first balanced {…} object and parse that.
function parseCloudJs(text) {
  try { return JSON.parse(text); } catch { /* fall through to brace extraction */ }
  const s = text.indexOf('{');
  if (s < 0) throw new Error('cloud.js: no JSON object found');
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(s, i + 1));
  }
  throw new Error('cloud.js: unbalanced JSON');
}

export async function loadPotree1(dir, opts = {}) {
  const read = opts.read || (rel => fs.readFile(path.join(dir, ...rel.split('/'))).then(Buffer.from));
  const cloud = parseCloudJs((await read('cloud.js')).toString('utf8'));

  const octreeDir = cloud.octreeDir || 'data';            // forward-slash relative; reader resolves it
  const stepSize  = cloud.hierarchyStepSize ?? 5;
  const bb  = cloud.boundingBox;
  const min = [bb.lx ?? bb.min[0], bb.ly ?? bb.min[1], bb.lz ?? bb.min[2]];
  const max = [bb.ux ?? bb.max[0], bb.uy ?? bb.max[1], bb.uz ?? bb.max[2]];
  const rootBox = { min, max };
  const scale = Array.isArray(cloud.scale) ? cloud.scale : [cloud.scale, cloud.scale, cloud.scale];

  const isLaz   = typeof cloud.pointAttributes === 'string' && /LAZ/i.test(cloud.pointAttributes);
  const inline  = Array.isArray(cloud.hierarchy);          // 1.4 inline-hierarchy layout
  const ext     = isLaz ? 'laz' : 'bin';

  // .bin attribute layout (not used for LAZ nodes, which carry their own LAS header).
  let pointSize = 0; const attrs = [];
  if (!isLaz && Array.isArray(cloud.pointAttributes)) {
    for (const name of cloud.pointAttributes) {
      const sz = ATTR_SIZE[name] ?? (typeof name === 'object' ? name.byteSize : 0);
      attrs.push({ name: (name.name || name), offset: pointSize, size: sz });
      pointSize += sz;
    }
  }
  const posA = attrs.find(a => /POSITION/i.test(a.name));
  const colA = attrs.find(a => /RGBA|RGB|COLOR/i.test(a.name));
  const intA = attrs.find(a => /INTENSITY/i.test(a.name));   // T5: intensity fallback when no colour

  // Node file path: flat for inline (1.4); chunked dirs for .hrc (1.7). Forward-slash relative.
  const chunkDirs = (name) => {                            // ["r","00000",…] up to the node's chunk depth
    const idx = name.substring(1), parts = Math.floor(idx.length / stepSize);
    const segs = ['r'];
    for (let i = 0; i < parts; i++) segs.push(idx.substr(i * stepSize, stepSize));
    return segs;
  };
  const nodeFile = (name) => inline
    ? `${octreeDir}/${name}.${ext}`
    : [octreeDir, ...chunkDirs(name), `${name}.${ext}`].join('/');
  const hrcRel = (name) => [octreeDir, ...chunkDirs(name)].join('/');   // dir holding <name>.hrc

  const nodes = new Map();

  if (inline) {
    // Build the tree directly from the inline [name, numPoints] list; boxes by octant subdivision.
    for (const entry of cloud.hierarchy) {
      const name = entry[0], numPoints = entry[1];
      let box = rootBox;
      for (const ch of name.slice(1)) box = childBox(box, +ch);
      nodes.set(name, { name, numPoints, depth: name.length - 1, box });
    }
  } else {
    // Walk the `.hrc` chunks (5 B/node: childMask u8 + numPoints u32), recursing at chunk edges.
    async function loadHrc(name, box) {
      let buf;
      try { buf = await read(`${hrcRel(name)}/${name}.hrc`); } catch { return; }
      const queue = [{ name, box }]; let rec = 0; const boundary = [];
      while (queue.length && rec * 5 < buf.length) {
        const { name: nm, box: bx } = queue.shift();
        const mask = buf.readUInt8(rec * 5);
        const numPoints = buf.readUInt32LE(rec * 5 + 1);
        rec++;
        nodes.set(nm, { name: nm, numPoints, depth: nm.length - 1, box: bx, mask });
        const depthInChunk = nm.length - name.length;
        for (let c = 0; c < 8; c++) {
          if (!((mask >> c) & 1)) continue;
          const cb = childBox(bx, c), cn = nm + c;
          if (depthInChunk + 1 >= stepSize) boundary.push({ name: cn, box: cb });
          else queue.push({ name: cn, box: cb });
        }
      }
      for (const b of boundary) await loadHrc(b.name, b.box);
    }
    await loadHrc('r', rootBox);
  }

  // ── Node decoders ──────────────────────────────────────────────────────────
  async function readLazNode(node) {
    let bytes; try { bytes = await read(nodeFile(node.name)); } catch { return null; }
    const header = Las.Header.parse(bytes);
    const records = await Las.PointData.decompressFile(bytes);   // laz-perf WASM
    const view = Las.View.create(records, header);
    const n = view.pointCount;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 4);
    const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
    let gr = null, gg = null, gb = null, gi = null;
    try { gr = view.getter('Red'); gg = view.getter('Green'); gb = view.getter('Blue'); } catch { /* no colour */ }
    try { gi = view.getter('Intensity'); } catch { /* no intensity */ }
    // LAS colour is nominally 16-bit; detect 8-bit-in-16 by sampling the max.
    let cmax = 0; if (gr) for (let i = 0; i < Math.min(n, 4096); i++) cmax = Math.max(cmax, gr(i), gg(i), gb(i));
    const cdiv = cmax > 255 ? 65535 : 255;
    for (let i = 0; i < n; i++) {
      positions[i*3] = gx(i); positions[i*3+1] = gy(i); positions[i*3+2] = gz(i);
      if (gr) { colors[i*4]=gr(i)/cdiv; colors[i*4+1]=gg(i)/cdiv; colors[i*4+2]=gb(i)/cdiv; colors[i*4+3]=1; }
      else if (gi) { const v=gi(i)/65535; colors[i*4]=v; colors[i*4+1]=v; colors[i*4+2]=v; colors[i*4+3]=1; } // T5: intensity fallback
      else    { colors[i*4]=colors[i*4+1]=colors[i*4+2]=colors[i*4+3]=1; }
    }
    return { positions, colors, count: n };
  }

  async function readBinNode(node) {
    let buf; try { buf = await read(nodeFile(node.name)); } catch { return null; }
    const n = Math.floor(buf.length / pointSize);
    const positions = new Float32Array(n * 3);
    const colors = (colA || intA) ? new Float32Array(n * 4) : null;
    // Potree 1.x POSITION_CARTESIAN is NODE-RELATIVE: world = raw·scale + THIS NODE's box.min.
    // (Raw values span 0..nodeWidth, so the global cloud min would pile every node at the corner;
    // the node's box.min — from the correct octant subdivision in childBox — places it right.
    // Verified child→root NN ≈ 0.03 m with the Potree octant convention. Root box.min == global min.)
    const nmin = node.box ? node.box.min : min;
    for (let i = 0; i < n; i++) {
      const b = i * pointSize;
      positions[i*3]   = buf.readUInt32LE(b + posA.offset)     * scale[0] + nmin[0];
      positions[i*3+1] = buf.readUInt32LE(b + posA.offset + 4) * scale[1] + nmin[1];
      positions[i*3+2] = buf.readUInt32LE(b + posA.offset + 8) * scale[2] + nmin[2];
      if (colA && colors) { const c=b+colA.offset; colors[i*4]=buf[c]/255; colors[i*4+1]=buf[c+1]/255; colors[i*4+2]=buf[c+2]/255; colors[i*4+3]=1; }
      else if (intA && colors) { const v=buf.readUInt16LE(b+intA.offset)/65535; colors[i*4]=v; colors[i*4+1]=v; colors[i*4+2]=v; colors[i*4+3]=1; } // T5
    }
    return { positions, colors, count: n };
  }

  const readNode = isLaz ? readLazNode : readBinNode;
  // cloud.js may carry a CRS (`projection` = WKT/proj4) — surface it for downstream geo-referencing
  // (e.g. a future potree-to-copc, which needs the CRS in the COPC/LAS WKT VLR).
  const crs = cloud.projection || cloud.srs || cloud.wkt || null;
  return { version: cloud.version || '1.x', meta: cloud, nodes, rootBox, spacing: cloud.spacing, crs, readNode, close: () => {} };
}

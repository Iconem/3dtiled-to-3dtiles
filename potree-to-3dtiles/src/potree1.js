/**
 * potree1.js — Potree 1.x reader (cloud.js + <octreeDir>/ .hrc hierarchy + per-node .bin).
 * Best-effort from Potree's POCLoader.js conventions. UNTESTED (no 1.x sample in repo).
 *
 * cloud.js: { version, octreeDir, boundingBox{lx,ly,lz,ux,uy,uz}, pointAttributes[], scale,
 *             hierarchyStepSize, spacing }.
 * Hierarchy: r.hrc — 5 bytes/node (childMask u8, numPoints u32 LE), BFS within a chunk of
 *   (hierarchyStepSize+1) levels; nodes at the chunk's deepest level recurse into <name>.hrc.
 * Node file path (POCLoader.getHierarchyPath): "r/" + name[1..].chunked(stepSize) + "/" + name + ".bin".
 * Point attrs (common): POSITION_CARTESIAN u32×3 (→ pos·scale + bbox.min), COLOR_PACKED u8×4,
 *   RGBA u8×4, INTENSITY u16, CLASSIFICATION u8, NORMAL_* etc.
 */
import fs from 'fs/promises';
import path from 'path';

const ATTR_SIZE = { // bytes per attribute name (Potree 1.x point attribute byte sizes)
  POSITION_CARTESIAN: 12, RGBA_PACKED: 4, COLOR_PACKED: 4, RGB_PACKED: 3, RGBA: 4, RGB: 3,
  INTENSITY: 2, CLASSIFICATION: 1, RETURN_NUMBER: 1, NUMBER_OF_RETURNS: 1, SOURCE_ID: 2,
  GPS_TIME: 8, NORMAL_FLOATS: 12, NORMAL_OCT16: 2, NORMAL: 12, NORMAL_SPHEREMAPPED: 2,
};

export async function loadPotree1(dir) {
  // cloud.js name can vary; default to cloud.js
  const cloud = JSON.parse(await fs.readFile(path.join(dir, 'cloud.js'), 'utf8'));
  const octreeDir = path.join(dir, cloud.octreeDir || 'data');
  const stepSize = cloud.hierarchyStepSize ?? 5;
  const bb = cloud.boundingBox;
  const min = [bb.lx ?? bb.min[0], bb.ly ?? bb.min[1], bb.lz ?? bb.min[2]];
  const max = [bb.ux ?? bb.max[0], bb.uy ?? bb.max[1], bb.uz ?? bb.max[2]];
  const rootBox = { min, max };
  const scale = Array.isArray(cloud.scale) ? cloud.scale : [cloud.scale, cloud.scale, cloud.scale];

  // attribute layout
  let pointSize = 0; const attrs = [];
  for (const name of cloud.pointAttributes) {
    const sz = ATTR_SIZE[name] ?? (typeof name === 'object' ? name.byteSize : 0);
    attrs.push({ name: (name.name || name), offset: pointSize, size: sz });
    pointSize += sz;
  }
  const posA = attrs.find(a => /POSITION/i.test(a.name));
  const colA = attrs.find(a => /RGBA|RGB|COLOR/i.test(a.name));

  // node directory/file path
  const hierPath = (name) => {
    const idx = name.substring(1);
    const parts = Math.floor(idx.length / stepSize);
    let p = 'r';
    for (let i = 0; i < parts; i++) p = path.join(p, idx.substr(i * stepSize, stepSize));
    return p; // directory; file = <p>/<name>.<ext>
  };

  const nodes = new Map();
  function childBox(box, oct) {
    const mid = [0,1,2].map(k => (box.min[k]+box.max[k])/2);
    const mn = box.min.slice(), mx = box.max.slice();
    for (const k of [0,1,2]) { if ((oct>>k)&1) mn[k]=mid[k]; else mx[k]=mid[k]; }
    return { min: mn, max: mx };
  }

  async function loadHrc(name, box) {
    const hrcFile = path.join(octreeDir, hierPath(name), name + '.hrc');
    let buf;
    try { buf = Buffer.from(await fs.readFile(hrcFile)); } catch { return; }
    // BFS over this chunk
    const queue = [{ name, box }];
    let rec = 0;
    const boundary = [];
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
        if (depthInChunk + 1 >= stepSize) boundary.push({ name: cn, box: cb }); // recurse into sub-.hrc
        else queue.push({ name: cn, box: cb });
      }
    }
    for (const b of boundary) await loadHrc(b.name, b.box);
  }
  await loadHrc('r', rootBox);

  async function readNode(node) {
    const binFile = path.join(octreeDir, hierPath(node.name), node.name + '.bin');
    let buf; try { buf = Buffer.from(await fs.readFile(binFile)); } catch { return null; }
    const n = Math.floor(buf.length / pointSize);
    const positions = new Float32Array(n * 3);
    const colors = colA ? new Float32Array(n * 4) : null;
    for (let i = 0; i < n; i++) {
      const b = i * pointSize;
      positions[i*3]   = buf.readUInt32LE(b + posA.offset)     * scale[0] + min[0];
      positions[i*3+1] = buf.readUInt32LE(b + posA.offset + 4) * scale[1] + min[1];
      positions[i*3+2] = buf.readUInt32LE(b + posA.offset + 8) * scale[2] + min[2];
      if (colors) { const c=b+colA.offset; colors[i*4]=buf.readUInt8(c)/255; colors[i*4+1]=buf.readUInt8(c+1)/255; colors[i*4+2]=buf.readUInt8(c+2)/255; colors[i*4+3]=1; }
    }
    return { positions, colors, count: n };
  }

  return { version: '1.x', meta: cloud, nodes, rootBox, spacing: cloud.spacing, readNode, close: () => {} };
}

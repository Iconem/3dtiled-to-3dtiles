/**
 * potree2.js — Potree 2.0 reader (metadata.json + hierarchy.bin + octree.bin).
 * Layout authoritative from PotreeConverter / OctreeLoader.js and yeyan00/potree23dtiles.
 *
 * hierarchy.bin: 22 bytes/node — type u8, childMask u8, numPoints u32, byteOffset u64, byteSize u64.
 *   type 2 = PROXY: byteOffset/byteSize point to a child hierarchy chunk within hierarchy.bin.
 * octree.bin: per node, `byteSize/pointSize` points; each point = attributes in metadata order.
 *   position = int32×3 → world = position·scale + offset (offset = metadata.offset).
 * encoding: "DEFAULT" (raw interleaved) | "BROTLI" (per-node brotli; Node's zlib.brotliDecompressSync).
 */
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

export async function loadPotree2(dir) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'));
  const attrs = meta.attributes;
  let pointSize = 0;
  for (const a of attrs) { a._offset = pointSize; pointSize += a.size; }
  const posAttr = attrs.find(a => a.name === 'position');
  const colAttr = attrs.find(a => /^rgb/i.test(a.name) || a.name === 'rgba');

  const hierBuf = Buffer.from(await fs.readFile(path.join(dir, 'hierarchy.bin')));
  const octreePath = path.join(dir, 'octree.bin');

  // Parse the node tree (BFS over hierarchy chunks; resolve proxy nodes recursively).
  const NB = 22;
  const nodes = new Map();        // name → { name, numPoints, byteOffset, byteSize, childMask, depth, box }
  const rootBox = { min: meta.boundingBox.min.slice(), max: meta.boundingBox.max.slice() };

  function childBox(box, octant) {
    const mid = [0,1,2].map(k => (box.min[k] + box.max[k]) / 2);
    const min = box.min.slice(), max = box.max.slice();
    // Potree octant bit order: x = bit0, y = bit1, z = bit2 (see PotreeConverter)
    for (const k of [0,1,2]) { if ((octant >> k) & 1) min[k] = mid[k]; else max[k] = mid[k]; }
    return { min, max };
  }

  function parseChunk(buf, rootName, rootBoxLocal) {
    // breadth-first within this chunk; queue of {name, box, recordIndex}
    const queue = [{ name: rootName, box: rootBoxLocal, idx: 0 }];
    const numRec = Math.floor(buf.length / NB);
    let nextIdx = 1;
    // The chunk serialises nodes in BFS order; record idx tracks position.
    const seen = new Set();
    while (queue.length) {
      const { name, box, idx } = queue.shift();
      const o = idx * NB;
      if (o + NB > buf.length) continue;
      const type = buf.readUInt8(o);
      const childMask = buf.readUInt8(o + 1);
      const numPoints = buf.readUInt32LE(o + 2);
      const byteOffset = Number(buf.readBigUInt64LE(o + 6));
      const byteSize = Number(buf.readBigUInt64LE(o + 14));
      const depth = name.length - 1;

      if (type === 2) {
        // proxy: descend into the referenced sub-chunk
        proxies.push({ name, box, byteOffset, byteSize });
        continue;
      }
      nodes.set(name, { name, numPoints, byteOffset, byteSize, depth, box });
      for (let c = 0; c < 8; c++) {
        if (!((childMask >> c) & 1)) continue;
        const cname = name + c;
        if (seen.has(cname)) continue; seen.add(cname);
        queue.push({ name: cname, box: childBox(box, c), idx: nextIdx++ });
      }
    }
  }

  // Proxies are resolved iteratively (root chunk → child chunks).
  const proxies = [];
  const firstChunk = hierBuf.subarray(0, meta.hierarchy.firstChunkSize);
  parseChunk(firstChunk, 'r', rootBox);
  while (proxies.length) {
    const p = proxies.shift();
    const sub = hierBuf.subarray(p.byteOffset, p.byteOffset + p.byteSize);
    parseChunk(sub, p.name, p.box);
  }

  const fh = await fs.open(octreePath, 'r');
  async function readNode(node) {
    if (!node.byteSize) return null;
    const raw = Buffer.alloc(node.byteSize);
    await fh.read(raw, 0, node.byteSize, node.byteOffset);
    let buf = raw;
    if ((meta.encoding || 'DEFAULT').toUpperCase() === 'BROTLI') {
      try { buf = zlib.brotliDecompressSync(raw); } catch { /* leave raw */ }
    }
    const n = node.numPoints;
    const positions = new Float32Array(n * 3);
    const colors = colAttr ? new Float32Array(n * 4) : null;
    const sc = meta.scale, off = meta.offset;
    const colDiv = colAttr && colAttr.size / colAttr.numElements >= 2 ? 65535 : 255;
    for (let i = 0; i < n; i++) {
      const base = i * pointSize;
      const px = buf.readInt32LE(base + posAttr._offset);
      const py = buf.readInt32LE(base + posAttr._offset + 4);
      const pz = buf.readInt32LE(base + posAttr._offset + 8);
      positions[i*3]   = px * sc[0] + off[0];
      positions[i*3+1] = py * sc[1] + off[1];
      positions[i*3+2] = pz * sc[2] + off[2];
      if (colors) {
        const co = base + colAttr._offset, es = colAttr.size / colAttr.numElements;
        const rd = es >= 2 ? buf.readUInt16LE(co)     : buf.readUInt8(co);
        const gn = es >= 2 ? buf.readUInt16LE(co+es)  : buf.readUInt8(co+1);
        const bl = es >= 2 ? buf.readUInt16LE(co+2*es): buf.readUInt8(co+2);
        colors[i*4]=rd/colDiv; colors[i*4+1]=gn/colDiv; colors[i*4+2]=bl/colDiv; colors[i*4+3]=1;
      }
    }
    return { positions, colors, count: n };
  }

  return {
    version: '2.0', meta, nodes, rootBox,
    spacing: meta.spacing,
    readNode,
    close: () => fh.close(),
  };
}

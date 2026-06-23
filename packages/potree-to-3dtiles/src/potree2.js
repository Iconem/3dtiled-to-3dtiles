/**
 * potree2.js — Potree 2.0 reader (metadata.json + hierarchy.bin + octree.bin).
 * Layout authoritative from PotreeConverter / OctreeLoader.js and yeyan00/potree23dtiles.
 *
 * hierarchy.bin: 22 bytes/node — type u8, childMask u8, numPoints u32, byteOffset u64, byteSize u64.
 *   type 2 = PROXY: byteOffset/byteSize point to a child hierarchy chunk within hierarchy.bin.
 * octree.bin: per node, `byteSize/pointSize` points; each point = attributes in metadata order.
 *   position = int32×3 → world = position·scale + offset (offset = metadata.offset).
 * encoding: "DEFAULT" (raw interleaved) | "BROTLI" (per-node brotli; Node's zlib.brotliDecompressSync).
 *
 * The pure pieces — schema, hierarchy parse, per-node decode — are exported so both the offline
 * converter (whole-file reads) and the live tile-server (HTTP **range** reads of octree.bin) share
 * one authoritative implementation.
 */
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

// De-interleave a 24-bit Morton code → the gathered axis bits (Potree 2.0 brotli, verbatim).
function dealign24b(mortoncode) {
  let x = mortoncode;
  x = ((x & 0b001000001000001000001000) >> 2) | ((x & 0b000001000001000001000001) >> 0);
  x = ((x & 0b000011000000000011000000) >> 4) | ((x & 0b000000000011000000000011) >> 0);
  x = ((x & 0b000000001111000000000000) >> 8) | ((x & 0b000000000000000000001111) >> 0);
  x = ((x & 0b000000000000000000000000) >> 16) | ((x & 0b000000000000000011111111) >> 0);
  return x;
}

// Potree `createChildAABB`: child index bit 0 → Z, bit 1 → Y, bit 2 → X.
function childBox(box, octant) {
  const mid = [0,1,2].map(k => (box.min[k] + box.max[k]) / 2);
  const min = box.min.slice(), max = box.max.slice();
  if (octant & 1) min[2] = mid[2]; else max[2] = mid[2];   // bit0 → Z
  if (octant & 2) min[1] = mid[1]; else max[1] = mid[1];   // bit1 → Y
  if (octant & 4) min[0] = mid[0]; else max[0] = mid[0];   // bit2 → X
  return { min, max };
}

/** Per-attribute layout (interleaved offsets + brotli plane sizes) derived from metadata. */
export function preparePotree2Schema(meta) {
  const attrs = meta.attributes;
  const isBrotli = (meta.encoding || 'DEFAULT').toUpperCase() === 'BROTLI';
  let pointSize = 0;
  for (const a of attrs) {
    a._offset = pointSize;                       // native interleaved offset (DEFAULT path)
    pointSize += a.size;
    const isPos = a.name === 'position';
    const isCol = /^rgb/i.test(a.name) || a.name === 'rgba';
    a._brotliSize = isPos ? 16 : isCol ? 8 : a.size;   // bytes/pt within this attr's plane (BROTLI)
  }
  const posAttr = attrs.find(a => a.name === 'position');
  const colAttr = attrs.find(a => /^rgb/i.test(a.name) || a.name === 'rgba');
  return { attrs, isBrotli, pointSize, posAttr, colAttr };
}

/**
 * Parse hierarchy.bin → { nodes:Map<name,{name,numPoints,byteOffset,byteSize,depth,box}>, rootBox }.
 * byteOffset/byteSize address each node's point block inside octree.bin (→ one range read per node).
 */
export function parsePotree2Hierarchy(meta, hierBuf) {
  const NB = 22;
  const nodes = new Map();
  const rootBox = { min: meta.boundingBox.min.slice(), max: meta.boundingBox.max.slice() };
  const proxies = [];

  function parseChunk(buf, rootName, rootBoxLocal) {
    const queue = [{ name: rootName, box: rootBoxLocal, idx: 0 }];
    let nextIdx = 1;
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

      if (type === 2) {                                    // proxy: descend into the referenced sub-chunk
        proxies.push({ name, box, byteOffset, byteSize });
        continue;
      }
      nodes.set(name, { name, numPoints, byteOffset, byteSize, depth: name.length - 1, box });
      for (let c = 0; c < 8; c++) {
        if (!((childMask >> c) & 1)) continue;
        const cname = name + c;
        if (seen.has(cname)) continue; seen.add(cname);
        queue.push({ name: cname, box: childBox(box, c), idx: nextIdx++ });
      }
    }
  }

  const firstChunk = hierBuf.subarray(0, meta.hierarchy.firstChunkSize);
  parseChunk(firstChunk, 'r', rootBox);
  while (proxies.length) {
    const p = proxies.shift();
    const sub = hierBuf.subarray(p.byteOffset, p.byteOffset + p.byteSize);
    parseChunk(sub, p.name, p.box);
  }
  return { nodes, rootBox };
}

/**
 * Decode one node's raw octree bytes → { positions:Float32Array(n*3) world coords, colors:?Float32Array(n*4) rgba[0,1], count }.
 * @param schema result of preparePotree2Schema(meta)
 * @param raw    node.byteSize bytes from octree.bin at node.byteOffset (whole-file or range read)
 */
export function decodePotree2Node(meta, schema, node, raw) {
  const { attrs, isBrotli, pointSize, posAttr, colAttr } = schema;
  let buf = raw;
  if (isBrotli) { try { buf = zlib.brotliDecompressSync(raw); } catch { /* leave raw */ } }
  const n = node.numPoints;
  const positions = new Float32Array(n * 3);
  const colors = colAttr ? new Float32Array(n * 4) : null;
  const sc = meta.scale, off = meta.offset;

  if (isBrotli) {
    // Attribute-planar: plane[a] starts at the cumulative size of all preceding planes (size×n).
    const planeStart = {}; let cum = 0;
    for (const a of attrs) { planeStart[a.name] = cum; cum += a._brotliSize * n; }
    const pBase = planeStart[posAttr.name];
    for (let i = 0; i < n; i++) {
      const o = pBase + i * 16;
      const mc_0 = buf.readUInt32LE(o + 4), mc_1 = buf.readUInt32LE(o + 0);
      const mc_2 = buf.readUInt32LE(o + 12), mc_3 = buf.readUInt32LE(o + 8);
      const lo = (mc_3 & 0x00FFFFFF) >>> 0, hi = ((mc_3 >>> 24) | (mc_2 << 8)) >>> 0;
      let X = dealign24b(lo >>> 0) | (dealign24b(hi >>> 0) << 8);
      let Y = dealign24b(lo >>> 1) | (dealign24b(hi >>> 1) << 8);
      let Z = dealign24b(lo >>> 2) | (dealign24b(hi >>> 2) << 8);
      if (mc_1 !== 0 || mc_2 !== 0) {              // high bits present (Potree: mc_1 || mc_2)
        const lo2 = (mc_1 & 0x00FFFFFF) >>> 0, hi2 = ((mc_1 >>> 24) | (mc_0 << 8)) >>> 0;
        X |= (dealign24b(lo2 >>> 0) << 16) | (dealign24b(hi2 >>> 0) << 24);
        Y |= (dealign24b(lo2 >>> 1) << 16) | (dealign24b(hi2 >>> 1) << 24);
        Z |= (dealign24b(lo2 >>> 2) << 16) | (dealign24b(hi2 >>> 2) << 24);
      }
      positions[i*3]   = (X >>> 0) * sc[0] + off[0];
      positions[i*3+1] = (Y >>> 0) * sc[1] + off[1];
      positions[i*3+2] = (Z >>> 0) * sc[2] + off[2];
    }
    if (colors) {
      const cBase = planeStart[colAttr.name];
      for (let i = 0; i < n; i++) {
        const o = cBase + i * 8;
        const mc_0 = buf.readUInt32LE(o + 4), mc_1 = buf.readUInt32LE(o + 0);
        const lo = (mc_1 & 0x00FFFFFF) >>> 0, hi = ((mc_1 >>> 24) | (mc_0 << 8)) >>> 0;
        let r = dealign24b(lo >>> 0) | (dealign24b(hi >>> 0) << 8);
        let g = dealign24b(lo >>> 1) | (dealign24b(hi >>> 1) << 8);
        let b = dealign24b(lo >>> 2) | (dealign24b(hi >>> 2) << 8);
        if (r > 255) r = r >> 8; if (g > 255) g = g >> 8; if (b > 255) b = b >> 8;  // 16→8-bit
        colors[i*4]=r/255; colors[i*4+1]=g/255; colors[i*4+2]=b/255; colors[i*4+3]=1;
      }
    }
    return { positions, colors, count: n };
  }

  // DEFAULT: interleaved native records.
  for (let i = 0; i < n; i++) {
    const base = i * pointSize;
    positions[i*3]   = buf.readInt32LE(base + posAttr._offset)     * sc[0] + off[0];
    positions[i*3+1] = buf.readInt32LE(base + posAttr._offset + 4) * sc[1] + off[1];
    positions[i*3+2] = buf.readInt32LE(base + posAttr._offset + 8) * sc[2] + off[2];
    if (colors) {
      const co = base + colAttr._offset, es = colAttr.size / colAttr.numElements, div = es >= 2 ? 65535 : 255;
      const r = es >= 2 ? buf.readUInt16LE(co)     : buf.readUInt8(co);
      const g = es >= 2 ? buf.readUInt16LE(co+es)  : buf.readUInt8(co+1);
      const b = es >= 2 ? buf.readUInt16LE(co+2*es): buf.readUInt8(co+2);
      colors[i*4]=r/div; colors[i*4+1]=g/div; colors[i*4+2]=b/div; colors[i*4+3]=1;
    }
  }
  return { positions, colors, count: n };
}

export async function loadPotree2(dir) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8'));
  const schema = preparePotree2Schema(meta);
  const hierBuf = Buffer.from(await fs.readFile(path.join(dir, 'hierarchy.bin')));
  const { nodes, rootBox } = parsePotree2Hierarchy(meta, hierBuf);

  const fh = await fs.open(path.join(dir, 'octree.bin'), 'r');
  async function readNode(node) {
    if (!node.byteSize) return null;
    const raw = Buffer.alloc(node.byteSize);
    await fh.read(raw, 0, node.byteSize, node.byteOffset);
    return decodePotree2Node(meta, schema, node, raw);
  }

  return {
    version: '2.0', meta, nodes, rootBox,
    spacing: meta.spacing,
    // Potree 2.0 metadata may carry a CRS (`projection`/`crs`/WKT) — surface for downstream georef.
    crs: meta.projection || meta.crs || meta.wkt || null,
    readNode,
    close: () => fh.close(),
  };
}

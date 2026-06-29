/**
 * dump-live.js — extract a cropped/subsampled copy of a tiled asset by a bounding box (the engine for
 * the browser-native "bbox crop" feature). First increment: **point clouds (Potree) → LAS**.
 *
 *   GET /dump/las?url=<cloud.js|metadata.json>&bbox=<minx,miny,minz,maxx,maxy,maxz>[&maxLevel=N][&format=potree]
 *
 * `bbox` is in the dataset's own coordinate space (the octree box space — e.g. UTM for a georeferenced
 * Potree). ADD-octree semantics: accumulate every point inside the bbox from all nodes down to `maxLevel`
 * (the desired geometric-error/density floor). Streams an uncompressed LAS (core las-writer); hand it to
 * `pdal writers.copc` / `untwine` server-side for LAZ/COPC. (COPC source + 3D-Tiles-mesh→glb/USD: next.)
 */
import { loadPotree1 } from '../potree-to-3dtiles/src/potree1.js';
import { loadPotree2 } from '../potree-to-3dtiles/src/potree2.js';
import { writeLasBuffer, CORS } from '../core/index.js';

const intersects = (box, bb) => [0, 1, 2].every(k => box.max[k] >= bb[k] && box.min[k] <= bb[k + 3]);
const inBox = (x, y, z, bb) => x >= bb[0] && x <= bb[3] && y >= bb[1] && y <= bb[4] && z >= bb[2] && z <= bb[5];

export async function handleDump(req, res, u) {
  if (!u.pathname.startsWith('/dump/')) return false;
  const url = u.searchParams.get('url');
  const bboxStr = u.searchParams.get('bbox');
  const maxLevel = u.searchParams.has('maxLevel') ? Number(u.searchParams.get('maxLevel')) : 99;
  if (u.pathname !== '/dump/las' || !url || !bboxStr) {
    res.writeHead(400, CORS); res.end('GET /dump/las?url=<potree>&bbox=minx,miny,minz,maxx,maxy,maxz[&maxLevel=N]'); return true;
  }
  const bb = bboxStr.split(',').map(Number);
  if (bb.length !== 6 || bb.some(Number.isNaN)) { res.writeHead(400, CORS); res.end('bbox needs 6 numbers'); return true; }

  try {
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const read = (rel) => fetch(/^https?:/i.test(rel) ? rel : base + rel).then(r => { if (!r.ok) throw new Error(`fetch ${rel} ${r.status}`); return r.arrayBuffer(); }).then(a => Buffer.from(a));
    // non-lazy: load the full hierarchy (node boxes), then read geometry only for nodes in the bbox.
    const src = /metadata\.json/i.test(url) ? await loadPotree2('', { read }) : await loadPotree1('', { read });

    const pts = [];
    let nodesRead = 0;
    for (const [, node] of src.nodes) {
      if (!node || node.numPoints <= 0 || node.depth > maxLevel) continue;
      if (!intersects(node.box, bb)) continue;
      const d = await src.readNode(node);
      if (!d || !d.count) continue;
      nodesRead++;
      for (let i = 0; i < d.count; i++) {
        const x = d.positions[i * 3], y = d.positions[i * 3 + 1], z = d.positions[i * 3 + 2];
        if (!inBox(x, y, z, bb)) continue;
        const c = d.colors;
        pts.push({ x, y, z,
          r: c ? Math.round(c[i * 4] * 65535) : 0, g: c ? Math.round(c[i * 4 + 1] * 65535) : 0, b: c ? Math.round(c[i * 4 + 2] * 65535) : 0 });
      }
    }
    await src.close?.();

    // LAS offset = the collected points' min (NOT the query bbox, which may be huge/unbounded) so the
    // quantized int32 = (coord−offset)/scale stays in range; 1mm scale.
    const mn = [Infinity, Infinity, Infinity];
    for (const p of pts) { if (p.x < mn[0]) mn[0] = p.x; if (p.y < mn[1]) mn[1] = p.y; if (p.z < mn[2]) mn[2] = p.z; }
    const offset = pts.length ? mn.map(Math.floor) : [0, 0, 0];
    const las = writeLasBuffer(pts, { scale: [0.001, 0.001, 0.001], offset });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="crop.las"',
      'X-Dump-Points': String(pts.length), 'X-Dump-Nodes': String(nodesRead), ...CORS,
    });
    res.end(las);
  } catch (e) {
    console.error('[dump-live]', e.message);
    if (!res.headersSent) { res.writeHead(500, CORS); res.end(e.message); } else res.end();
  }
  return true;
}

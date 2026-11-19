/**
 * CopcPlugin — a COPC (.copc.laz) read straight from its bucket by 3DTilesRendererJS, with no tile
 * server: range requests for the header, the hierarchy pages and each node's LAZ chunk, decoded here.
 *
 * FIRST ATTEMPT (phase 0 of docs/guide/planning/tiled-formats-plugin): it lives in the Potree lab, not
 * in a package, and it decodes on the main thread.
 *
 * How it is built. A COPC octree has the shape of a Potree one: a cube halved per level, additive
 * refinement, a point spacing halved per level. So this is upstream's PotreePlugin with another
 * loader: the tiles, the geometric error (spacing / 2^level), the adaptive point size and eye-dome
 * lighting are its own, unchanged. A node keeps Potree's name (`r` + one octant digit per level, bit 2
 * = x, bit 1 = y, bit 0 = z) and is translated to COPC's `level-x-y-z` at the loader.
 *
 * What the loader does:
 * - `load`: copc.js reads the header, the info VLR (cube, spacing) and the root hierarchy page;
 * - the hierarchy stays lazy: a page is read when the first node under it is asked for;
 * - `loadNodeData`: one range request for the node's chunk, then LAZ → LAS records (laz-perf, wasm);
 * - `parsePointData`: positions relative to the node's centre (float32), colours as linear uint16.
 *
 * Not done: placement on the globe from the file's CRS (the cloud is drawn in its own coordinates,
 * Z up), decoding in a worker, classification and the other attributes, a VPC.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { Copc, Las } from 'copc';
import { createLazPerf } from 'laz-perf';
import lazPerfWasm from 'laz-perf/lib/web/laz-perf.wasm?url';
import { PotreePlugin } from '3d-tiles-renderer/plugins';

// sRGB byte → linear, as a normalized uint16 (what three expects of a vertex colour)
const SRGB_TO_LINEAR16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR16[i] = Math.round((c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * 65535);
}

/** `r` + octant digits → COPC `level-x-y-z`. */
export function copcKey(key) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < key.length; i++) {
    const o = key.charCodeAt(i) - 48;
    x = x * 2 + ((o >> 2) & 1); y = y * 2 + ((o >> 1) & 1); z = z * 2 + (o & 1);
  }
  return `${key.length - 1}-${x}-${y}-${z}`;
}

/** The surface PotreePlugin expects of its loader, over a COPC file. */
export class CopcLoader {
  constructor() {
    this.fetchOptions = {};
    this.fetchData = (url, options) => fetch(url, options);
    this.metadata = null;
    this.copc = null;
    this.url = null;
    this.nodes = new Map();          // COPC key → { pointCount, pointDataOffset, pointDataLength }
    this.pendingPages = new Map();   // COPC key of a page's first node → { pageOffset, pageLength }
    this._pageLoads = new Map();     // the same key → the read in flight
    this._lazPerf = null;
    this._wide = null;               // colours on 16 bits (true) or 8 bits stored in 16 (false); null until seen
    this.stats = { requests: 0, retries: 0, bytes: 0, pages: 0, decodeMs: 0, points: 0 };
    // PotreePlugin reads `hierarchy.get(key).childMask`: answered from what is known now, so that a
    // page read later shows up without anything to rebuild.
    this.hierarchy = {
      has: (key) => this.nodes.has(copcKey(key)),
      get: (key) => {
        const node = this.nodes.get(copcKey(key));
        if (!node) return undefined;
        let childMask = 0;
        for (let o = 0; o < 8; o++) {
          const child = copcKey(key + o);
          if (this.nodes.has(child) || this.pendingPages.has(child)) childMask |= 1 << o;
        }
        return { childMask, numPoints: node.pointCount };
      },
    };
  }

  /** A range of the file, through the renderer's plugins (auth, URL rewriting) like any tile. */
  _getter(signal) {
    return async (begin, end) => {
      const init = { ...this.fetchOptions, signal, headers: { ...this.fetchOptions?.headers, Range: `bytes=${begin}-${end - 1}` } };
      // one more try on a network failure (seen from S3 under 25 parallel ranges): a tile that fails is not asked for again
      const res = await this.fetchData(this.url, init).catch(async (e) => {
        if (signal?.aborted || e?.name === 'AbortError') throw e;
        await new Promise((r) => setTimeout(r, 300));
        this.stats.retries++;
        return this.fetchData(this.url, init);
      });
      if (!res.ok) throw new Error(`COPC: HTTP ${res.status} on bytes ${begin}-${end - 1}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // a server that ignores Range answers 200 with the whole file: refuse rather than read 10 GB
      if (res.status === 200 && bytes.length > end - begin) throw new Error('COPC: the server ignored the Range header');
      this.stats.requests++; this.stats.bytes += bytes.length;
      return bytes;
    };
  }

  async _loadPage(page, signal) {
    const { nodes, pages } = await Copc.loadHierarchyPage(this._getter(signal), page);
    for (const [k, n] of Object.entries(nodes)) if (n) this.nodes.set(k, n);
    for (const [k, p] of Object.entries(pages)) if (p && !this.nodes.has(k)) this.pendingPages.set(k, p);
    this.stats.pages++;
  }

  async load(url) {
    this.url = url;
    this._lazPerf = createLazPerf({ locateFile: () => lazPerfWasm });
    this.copc = await Copc.create(this._getter());
    const { cube, spacing, rootHierarchyPage } = this.copc.info;
    const fmt = this.copc.header.pointDataRecordFormat;
    if (fmt < 6 || fmt > 8) throw new Error(`COPC: point format ${fmt} (6, 7 or 8 expected)`);
    await this._loadPage(rootHierarchyPage);
    const side = cube[3] - cube[0];
    this.metadata = {
      // the root's point spacing; a file without one falls back to Potree's convention, the cube over 128
      spacing: spacing > 0 && Number.isFinite(spacing) ? spacing : side / 128,
      boundingBox: { min: [cube[0], cube[1], cube[2]], max: [cube[3], cube[4], cube[5]] },
    };
    return this.metadata;
  }

  /** The node's points as LAS records. Its hierarchy page is read first when it is not yet known. */
  async loadNodeData(key, options = {}) {
    const k = copcKey(key);
    if (!this.nodes.has(k) && this.pendingPages.has(k)) {
      let load = this._pageLoads.get(k);
      if (!load) {
        // not tied to this tile's abort signal: the page serves every node under it
        load = this._loadPage(this.pendingPages.get(k)).then(() => { this.pendingPages.delete(k); }).finally(() => this._pageLoads.delete(k));
        this._pageLoads.set(k, load);
      }
      await load;
    }
    const node = this.nodes.get(k);
    if (!node) throw new Error(`COPC: no node ${k}`);
    if (!node.pointCount) return new ArrayBuffer(0);
    const lazPerf = await this._lazPerf;
    const getter = this._getter(options.signal);
    // fetch, then decode: timed apart, the decode being what holds the main thread
    const compressed = await Copc.loadCompressedPointDataBuffer(getter, node);
    const t0 = performance.now();
    const { pointDataRecordFormat, pointDataRecordLength } = this.copc.header;
    const records = await Las.PointData.decompressChunk(compressed, { pointCount: node.pointCount, pointDataRecordFormat, pointDataRecordLength }, lazPerf);
    this.stats.decodeMs += performance.now() - t0; this.stats.points += node.pointCount;
    return records.buffer.byteLength === records.byteLength ? records.buffer : records.slice().buffer;
  }

  /** LAS records (formats 6 to 8) → geometry. Positions relative to the node's centre, as PotreeLoader. */
  parsePointData(buffer, key, min, max) {
    const { header } = this.copc;
    const stride = header.pointDataRecordLength;
    const n = Math.floor(buffer.byteLength / stride);
    const [sx, sy, sz] = header.scale, [ox, oy, oz] = header.offset;
    const center = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const view = new DataView(buffer);
    const positions = new Float32Array(n * 3);
    const colors = new Uint16Array(n * 3);
    const hasRgb = header.pointDataRecordFormat >= 7;         // formats 7 and 8: red, green, blue at byte 30
    if (hasRgb && this._wide === null) {
      let wide = false;
      for (let i = 0; i < n && !wide; i++) wide = view.getUint16(i * stride + 30, true) > 255 || view.getUint16(i * stride + 32, true) > 255;
      if (n) this._wide = wide;
    }
    const shift = this._wide === false ? 0 : 8;
    for (let i = 0; i < n; i++) {
      const b = i * stride;
      positions[i * 3] = view.getInt32(b, true) * sx + ox - center.x;
      positions[i * 3 + 1] = view.getInt32(b + 4, true) * sy + oy - center.y;
      positions[i * 3 + 2] = view.getInt32(b + 8, true) * sz + oz - center.z;
      if (hasRgb) {
        colors[i * 3] = SRGB_TO_LINEAR16[Math.min(255, view.getUint16(b + 30, true) >> shift)];
        colors[i * 3 + 1] = SRGB_TO_LINEAR16[Math.min(255, view.getUint16(b + 32, true) >> shift)];
        colors[i * 3 + 2] = SRGB_TO_LINEAR16[Math.min(255, view.getUint16(b + 34, true) >> shift)];
      } else {
        // no colour in the file: its intensity, as a grey (the top byte, or the value itself when it fits one)
        const it = view.getUint16(b + 12, true);
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = SRGB_TO_LINEAR16[it > 255 ? it >> 8 : it];
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3, true));
    return { geometry, center };
  }
}

/**
 * COPC in 3DTilesRendererJS. Options are PotreePlugin's (`url`, `pointScale`, and those of
 * PointCloudEffectsPlugin: point shape, size limits, eye-dome lighting, debug colours).
 */
export class CopcPlugin extends PotreePlugin {
  constructor(options = {}) {
    super(options);
    this.name = 'COPC_PLUGIN';
  }

  init(tiles) {
    super.init(tiles);
    const loader = new CopcLoader();
    loader.fetchOptions = tiles.fetchOptions;
    loader.fetchData = (url, options) => tiles.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(url, options));
    this.loader = loader;
  }

  // An empty node has nothing to draw but may have children: an empty geometry keeps the tree growing.
  // A node the hierarchy does not know yet stays a leaf (PotreePlugin would throw).
  _expandChildren(tile, key) {
    if (this.loader.hierarchy.has(key)) super._expandChildren(tile, key);
  }
}

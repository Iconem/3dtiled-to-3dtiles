/**
 * CopcPlugin — a COPC (.copc.laz) read straight from its bucket by 3DTilesRendererJS, with no tile
 * server: range requests for the header, the hierarchy pages and each node's LAZ chunk, decoded here.
 *
 * SECOND ATTEMPT (phase 0 of docs/guide/planning/tiled-formats-plugin): it still lives in the Potree
 * lab, not in a package.
 *
 * How it is built. A COPC octree has the shape of a Potree one: a cube halved per level, additive
 * refinement, a point spacing halved per level. So this is upstream's PotreePlugin with another
 * loader: the tiles, the geometric error (spacing / 2^level), the adaptive point size and eye-dome
 * lighting are its own, unchanged. A node keeps Potree's name (`r` + one octant digit per level, bit 2
 * = x, bit 1 = y, bit 0 = z) and is translated to COPC's `level-x-y-z` at the loader.
 *
 * What the loader does:
 * - `load`: copc.js reads the header, the info VLR (cube, spacing), the WKT of the CRS and the root
 *   hierarchy page;
 * - the hierarchy stays lazy: a page is read when the first node under it is asked for;
 * - `loadNodeData`: one range request for the node's chunk, on the page (so that it goes through the
 *   renderer's plugins like any tile), then LAZ → geometry arrays in a WORKER (./copcWorker.js, a
 *   small pool), which come back as one transferred buffer (./copcDecode.js). When no worker can be
 *   started the same code runs on the page;
 * - `parsePointData`: views on that buffer become the geometry's attributes. Beside `position`
 *   (relative to the node's centre, float32) and `color` (linear uint16): `intensity`,
 *   `classification`, `returnNumber`, `numberOfReturns`, `pointSourceId`, `userData` and `gpsTime`
 *   (seconds after the file's first, float32), which the lab colours by (./colorModes.js).
 *
 * Placement. By default the cloud is drawn in the file's own coordinates, Z up. With
 * `placement: 'globe'` the root tile gets a transform to earth-centred coordinates computed from the
 * file's CRS (./copcPlacement.js); `plugin.placement` says what was done, and why not when the CRS
 * could not be used (the cloud then stays local: nothing throws).
 *
 * Not done: a VPC, a geoid, the bending of a country-wide cloud onto the ellipsoid.
 */
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { Copc } from 'copc';
import { PotreePlugin } from '3d-tiles-renderer/plugins';
import { ATTR, ATTR_ALL, attributeMask, decodeChunk, loadLazPerf, unpack } from './copcDecode.js';
import { placementFromCrs } from './copcPlacement.js';

/** `r` + octant digits → COPC `level-x-y-z`. */
export function copcKey(key) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < key.length; i++) {
    const o = key.charCodeAt(i) - 48;
    x = x * 2 + ((o >> 2) & 1); y = y * 2 + ((o >> 1) & 1); z = z * 2 + (o & 1);
  }
  return `${key.length - 1}-${x}-${y}-${z}`;
}

/** The default number of decode workers: one core is left to the page, four are enough for 25 downloads. */
export function defaultWorkerCount() {
  return Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1));
}

/** The surface PotreePlugin expects of its loader, over a COPC file. */
export class CopcLoader {
  /**
   * @param {Object} [options]
   * @param {number} [options.workers]  Decode workers; 0 decodes on the page. Default: min(4, cores − 1).
   * @param {string[]} [options.attributes]  Attributes read beside position and colour. Default: all of ATTR.
   */
  constructor(options = {}) {
    this.fetchOptions = {};
    this.fetchData = (url, options) => fetch(url, options);
    this.metadata = null;
    this.copc = null;
    this.url = null;
    this.nodes = new Map();          // COPC key → { pointCount, pointDataOffset, pointDataLength }
    this.pendingPages = new Map();   // COPC key of a page's first node → { pageOffset, pageLength }
    this._pageLoads = new Map();     // the same key → the read in flight
    this._wide = null;               // colours on 16 bits (true) or 8 bits stored in 16 (false); null until seen
    this._gpsBase = 0;
    this._mask = options.attributes ? attributeMask(options.attributes) : ATTR_ALL;
    this._wanted = options.workers ?? defaultWorkerCount();
    this._workers = [];              // { worker, busy, proven }
    this._jobs = new Map();          // job id → { resolve, reject, entry, compressed, job }
    this._jobId = 0;
    this._lazPerf = null;            // laz-perf on the page: only made when a chunk has to be decoded here
    /** Why decoding runs on the page, when it does. */
    this.workerNote = '';
    // decodeMs: time in the decoder, wherever it ran; mainMs: the part of the work that held the page
    // (parse, plus the decode when there is no worker)
    this.stats = { requests: 0, retries: 0, bytes: 0, pages: 0, decodeMs: 0, mainMs: 0, points: 0, workerChunks: 0, mainChunks: 0 };
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

  /** Workers alive now (0: decoding on the page). */
  get workerCount() { return this._workers.length; }

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
    this._startWorkers();
    this.copc = await Copc.create(this._getter());
    const { cube, spacing, rootHierarchyPage, gpsTimeRange } = this.copc.info;
    const fmt = this.copc.header.pointDataRecordFormat;
    if (fmt < 6 || fmt > 8) throw new Error(`COPC: point format ${fmt} (6, 7 or 8 expected)`);
    this._gpsBase = Number.isFinite(gpsTimeRange?.[0]) ? gpsTimeRange[0] : 0;
    await this._loadPage(rootHierarchyPage);
    const side = cube[3] - cube[0];
    this.metadata = {
      // the root's point spacing; a file without one falls back to Potree's convention, the cube over 128
      spacing: spacing > 0 && Number.isFinite(spacing) ? spacing : side / 128,
      boundingBox: { min: [cube[0], cube[1], cube[2]], max: [cube[3], cube[4], cube[5]] },
    };
    return this.metadata;
  }

  // ── workers ───────────────────────────────────────────────────────────────────────────────────

  _startWorkers() {
    if (this._workers.length || this._wanted <= 0) { if (this._wanted <= 0) this.workerNote = 'asked for (workers: 0)'; return; }
    try {
      for (let i = 0; i < this._wanted; i++) {
        const entry = { worker: new Worker(new URL('./copcWorker.js', import.meta.url), { type: 'module' }), busy: 0, proven: false };
        entry.worker.onmessage = ({ data }) => this._onReply(entry, data);
        // the worker's script failed to load or threw outside a job: this worker is lost
        entry.worker.onerror = (e) => { e.preventDefault?.(); this._dropWorker(entry, e.message || 'worker error'); };
        this._workers.push(entry);
      }
    } catch (e) {
      for (const w of this._workers) w.worker.terminate();
      this._workers = [];
      this.workerNote = `no worker (${String(e?.message ?? e).slice(0, 60)})`;
    }
  }

  _onReply(entry, { id, buffer, decodeMs, error }) {
    const pending = this._jobs.get(id);
    if (!pending) return;
    this._jobs.delete(id);
    entry.busy--;
    if (error) { pending.reject(new Error(`COPC: ${error}`)); return; }
    entry.proven = true;
    this.stats.decodeMs += decodeMs; this.stats.workerChunks++;
    pending.resolve(buffer);
  }

  /** A worker that failed: its jobs are decoded on the page when their bytes were kept, and it is not used again. */
  _dropWorker(entry, why) {
    const i = this._workers.indexOf(entry);
    if (i < 0) return;
    this._workers.splice(i, 1);
    entry.worker.terminate();
    if (!this._workers.length) this.workerNote = `no worker (${String(why).slice(0, 60)})`;
    for (const [id, pending] of this._jobs) {
      if (pending.entry !== entry) continue;
      this._jobs.delete(id);
      if (pending.compressed) this._decodeHere(pending.compressed, pending.job).then(pending.resolve, pending.reject);
      else pending.reject(new Error(`COPC: decode worker lost (${why})`));
    }
  }

  async _decodeHere(compressed, job) {
    this._lazPerf ??= loadLazPerf();
    const LazPerf = await this._lazPerf;
    const t0 = performance.now();
    const buffer = decodeChunk(LazPerf, compressed, job);
    const ms = performance.now() - t0;
    this.stats.decodeMs += ms; this.stats.mainMs += ms; this.stats.mainChunks++;
    return buffer;
  }

  _decode(compressed, job) {
    if (!this._workers.length) return this._decodeHere(compressed, job);
    let entry = this._workers[0];
    for (const w of this._workers) if (w.busy < entry.busy) entry = w;
    return new Promise((resolve, reject) => {
      const id = ++this._jobId;
      entry.busy++;
      // The bytes are transferred (no copy) once the worker has answered a first job. Until then they
      // are copied and kept, so that a worker that never starts costs nothing but a decode on the page.
      const whole = compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength;
      const transfer = entry.proven && whole;
      this._jobs.set(id, { resolve, reject, entry, job, compressed: transfer ? null : compressed });
      const bytes = whole ? compressed.buffer : compressed.slice().buffer;
      entry.worker.postMessage({ id, compressed: bytes, job }, transfer ? [bytes] : []);
    });
  }

  dispose() {
    for (const w of this._workers) w.worker.terminate();
    this._workers = [];
    for (const pending of this._jobs.values()) pending.reject(new Error('COPC: loader disposed'));
    this._jobs.clear();
  }

  // ── nodes ─────────────────────────────────────────────────────────────────────────────────────

  /** The centre of a node's cube, by the same halving as PotreePlugin's tiles. */
  nodeCenter(key) {
    const { min, max } = this.metadata.boundingBox;
    const lo = [...min], hi = [...max];
    for (let i = 1; i < key.length; i++) {
      const o = key.charCodeAt(i) - 48;
      for (let a = 0; a < 3; a++) {
        const mid = (lo[a] + hi[a]) / 2;
        if (o & (4 >> a)) lo[a] = mid; else hi[a] = mid;
      }
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  /** The node's points, decoded: one packed buffer (./copcDecode.js). Its hierarchy page is read first when it is not yet known. */
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
    const { header } = this.copc;
    const job = {
      pointCount: node.pointCount, format: header.pointDataRecordFormat, recordLength: header.pointDataRecordLength,
      scale: header.scale, offset: header.offset, center: this.nodeCenter(key), mask: this._mask, wide: this._wide, gpsBase: this._gpsBase,
    };
    // an empty node: nothing to fetch, and the decoder writes its header without laz-perf
    if (!node.pointCount) return decodeChunk(null, null, job);
    const compressed = await Copc.loadCompressedPointDataBuffer(this._getter(options.signal), node);
    const buffer = await this._decode(compressed, job);
    this.stats.points += node.pointCount;
    if (this._wide === null) {
      const flags = new DataView(buffer, 8, 4).getUint32(0, true);
      if (flags & 1) this._wide = Boolean(flags & 2);
    }
    return buffer;
  }

  /** A packed buffer → geometry. Positions relative to the node's centre, as PotreeLoader. */
  parsePointData(buffer) {
    const t0 = performance.now();
    const d = unpack(buffer);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(d.position, 3));
    geometry.setAttribute('color', new BufferAttribute(d.color, 3, true));
    for (const name of Object.keys(ATTR)) if (d[name]) geometry.setAttribute(name, new BufferAttribute(d[name], 1));
    this.stats.mainMs += performance.now() - t0;
    return { geometry, center: new Vector3(...d.center) };
  }
}

/**
 * COPC in 3DTilesRendererJS. Options are PotreePlugin's (`url`, `pointScale`, and those of
 * PointCloudEffectsPlugin: point shape, size limits, eye-dome lighting, debug colours), plus:
 *
 * @param {number} [options.workers]  Decode workers; 0 decodes on the page. Default: min(4, cores − 1).
 * @param {string[]} [options.attributes]  Point attributes kept beside position and colour. Default: all.
 * @param {('local'|'globe')} [options.placement='local']  `globe`: place the cloud on the WGS84 ellipsoid from the file's CRS.
 * @param {string|null} [options.crs=null]  A CRS for a file that declares none (WKT or a proj string).
 */
export class CopcPlugin extends PotreePlugin {
  constructor(options = {}) {
    super(options);
    this.name = 'COPC_PLUGIN';
    this.workers = options.workers;
    this.attributes = options.attributes;
    this.placementMode = options.placement === 'globe' ? 'globe' : 'local';
    this.crs = options.crs ?? null;
    /**
     * What was done with the file's CRS, known once the root tile set has loaded:
     * `{ placed, note, transform, lon, lat, height, convergence, unit, verticalUnit, crsName }` (./copcPlacement.js).
     */
    this.placement = null;
    this._unit = 1;                  // metres per unit of the file once placed: a point size is in the file's unit
  }

  init(tiles) {
    super.init(tiles);
    const loader = new CopcLoader({ workers: this.workers, attributes: this.attributes });
    loader.fetchOptions = tiles.fetchOptions;
    loader.fetchData = (url, options) => tiles.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(url, options));
    this.loader = loader;
  }

  dispose() {
    const { loader } = this;
    super.dispose();
    loader?.dispose();
  }

  // PotreePlugin's own, with a transform on the root tile when the cloud is placed on the globe: the
  // transform has to be there before `preprocessTileset` reads the root, which the parent's method
  // leaves no room for.
  async loadRootTileset() {
    const { tiles, url, loader } = this;
    let metaUrl = new URL(url ?? tiles.rootURL, location.href).href;
    tiles.invokeAllPlugins((plugin) => { metaUrl = plugin.preprocessURL ? plugin.preprocessURL(metaUrl, null) : metaUrl; });
    await loader.load(metaUrl);

    const { spacing, boundingBox: { min, max } } = loader.metadata;
    const root = {
      refine: 'ADD',
      geometricError: spacing,
      boundingVolume: { box: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2, (max[0] - min[0]) / 2, 0, 0, 0, (max[1] - min[1]) / 2, 0, 0, 0, (max[2] - min[2]) / 2] },
      content: { uri: 'r.potree' },
      children: [],
    };
    const { header, wkt } = loader.copc;
    const crs = wkt || this.crs;
    this.placement = this.placementMode === 'globe'
      ? placementFromCrs(crs, [...min, ...max], [header.min[2], header.max[2]])
      : { placed: false, note: crs ? 'drawn in the file\'s own coordinates' : 'the file declares no CRS' };
    if (this.placement.placed) {
      root.transform = this.placement.transform;
      this._unit = this.placement.unit;
      // The renderer measures the distance to a tile in the tile set's frame (metres, once placed) and
      // divides the geometric error by it as it is: the error has to be in metres too. The children
      // halve their parent's, so the root's is enough.
      root.geometricError = spacing * this._unit;
    }

    const tileset = { asset: { version: '1.1' }, geometricError: Infinity, root };
    tiles.preprocessTileset(tileset, metaUrl.slice(0, metaUrl.lastIndexOf('/') + 1));
    return tileset;
  }

  // PotreePlugin sizes a point from the spacing, in the file's unit; the material draws that size in
  // world units, which a placed cloud counts in metres.
  parseToMesh(buffer, tile, extension, uri) {
    const points = super.parseToMesh(buffer, tile, extension, uri);
    if (!points) return points;
    points.userData.fileZ = points.position.z;      // the node centre's own Z, before the renderer applies the tile's transform
    if (this._unit !== 1) points.material.size *= this._unit;
    return points;
  }

  _updateMaterials() {
    super._updateMaterials();
    if (this._unit !== 1 && this.loader?.metadata) this.tiles.forEachLoadedModel((scene) => { scene.material.size *= this._unit; });
  }

  // An empty node has nothing to draw but may have children: an empty geometry keeps the tree growing.
  // A node the hierarchy does not know yet stays a leaf (PotreePlugin would throw).
  _expandChildren(tile, key) {
    if (this.loader.hierarchy.has(key)) super._expandChildren(tile, key);
  }
}

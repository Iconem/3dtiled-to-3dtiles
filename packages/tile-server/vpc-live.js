/**
 * vpc-live.js — a PDAL / QGIS **Virtual Point Cloud** (`.vpc`) as one 3D Tiles mosaic.
 *
 * A VPC (github.com/PDAL/wrench, vpc-spec.md) is a STAC ItemCollection: one GeoJSON feature per point
 * cloud file, with `assets.data.href`, a 3D `proj:bbox` in the file's own CRS (`proj:wkt2`, `proj:epsg`
 * or `proj:projjson`), `pc:count`, and optionally an `overview` asset. It has no tiles of its own, so
 * there is no range adapter here: a VPC is parsed into the manifest /aggregate already serves,
 *
 *   { label, entries: [{ format: 'copc', url, name, crs?, bounds: { sphere, geometricError } }] }
 *
 * and /aggregate builds the mosaic, each leaf an external reference to this server's own COPC stream
 * (`/stream/tileset.json?format=copc&url=<item>`). The bounds come from the item's own extent, so the
 * root is built from the one .vpc file: no child file is opened to place it.
 *
 *   GET /stream/tileset.json?format=vpc&url=<….vpc>      (stream-live hands it to /aggregate)
 *   GET /aggregate/tileset.json?vpc=<….vpc>[&nest=…][&bv=…][&sniff=auto|all|0][&ttl=<s>]
 *   GET /aggregate/index.json?vpc=<….vpc>                 one row per streamed item
 *
 * Only COPC items are streamed: a plain LAS/LAZ file has no levels of detail to map onto tiles (see
 * copc-to-3dtiles, which refuses it for the same reason). They are skipped, counted and reported in
 * `asset.extras.vpc` and in the `X-VPC-*` response headers; a VPC with no COPC item at all is a 422.
 *
 * A VPC may also NEST: an item whose data asset is itself a `.vpc` / `.vpc.gz` (scripts/vpc-split.mjs
 * writes such a root over a country, one child VPC per quadtree cell, each under 2 048 items), or a
 * root-level `links: [{ rel: "child", href: "….vpc" }]`. A nested item becomes a `format: 'vpc'` entry
 * whose leaf is this server's own mosaic of that child (`/stream/tileset.json?format=vpc&url=<child>`),
 * placed from the item's `proj:bbox` like any other: the root mosaic is built from the root file alone,
 * and a child VPC is read only when a client refines into its cell. A `links` child carries no bounds,
 * so /aggregate reads that child's mosaic root to place it (one request, not one per item).
 */
import { gunzipSync } from 'node:zlib';
import { fetchSource, fetchSourceRange, crsToEcef, epsgOfCrs, ensureCrs, llhToEcef } from '../core/index.js';

/** Past this extent a box is sampled on a grid: its faces follow the ellipsoid (as copc-live's curved placement does). */
const CURVED_MIN_EXTENT = 20000;
const EARTH_R = 6378137;

const isHttp = (s) => /^https?:\/\//i.test(s);
const pathOf = (href) => String(href).split(/[?#]/)[0];

// ── hrefs ────────────────────────────────────────────────────────────────────────────────────────

/**
 * An asset href → an absolute http(s) URL, or `{ reason }` when this server cannot read it. Relative
 * hrefs resolve against the .vpc's own URL (PDAL writes `./tile.copc.laz`, with either slash). A drive
 * letter, a UNC path, `file://`, `s3://` … name a file on the machine that wrote the VPC.
 */
export function resolveHref(href, base) {
  if (typeof href !== 'string' || !href.trim()) return { reason: 'no data href' };
  const h = href.trim();
  if (isHttp(h)) return { url: h };
  if (/^[a-z]:[\\/]/i.test(h) || h.startsWith('\\\\')) return { reason: 'local path' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) return { reason: `unsupported scheme (${h.slice(0, h.indexOf(':'))})` };
  if (!base || !isHttp(base)) return { reason: 'local path' };
  try { return { url: new URL(h.replace(/\\/g, '/'), base).href }; }
  catch { return { reason: 'unreadable href' }; }
}

/**
 * What the file name says: 'copc' (`.copc.laz`), 'laz' (may be a COPC: a COPC is a valid LAZ 1.4 and
 * nothing forces the double extension, so only the file's first VLR can tell), 'las' (never a COPC),
 * 'ept', 'vpc' (a nested virtual point cloud, `.vpc` / `.vpc.gz`), or null.
 */
export function kindOfHref(href) {
  const p = pathOf(href).toLowerCase();
  if (p.endsWith('.vpc') || p.endsWith('.vpc.gz') || p.endsWith('.vpc.json')) return 'vpc';
  if (p.endsWith('.copc.laz') || p.endsWith('.copc')) return 'copc';
  if (p.endsWith('.laz')) return 'laz';
  if (p.endsWith('.las')) return 'las';
  if (p.endsWith('ept.json') || p.startsWith('ept://')) return 'ept';
  return null;
}

/** The data asset of a STAC item: `assets.data`, else the first asset with the `data` role, else the first that is not an overview. */
function dataAsset(assets) {
  if (!assets || typeof assets !== 'object') return null;
  if (assets.data?.href) return assets.data;
  const list = Object.entries(assets).filter(([, a]) => a && typeof a.href === 'string');
  return list.find(([, a]) => a.roles?.includes('data'))?.[1]
    ?? list.find(([k, a]) => k !== 'overview' && !a.roles?.includes('overview'))?.[1] ?? null;
}

const overviewAssets = (assets) => Object.entries(assets && typeof assets === 'object' ? assets : {})
  .filter(([k, a]) => a && typeof a.href === 'string' && (k === 'overview' || a.roles?.includes('overview'))).map(([, a]) => a.href);

// ── bounds ───────────────────────────────────────────────────────────────────────────────────────

const projectors = new Map();                      // CRS text → (x, y, z) → ECEF, or null when proj4 cannot read it
function projectorFor(crs) {
  const key = typeof crs === 'string' ? crs : JSON.stringify(crs);
  if (!projectors.has(key)) {
    if (projectors.size > 256) projectors.clear();
    projectors.set(key, crsToEcef(crs));
  }
  return projectors.get(key);
}

/**
 * The CRS of an item as (label, projector) candidates, in the order they are tried. `proj:wkt2` first:
 * PDAL copies it from the file, and the COPC stream places the file with that same text through the
 * same proj4, so box and points agree to the millimetre whatever datum shift the WKT carries.
 */
function crsCandidates(p) {
  const out = [];
  if (typeof p['proj:wkt2'] === 'string' && p['proj:wkt2'].trim()) out.push(p['proj:wkt2']);
  if (p['proj:projjson'] && typeof p['proj:projjson'] === 'object') out.push(p['proj:projjson']);
  const epsg = epsgOf(p);
  if (epsg) out.push(epsg);
  return out;
}

/** `EPSG:<n>` from `proj:epsg` (projection extension v1) or `proj:code` (v2), or null. */
export function epsgOf(p) {
  if (Number.isInteger(p?.['proj:epsg']) && p['proj:epsg'] > 0) return `EPSG:${p['proj:epsg']}`;
  const m = /^\s*EPSG:(\d+)\s*$/i.exec(p?.['proj:code'] ?? '');
  return m ? `EPSG:${m[1]}` : null;
}

const streamCodes = new Map();                     // `${code} ${definition}` → the code, or null when this server cannot read it
/**
 * The `&crs=` a COPC item's stream is given: the item's EPSG code, from `proj:epsg` / `proj:code` or
 * from the identifier inside its WKT / PROJJSON. It only matters for a file that declares no CRS of
 * its own (a file's own always wins): flai's COPC carry none, and the COPC files QGIS writes keep
 * theirs in a private `qgis` record. A code this server does not know is registered from the item's
 * own definition, so the URL stays short. Null when the item names no code.
 */
function streamCrs(p) {
  const defs = [p['proj:wkt2'], p['proj:projjson']].filter((d) => d && (typeof d === 'string' ? d.trim() : typeof d === 'object'));
  const code = epsgOf(p) ?? defs.map(epsgOfCrs).find(Boolean) ?? null;
  if (!code) return null;
  const key = `${code} ${typeof defs[0] === 'string' ? defs[0] : JSON.stringify(defs[0] ?? null)}`;
  if (!streamCodes.has(key)) {
    if (streamCodes.size > 256) streamCodes.clear();
    streamCodes.set(key, ensureCrs(code, defs[0] ?? null) ? code : null);
  }
  return streamCodes.get(key);
}

const numbers = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

/** [x0, y0, z0, x1, y1, z1] from a STAC bbox of 6 or 4 numbers (`zRange` fills in a flat one), or null. */
function box3(b, zRange = null) {
  if (numbers(b, 6)) return b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5] ? b : null;
  if (numbers(b, 4)) return b[0] <= b[2] && b[1] <= b[3] ? [b[0], b[1], zRange?.[0] ?? 0, b[2], b[3], zRange?.[1] ?? 0] : null;
  return null;
}

/** The lon/lat extent of a GeoJSON geometry, any depth of nesting. */
function geometryBox(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  (function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
      if (Number.isFinite(c[2])) { if (c[2] < z0) z0 = c[2]; if (c[2] > z1) z1 = c[2]; }
      return;
    }
    for (const k of c) walk(k);
  })(g?.coordinates);
  return Number.isFinite(x0) && Number.isFinite(y0) ? [x0, y0, Number.isFinite(z0) ? z0 : 0, x1, y1, Number.isFinite(z1) ? z1 : 0] : null;
}

/**
 * A box in some CRS → `{ sphere, geometricError }` in ECEF, the shape /aggregate bakes into a manifest.
 *
 * The sphere is centred on the box centre and reaches its farthest placed corner. Past 20 km the top
 * and bottom faces are sampled 5 × 5, and the dip of the ellipsoid between two samples is added: a box
 * over a country is not flat. The geometric error is what the COPC stream of that file declares for
 * its own root, the diagonal of the octree cube (the longest side × √3), so that the leaf of the mosaic
 * and the root it references refine in order.
 */
export function boxBounds(box, toEcef) {
  const [x0, y0, z0, x1, y1, z1] = box;
  const at = (i, j, k, n) => toEcef(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * j / n, k ? z1 : z0);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const o = at(0, 0, 0, 1);
  const sides = [dist(o, at(1, 0, 0, 1)), dist(o, at(0, 1, 0, 1)), z1 - z0];
  const side = Math.max(...sides);
  if (!Number.isFinite(side)) return null;
  const n = Math.max(sides[0], sides[1]) > CURVED_MIN_EXTENT ? 4 : 1;
  const c = toEcef((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  let r = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (const k of [0, 1]) r = Math.max(r, dist(c, at(i, j, k, n)));
  if (n > 1) r += (Math.max(sides[0], sides[1]) / n / 2) ** 2 / (2 * EARTH_R);
  if (![...c, r].every(Number.isFinite)) return null;
  r = Math.max(r, 0.01);
  return { sphere: [+c[0].toFixed(3), +c[1].toFixed(3), +c[2].toFixed(3), +r.toFixed(3)], geometricError: +Math.max(side * Math.sqrt(3), r).toFixed(3) };
}

const wgs84ToEcef = (lon, lat, h) => llhToEcef(lon, lat, h);

/**
 * Where a STAC item is: `{ sphere, geometricError, from }`, or null when the item says nothing usable.
 *
 *   1. `proj:bbox` in the item's own CRS, as the spec asks ("will be used instead of their WGS 84
 *      equivalents"). A 2D one takes its heights from the item's WGS 84 `bbox` when that one is 3D.
 *   2. the item's `bbox` (WGS 84), when there is no native box or proj4 cannot read the CRS;
 *   3. the extent of its `geometry` (WGS 84, heights from its coordinates if any).
 */
export function itemBounds(feature) {
  const p = feature?.properties ?? {};
  const stac = box3(feature?.bbox);
  const native = box3(p['proj:bbox'], stac ? [stac[2], stac[5]] : null);
  if (native) {
    for (const crs of crsCandidates(p)) {
      const toEcef = projectorFor(crs);
      const b = toEcef && boxBounds(native, toEcef);
      if (b && Math.hypot(b.sphere[0], b.sphere[1], b.sphere[2]) > 1e6) return { ...b, from: 'proj:bbox' };
    }
  }
  if (stac && Math.abs(stac[0]) <= 360 && Math.abs(stac[1]) <= 90) {
    const b = boxBounds(stac, wgs84ToEcef);
    if (b) return { ...b, from: 'bbox' };
  }
  const g = geometryBox(feature?.geometry);
  if (g && Math.abs(g[0]) <= 360 && Math.abs(g[1]) <= 90) {
    const b = boxBounds(g, wgs84ToEcef);
    if (b) return { ...b, from: 'geometry' };
  }
  return null;
}

// ── parse ────────────────────────────────────────────────────────────────────────────────────────

const SKIP = {
  las: 'plain LAS (no levels of detail)',
  laz: 'plain LAZ (no levels of detail)',
  ept: 'EPT (not supported)',
};

/**
 * A parsed VPC document → the pieces of an /aggregate set. Pure: no file is opened.
 *
 *   entries    COPC by name, ready to stream: { format, url, name, crs?, bounds?, points?, date? };
 *              a nested VPC (`format: 'vpc'`) is one entry too, its leaf the child's own mosaic
 *   ambiguous  `.laz` items, same shape: COPC or not is only known once `isCopc` has read 589 bytes
 *   skipped    [{ href, reason }] — plain LAS, EPT, local paths, items without a data asset
 *   overviews  absolute URLs of the `overview` assets, deduplicated (an overview is shared by items)
 *   nested     how many of the entries are nested VPCs (items whose asset is a .vpc, or child links)
 *
 * `base` is the URL the document came from; without one (a local file) relative hrefs are local paths.
 */
export function parseVpc(doc, base = null) {
  const features = doc?.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features
    : doc?.type === 'Feature' ? [doc] : null;
  if (!features) throw Object.assign(new Error('not a VPC: expected a STAC ItemCollection (a GeoJSON FeatureCollection of items)'), { status: 422 });
  const entries = [], ambiguous = [], skipped = [], overviews = new Set();
  let nested = 0;
  for (const [i, f] of features.entries()) {
    const p = f?.properties ?? {};
    for (const h of overviewAssets(f?.assets)) { const o = resolveHref(h, base); if (o.url && kindOfHref(o.url) === 'copc') overviews.add(o.url); }
    const asset = dataAsset(f?.assets);
    const href = asset?.href;
    const where = resolveHref(href, base);
    // a nested VPC: the href says so, or the item does (`pc:type: "vpc"`, an asset typed as a VPC)
    const kind = !where.url ? null : kindOfHref(where.url) ?? (isVpcItem(p, asset) ? 'vpc' : null);
    const label = typeof href === 'string' ? href : `item ${f?.id ?? i}`;
    if (!where.url) { skipped.push({ href: label, reason: where.reason }); continue; }
    if (kind !== 'copc' && kind !== 'laz' && kind !== 'vpc') { skipped.push({ href: label, reason: SKIP[kind] ?? 'not a LAS/LAZ/COPC file' }); continue; }
    const b = itemBounds(f);
    const epsg = streamCrs(p);
    const count = Number.isFinite(p['pc:count']) ? p['pc:count'] : null;
    const date = typeof p.datetime === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.datetime) ? p.datetime.slice(0, 10) : null;
    const entry = {
      format: kind === 'vpc' ? 'vpc' : 'copc', url: where.url,
      name: String(f.id ?? decodeURIComponent(pathOf(where.url).split('/').pop())),
      // /stream's &crs=, for a file that carries no CRS of its own (see streamCrs)
      ...(epsg && kind !== 'vpc' ? { crs: epsg } : {}),
      ...(count != null ? { points: count } : {}),
      ...(date ? { date } : {}),
      ...(b ? { bounds: { sphere: b.sphere, geometricError: b.geometricError } } : {}),
    };
    Object.defineProperty(entry, 'boundsFrom', { value: b?.from ?? 'probe', enumerable: false });
    if (kind === 'vpc') nested++;
    (kind === 'laz' ? ambiguous : entries).push(entry);
  }
  // STAC's other way of pointing down: `links` of rel "child" to further VPC files. No bounds travel on
  // a link, so such an entry is placed by reading its mosaic's root (`boundsFrom.probe`). A link to a
  // child an item already names (vpc-split.mjs writes both forms) adds nothing.
  const named = new Set(entries.map((e) => e.url));
  for (const l of Array.isArray(doc.links) ? doc.links : []) {
    if (l?.rel !== 'child' || typeof l.href !== 'string') continue;
    const where = resolveHref(l.href, base);
    if (!where.url) { skipped.push({ href: l.href, reason: where.reason }); continue; }
    if (named.has(where.url)) continue;
    if (kindOfHref(where.url) !== 'vpc' && !/vpc/i.test(l.type ?? '')) { skipped.push({ href: l.href, reason: 'child link that is not a VPC' }); continue; }
    const entry = { format: 'vpc', url: where.url, name: String(l.title ?? decodeURIComponent(pathOf(where.url).split('/').pop())) };
    Object.defineProperty(entry, 'boundsFrom', { value: 'probe', enumerable: false });
    nested++;
    entries.push(entry);
  }
  return { items: features.length, entries, ambiguous, skipped, overviews: [...overviews], nested };
}

/** Whether an item says it is a nested VPC without its href saying so: `pc:type: "vpc"`, or a data asset typed as one. */
const isVpcItem = (p, asset) => String(p?.['pc:type'] ?? '').toLowerCase() === 'vpc' || /vpc/i.test(String(asset?.type ?? ''));

// ── COPC or not ──────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a LAS/LAZ file is a COPC, from its first 589 bytes: the spec puts the `copc` info VLR first,
 * right after the 375-byte LAS 1.4 header (user id at 377, record id 1 at 393). One small range read.
 */
export async function isCopc(url, fetchRange = fetchSourceRange) {
  const b = Buffer.from(await fetchRange(url, 0, 589, { attempts: 2, timeoutMs: 20_000 }));
  return b.length >= 395 && b.toString('latin1', 0, 4) === 'LASF' && b.toString('latin1', 377, 381) === 'copc' && b.readUInt16LE(393) === 1;
}

const SNIFF_SAMPLE = 16;
const SNIFF_CONCURRENCY = 16;

async function pooled(items, worker, limit) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await worker(items[i]).catch(() => null);
  }));
  return out;
}

/**
 * Sort the `.laz` items of a VPC into COPC and plain LAZ.
 *
 *   'auto'  reads the first 16. None a COPC: the rest are taken for plain LAZ unread, since a VPC of
 *           10 000 plain tiles must not cost 10 000 requests to say so. Any a COPC: every one is read.
 *   'all'   reads every one;   'off' reads none (all of them skipped).
 *
 * → { copc: entries, skipped: [{ href, reason }], sniffed }
 */
export async function sortAmbiguous(ambiguous, mode = 'auto', probe = isCopc) {
  if (!ambiguous.length) return { copc: [], skipped: [], sniffed: 0 };
  const skip = (e, reason) => ({ href: e.url, reason });
  if (mode === 'off') return { copc: [], skipped: ambiguous.map((e) => skip(e, 'plain LAZ by name (not read: sniff=0)')), sniffed: 0 };
  const verdict = new Array(ambiguous.length).fill(undefined);
  const read = async (idx) => { (await pooled(idx, (i) => probe(ambiguous[i].url), SNIFF_CONCURRENCY)).forEach((v, k) => { verdict[idx[k]] = v; }); };
  const all = ambiguous.map((_, i) => i);
  const head = mode === 'all' ? all : all.slice(0, SNIFF_SAMPLE);
  await read(head);
  if (mode !== 'all' && head.some((i) => verdict[i] === true)) await read(all.slice(SNIFF_SAMPLE));
  const copc = [], skipped = [];
  ambiguous.forEach((e, i) => {
    if (verdict[i] === true) copc.push(e);
    else skipped.push(skip(e, verdict[i] === false ? SKIP.laz : verdict[i] === null ? 'unreadable (the COPC check failed)'
      : `plain LAZ by name (the first ${SNIFF_SAMPLE} read were: add &sniff=all to read every file)`));
  });
  return { copc, skipped, sniffed: verdict.filter((v) => v !== undefined).length };
}

// ── the set ──────────────────────────────────────────────────────────────────────────────────────

const SKIPPED_LISTED = 20;                         // hrefs named in the report; the counts cover the rest

/** `sniff=` of a request → 'auto' | 'all' | 'off'. */
export function sniffParam(v) {
  const s = String(v ?? 'auto').toLowerCase();
  return ['0', 'off', 'false', 'no', 'none'].includes(s) ? 'off' : s === 'all' || s === '1' || s === 'on' ? 'all' : 'auto';
}

/**
 * A parsed VPC (+ the verdict on its `.laz` items) → `{ set, report }`: the /aggregate set, and what
 * became of every item. Throws a 422 when nothing is left to stream.
 */
export function vpcToSet(parsed, sorted = { copc: [], skipped: [], sniffed: 0 }, { url = null, label = null } = {}) {
  const entries = [...parsed.entries, ...sorted.copc];
  const skipped = [...parsed.skipped, ...sorted.skipped];
  const reasons = {};
  for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  const boundsFrom = {};
  for (const e of entries) boundsFrom[e.boundsFrom ?? 'probe'] = (boundsFrom[e.boundsFrom ?? 'probe'] ?? 0) + 1;
  const report = {
    ...(url ? { url } : {}),
    items: parsed.items, streamed: entries.length, skipped: skipped.length,
    ...(skipped.length ? { skippedReasons: reasons, skippedItems: skipped.slice(0, SKIPPED_LISTED) } : {}),
    sniffed: sorted.sniffed,
    // where each streamed item's box came from; `probe` = the item gave none, so /aggregate reads that file's root
    boundsFrom,
    points: entries.reduce((n, e) => n + (e.points ?? 0), 0),
    // nested VPCs among the streamed entries: each is one leaf here, a whole mosaic of its own below
    ...(parsed.nested ? { nested: parsed.nested } : {}),
    ...(parsed.overviews.length ? { overviews: parsed.overviews } : {}),
  };
  if (!entries.length) {
    const why = Object.entries(reasons).map(([r, n]) => `${n} × ${r}`).join(', ') || 'it has no item';
    const has = (re) => Object.keys(reasons).some((r) => re.test(r));
    const hints = [
      has(/plain LA[SZ]/) && 'A plain LAS/LAZ file has no levels of detail to stream: write the files as COPC first (pdal translate in.laz out.copc.laz, or untwine), then build the VPC over those.',
      has(/local path|unsupported scheme/) && 'This server reads sources over HTTP: publish the files next to the .vpc (relative hrefs resolve against its URL), or write absolute http(s) hrefs.',
    ].filter(Boolean);
    throw Object.assign(new Error(`no streamable COPC item in this VPC (${parsed.items} items: ${why}). ${hints.join(' ')}`.trim()), { status: 422, detail: { vpc: report } });
  }
  const name = label || (url ? decodeURIComponent(pathOf(url).split('/').pop()) : 'Virtual point cloud');
  return { set: { label: name, entries, manifest: true, local: false, provider: null, attribution: null }, report };
}

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const cache = new Map();                           // `${sniff} ${url}` → { at, promise }
const CACHE_MAX = 32;

/**
 * The bytes of a .vpc → its JSON. A gzipped file (`.vpc.gz`, or any file that starts with the gzip
 * magic, whatever its name or Content-Type) is inflated first: a country's VPC is 10 000 items and
 * more, 11 MB of JSON that gzip takes to 1.2 MB, and a static host serves it as is.
 */
export function parseVpcBytes(bytes, url = '') {
  let b = Buffer.from(bytes);
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) {
    try { b = gunzipSync(b); }
    catch { throw Object.assign(new Error(`not a VPC: ${url.split('?')[0].slice(-80)} is gzip that does not inflate`), { status: 422 }); }
  }
  try { return JSON.parse(new TextDecoder().decode(b)); }
  catch { throw Object.assign(new Error(`not a VPC: ${url.split('?')[0].slice(-80)} is not JSON`), { status: 422 }); }
}

/**
 * Fetch a .vpc and turn it into `{ set, report }`. Kept for `ttlMs` (a day, like the mosaic built from
 * it; `&ttl=0` re-reads), failures for a minute. The only reads are the .vpc itself and, for items
 * named `.laz`, the 589-byte COPC check.
 */
export function vpcSet(url, { ttlMs = DEFAULT_TTL_MS, sniff = 'auto' } = {}) {
  if (!isHttp(url)) return Promise.reject(Object.assign(new Error('?vpc= / ?url= needs an absolute http(s) URL of a .vpc file'), { status: 400 }));
  const key = `${sniff} ${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? Math.min(ttlMs, 60_000) : ttlMs)) return hit.promise;
  const entry = { at: Date.now(), failed: false };
  entry.promise = (async () => {
    const t0 = performance.now();
    const doc = parseVpcBytes(await fetchSource(url), url);
    const parsed = parseVpc(doc, url);
    const sorted = await sortAmbiguous(parsed.ambiguous, sniff);
    const out = vpcToSet(parsed, sorted, { url });
    out.report.readMs = Math.round(performance.now() - t0);
    const r = out.report;
    console.log(`[vpc] ${url.split('?')[0].slice(-80)}: ${r.items} items, ${r.streamed} streamed${r.nested ? ` (${r.nested} nested VPC)` : ''}, ${r.skipped} skipped`
      + (r.skipped ? ` (${Object.entries(r.skippedReasons).map(([k, n]) => `${n} ${k}`).join('; ')})` : '') + (r.sniffed ? `, ${r.sniffed} read to tell` : ''));
    return out;
  })();
  entry.promise.catch(() => { entry.failed = true; });
  cache.delete(key);
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry.promise;
}

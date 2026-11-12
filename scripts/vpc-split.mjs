/**
 * vpc-split.mjs — a VPC of a country as a quadtree of VPC files: Potree's hierarchy step, for VPCs.
 *
 * One .vpc over 337 206 tiles is 180 MB of JSON. Whoever opens it (QGIS, PDAL, the tile-server) parses
 * every item before showing the first, and gzip takes it to 18 MB that still travel whole. So the
 * items are cut into a quadtree on their WGS 84 centres, each cell a VPC FILE of its own under
 * `--max-items` items (2 048) and `--max-bytes` of JSON (2 MB), and a ROOT VPC whose items stand for
 * the children: one STAC item per child file, with the union of its items' extents as `bbox`,
 * `geometry` and `proj:bbox` (when the children share one CRS), the sum of their `pc:count`, and the
 * child file as its data asset. An intermediate level is written only when the root would otherwise
 * exceed the limits itself: the root lists the leaves directly when it can, so a reader hops once.
 *
 * THE LINKAGE, in the STAC way, two forms at once:
 *
 *   1. child ITEMS: a Feature whose `assets.data.href` is the child `.vpc.gz`, `pc:type: "vpc"`,
 *      `pc:encoding: "application/geo+json"`, `vpc:items` the number of point cloud files below.
 *      This is the form that carries bounds, so a root is served without opening a child; it is what
 *      vpc-live.js places. A PDAL reader that cannot read a `.vpc` asset filters the items out on
 *      `pc:type` (readers.stac's `properties` option); QGIS draws the extents and fails only the
 *      sub-index it tries to load.
 *   2. root-level `links: [{ rel: "child", href, type: "application/geo+json" }]`, one per child,
 *      which a STAC crawler follows and vpc-live.js also accepts (placed by reading the child's mosaic
 *      root, since a link carries no bounds). The two name the same files; the server reads each once.
 *
 *   node scripts/vpc-split.mjs <in.vpc[.gz] | https://…vpc> -o <dir>/<name>.vpc.gz [--max-items 2048] [--max-bytes 2000000] [--flat] [--pretty]
 *
 * writes <dir>/<name>.vpc.gz (the root) and <dir>/<name>/<quadkey>.vpc.gz (the children, gzipped when
 * the root is); with `--flat`, the children beside the root as <dir>/<name>.<quadkey>.vpc.gz, for a host
 * that has no folders (the sets in the library are assets of a GitHub release). Keys are quadkeys from the root's extent: 0 SW, 1 SE, 2 NW, 3 NE, one digit per level.
 * Serve the root as any VPC: /aggregate/tileset.json?vpc=<root url>.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const DEFAULTS = { maxItems: 2048, maxBytes: 2_000_000 };

const numbers = (a, n) => Array.isArray(a) && a.length >= n && a.slice(0, n).every(Number.isFinite);

/** The WGS 84 box [x0, y0, z0, x1, y1, z1] of a feature: its `bbox` (2D filled with heights 0), else its geometry's. */
export function featureBox(f) {
  const b = f?.bbox;
  if (numbers(b, 6) && b.length === 6) return b;
  if (numbers(b, 4) && b.length === 4) return [b[0], b[1], 0, b[2], b[3], 0];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  (function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
      if (Number.isFinite(c[2])) { z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]); }
      return;
    }
    for (const k of c) walk(k);
  })(f?.geometry?.coordinates);
  return Number.isFinite(x0) ? [x0, y0, Number.isFinite(z0) ? z0 : 0, x1, y1, Number.isFinite(z1) ? z1 : 0] : null;
}

const crsKeyOf = (p) => (typeof p?.['proj:wkt2'] === 'string' ? `wkt:${p['proj:wkt2']}` : p?.['proj:projjson'] ? `json:${JSON.stringify(p['proj:projjson'])}`
  : Number.isInteger(p?.['proj:epsg']) ? `epsg:${p['proj:epsg']}` : typeof p?.['proj:code'] === 'string' ? `code:${p['proj:code']}` : null);

/**
 * The item that stands for a child VPC in its parent: the union of the child's items. `href` is the
 * asset href as the parent will write it (relative, `./name/key.vpc.gz`).
 */
export function summaryItem(features, { id, href, items }) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let n0 = Infinity, e0 = Infinity, h0 = Infinity, n1 = -Infinity, e1 = -Infinity, h1 = -Infinity;
  let count = 0, crsKey = undefined, crsProps = null, dates = [];
  for (const f of features) {
    const b = featureBox(f);
    if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]); x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]); }
    const p = f.properties ?? {};
    if (Number.isFinite(p['pc:count'])) count += p['pc:count'];
    if (typeof p.datetime === 'string') dates.push(p.datetime);
    const k = crsKeyOf(p), pb = p['proj:bbox'];
    if (crsKey === undefined) { crsKey = k; crsProps = k ? Object.fromEntries(['proj:wkt2', 'proj:projjson', 'proj:epsg', 'proj:code'].filter((n) => p[n] != null).map((n) => [n, p[n]])) : null; }
    else if (k !== crsKey) crsKey = null;
    if (numbers(pb, 6) && pb.length === 6) { e0 = Math.min(e0, pb[0]); n0 = Math.min(n0, pb[1]); h0 = Math.min(h0, pb[2]); e1 = Math.max(e1, pb[3]); n1 = Math.max(n1, pb[4]); h1 = Math.max(h1, pb[5]); }
    else if (numbers(pb, 4) && pb.length === 4) { e0 = Math.min(e0, pb[0]); n0 = Math.min(n0, pb[1]); e1 = Math.max(e1, pb[2]); n1 = Math.max(n1, pb[3]); }
    else crsKey = null;                              // an item without a native box: the union has none either
  }
  dates.sort();
  const r = (v) => +v.toFixed(8);
  const hasBox = Number.isFinite(x0);
  const ring = hasBox ? [[r(x0), r(y0)], [r(x1), r(y0)], [r(x1), r(y1)], [r(x0), r(y1)], [r(x0), r(y0)]] : null;
  const native = crsKey && Number.isFinite(e0) ? [e0, n0, Number.isFinite(h0) ? h0 : z0, e1, n1, Number.isFinite(h1) ? h1 : z1].map((v) => +v.toFixed(2)) : null;
  return {
    type: 'Feature', stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/pointcloud/v1.0.0/schema.json', 'https://stac-extensions.github.io/projection/v1.1.0/schema.json'],
    id,
    geometry: ring ? { type: 'Polygon', coordinates: [ring] } : null,
    ...(hasBox ? { bbox: [r(x0), r(y0), +z0.toFixed(2), r(x1), r(y1), +z1.toFixed(2)] } : {}),
    properties: {
      datetime: dates.at(-1) ?? new Date().toISOString(),
      ...(dates.length > 1 && dates[0] !== dates.at(-1) ? { start_datetime: dates[0], end_datetime: dates.at(-1) } : {}),
      'pc:count': count, 'pc:type': 'vpc', 'pc:encoding': 'application/geo+json',
      'vpc:items': items,                                // point cloud files below this child, all levels
      ...(native ? { 'proj:bbox': native, ...crsProps } : {}),
    },
    links: [],
    assets: { data: { href, type: 'application/geo+json', roles: ['data'], title: `${items} items` } },
  };
}

/**
 * Cut `doc`'s features into a quadtree of VPC documents. Pure: returns `{ root, files, stats }` where
 * `files` maps a quadkey to the child document (`''` is never in it: that is `root`), each child's
 * items unchanged, and every parent's items the summaries of its children. `name` is the root's base
 * name (children are referenced as `./<name>/<key>.vpc[.gz]`), `ext` the children's extension.
 */
export function splitVpc(doc, { maxItems = DEFAULTS.maxItems, maxBytes = DEFAULTS.maxBytes, name = 'root', ext = '.vpc.gz', rootHref = null, flat = false } = {}) {
  const features = doc?.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features : null;
  if (!features) throw new Error('not a VPC: expected a GeoJSON FeatureCollection of STAC items');
  const WRAP = 60;                                   // the FeatureCollection around the items, and a comma per item
  const rows = features.map((f) => { const b = featureBox(f); return { f, bytes: JSON.stringify(f).length + 1, cx: b ? (b[0] + b[3]) / 2 : null, cy: b ? (b[1] + b[4]) / 2 : null }; });
  const fits = (rs) => rs.length <= maxItems && rs.reduce((n, r) => n + r.bytes, WRAP) <= maxBytes;

  // 1. the leaves: split on the midpoint of the centres' extent until each cell fits
  const leaves = [];                                 // { key, rows }
  const cut = (rs, key) => {
    const placed = rs.filter((r) => r.cx != null);
    if (fits(rs) || placed.length < 2) { leaves.push({ key, rows: rs }); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of placed) { x0 = Math.min(x0, r.cx); x1 = Math.max(x1, r.cx); y0 = Math.min(y0, r.cy); y1 = Math.max(y1, r.cy); }
    if (x1 - x0 < 1e-9 && y1 - y0 < 1e-9) { leaves.push({ key, rows: rs }); return; }   // every centre the same: nothing to split on
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const q = [[], [], [], []];                      // 0 SW, 1 SE, 2 NW, 3 NE; unplaced items ride in the first quadrant
    for (const r of rs) q[r.cx == null ? 0 : (r.cx > mx ? 1 : 0) + (r.cy > my ? 2 : 0)].push(r);
    // a split along one axis only when the other is flat (a strip of tiles): the empty quadrants just vanish
    for (let i = 0; i < 4; i++) if (q[i].length) cut(q[i], key + i);
  };
  cut(rows, '');

  // 2. the parents: a node lists its leaves directly when they fit, else its four sub-nodes
  const files = new Map();
  const stats = { items: rows.length, leaves: leaves.length, files: 0, depth: 0, leafItems: [], leafBytes: [], levels: 0 };
  // A child's href as the file that lists it writes it. Nested layout: the root sits beside the `<name>/` folder its
  // children are in, so the root says `./<name>/<key>` and a child says `./<key>`. Flat layout (`--flat`): every file
  // is a sibling, `<name>.<key>`, which is what a host without folders (a GitHub release) can hold.
  const hrefOf = (key, from = '') => (flat ? `./${name}.${key}${ext}` : from === '' ? `./${name}/${key}${ext}` : `./${key}${ext}`);
  const parentHref = (from) => (from === '' ? (rootHref ?? (flat ? `./${name}${ext}` : `../${name}${ext}`)) : flat ? `./${name}.${from}${ext}` : `./${from}${ext}`);
  const fileOf = (key, items, extra = {}) => ({ type: 'FeatureCollection', ...extra, features: items });
  const build = (key, depth) => {                    // → the summary item of node `key` as its parent writes it, after writing the node's file
    const mine = leaves.filter((l) => l.key.startsWith(key));
    stats.depth = Math.max(stats.depth, depth);
    if (mine.length === 1 && mine[0].key === key) {  // a leaf: its items, as they came
      const items = mine[0].rows.map((r) => r.f);
      stats.leafItems.push(items.length); stats.leafBytes.push(mine[0].rows.reduce((n, r) => n + r.bytes, WRAP));
      if (key === '') return null;                   // everything fit in the root: nothing to split
      files.set(key, fileOf(key, items, { links: [{ rel: 'parent', href: parentHref(key.slice(0, -1)), type: 'application/geo+json' }] }));
      return summaryItem(items, { id: `${name}-${key}`, href: hrefOf(key, key.slice(0, -1)), items: items.length });
    }
    const subKeys = [...new Set(mine.map((l) => l.key.slice(0, key.length + 1)))].sort();
    const flat = mine.map((l) => summaryItem(l.rows.map((r) => r.f), { id: `${name}-${l.key}`, href: hrefOf(l.key, key), items: l.rows.length }));
    const flatBytes = flat.reduce((n, s) => n + JSON.stringify(s).length + 1, WRAP);
    const children = flat.length <= maxItems && flatBytes <= maxBytes
      ? (mine.forEach((l) => { const items = l.rows.map((r) => r.f); stats.leafItems.push(items.length); stats.leafBytes.push(l.rows.reduce((n, r) => n + r.bytes, WRAP));
          files.set(l.key, fileOf(l.key, items, { links: [{ rel: 'parent', href: parentHref(key), type: 'application/geo+json' }] })); }), flat)
      : subKeys.map((k) => build(k, depth + 1));
    const links = children.map((c) => ({ rel: 'child', href: c.assets.data.href, type: 'application/geo+json', title: c.id }));
    // the root keeps the set's overview, which the items it summarises carried as an asset (the server
    // places it beside the groups, and lowers every leaf's error to what it leaves unseen): an
    // ItemCollection has no assets, so it travels as a link. Only an absolute href survives the move.
    const overview = key === '' ? mine.flatMap((l) => l.rows).map((r) => r.f.assets?.overview?.href).find((h) => /^https?:\/\//i.test(h ?? '')) : null;
    if (overview) links.push({ rel: 'overview', href: overview, type: 'application/vnd.laszip+copc' });
    const node = fileOf(key, children, { links });
    if (key === '') return node;
    files.set(key, node);
    stats.levels++;
    const all = mine.flatMap((l) => l.rows.map((r) => r.f));
    return summaryItem(all, { id: `${name}-${key}`, href: hrefOf(key, key.slice(0, -1)), items: all.length });
  };
  const root = build('', 0) ?? { ...doc };
  stats.files = files.size;
  stats.rootItems = root.features.length;
  stats.rootBytes = JSON.stringify(root).length;
  return { root, files, stats };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

const inflate = (b) => (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);

/**
 * The VPC as an object. A document under V8's string cap is one JSON.parse; a larger one (all of
 * France is 557 MB of JSON, each item with its own WKT) is scanned feature by feature over the bytes —
 * JSON's structural characters are ASCII and every byte of a multi-byte UTF-8 character is ≥ 0x80, so
 * braces and quotes are found without decoding — and the document around the array is parsed on its own.
 */
export function readCollection(bytes, cap = 500_000_000) {
  if (bytes.length < cap) return JSON.parse(bytes.toString('utf8'));
  const key = Buffer.from('"features"');
  let i = bytes.indexOf(key);
  if (i < 0) throw new Error('not a VPC: no "features" array');
  const keyAt = i;
  i += key.length;
  while (bytes[i] !== 0x5b) { if (!/\s|:/.test(String.fromCharCode(bytes[i]))) throw new Error('not a VPC: "features" is not an array'); i++; }
  const arrayAt = i++;
  const features = [];
  for (;;) {
    while (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0x2c) i++;
    if (bytes[i] === 0x5d) break;                    // ]
    if (bytes[i] !== 0x7b) throw new Error(`unexpected byte 0x${bytes[i].toString(16)} at ${i} in the features array`);
    const start = i;
    let depth = 0, inString = false;
    for (; i < bytes.length; i++) {
      const c = bytes[i];
      if (inString) { if (c === 0x5c) i++; else if (c === 0x22) inString = false; }
      else if (c === 0x22) inString = true;
      else if (c === 0x7b) depth++;
      else if (c === 0x7d && --depth === 0) { i++; break; }
    }
    if (depth) throw new Error('unterminated feature');
    features.push(JSON.parse(bytes.toString('utf8', start, i)));
  }
  const rest = JSON.parse(bytes.toString('utf8', 0, keyAt) + '"features":[]' + bytes.toString('utf8', i + 1));
  rest.features = features;
  return rest;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
  const input = argv.find((a, i) => !a.startsWith('-') && !['-o', '--max-items', '--max-bytes'].includes(argv[i - 1]));
  if (!input || !out) { console.error('usage: node scripts/vpc-split.mjs <in.vpc[.gz] | url> -o <dir>/<name>.vpc[.gz] [--max-items 2048] [--max-bytes 2000000] [--flat] [--pretty]'); process.exit(1); }
  const t0 = performance.now();
  const bytes = /^https?:\/\//.test(input) ? Buffer.from(await (await fetch(input)).arrayBuffer()) : await fs.readFile(input);
  const doc = readCollection(inflate(bytes));
  const gz = out.endsWith('.gz'), ext = gz ? '.vpc.gz' : '.vpc';
  const name = path.basename(out).replace(/\.vpc(\.gz)?$/i, '');
  const flat = argv.includes('--flat');
  const { root, files, stats } = splitVpc(doc, { maxItems: Number(flag('max-items')) || DEFAULTS.maxItems, maxBytes: Number(flag('max-bytes')) || DEFAULTS.maxBytes, name, ext, flat });
  const pretty = argv.includes('--pretty') ? 2 : 0;
  const encode = (d) => { const j = JSON.stringify(d, null, pretty) + '\n'; return { json: j, bytes: gz ? gzipSync(j, { level: 9 }) : Buffer.from(j) }; };
  const dir = flat ? path.dirname(out) : path.join(path.dirname(out), name);
  if (files.size) await fs.mkdir(dir, { recursive: true });
  let total = 0, totalJson = 0;
  for (const [key, d] of files) { const e = encode(d); await fs.writeFile(path.join(dir, flat ? `${name}.${key}${ext}` : `${key}${ext}`), e.bytes); total += e.bytes.length; totalJson += e.json.length; }
  const r = encode(root);
  await fs.writeFile(out, r.bytes);
  const sorted = (a) => [...a].sort((x, y) => x - y), med = (a) => sorted(a)[Math.floor(a.length / 2)] ?? 0;
  console.log(`${stats.items} items → root of ${stats.rootItems} items (${(r.json.length / 1e3).toFixed(1)} KB of JSON, ${(r.bytes.length / 1e3).toFixed(1)} KB written) + ${files.size} child files`
    + ` (${stats.leaves} leaves of ${Math.min(...stats.leafItems)}–${Math.max(...stats.leafItems)} items, median ${med(stats.leafItems)}; ${(Math.max(...stats.leafBytes) / 1e6).toFixed(2)} MB of JSON at most; ${stats.levels} intermediate), `
    + `${files.size ? stats.depth + 1 : 0} hop${stats.depth ? 's' : ''} from the root to a leaf file, quadtree ${[...files.keys()].reduce((n, k) => Math.max(n, k.length), 0)} deep, ${(totalJson / 1e6).toFixed(1)} MB of JSON, ${((total + r.bytes.length) / 1e6).toFixed(2)} MB written → ${out}, ${Math.round(performance.now() - t0)} ms`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

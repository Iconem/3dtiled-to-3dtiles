/**
 * copc-to-vpc.mjs — write a Virtual Point Cloud (.vpc) over COPC files that are already online.
 *
 * What `pdal_wrench build_vpc` does, for remote files and without PDAL: each file's LAS header and
 * VLRs are read with one 2 KB range request (the 375-byte LAS 1.4 header, the `copc` info VLR that
 * follows it, the laszip VLR and a WKT VLR when the file carries one; a file whose VLRs run past that
 * window is read again with the tile-server's 64 KB COPC reader), and one STAC item is written per
 * file: `assets.data.href`, a 3D `proj:bbox`, `proj:wkt2` (the file's own WKT) or `proj:epsg` (`--crs`,
 * for files that declare none), `pc:count`, and the WGS 84 `bbox` / `geometry` GeoJSON requires. No
 * statistics and no boundary polygon: those need the points.
 *
 *   node scripts/copc-to-vpc.mjs <url>… [--crs EPSG:<n>] [--overview <url>] -o out.vpc
 *   node scripts/copc-to-vpc.mjs --s3 https://<bucket host> --prefix <dir/> [--prefix <dir/>…] [--listing keys.tsv] [--limit N] -o out.vpc
 *   node scripts/copc-to-vpc.mjs --list urls.txt -o out.vpc            (one URL per line)
 *
 * `--cache headers.ndjson` keeps every header read as it lands and skips it next time: a run that is
 * killed, or a link that drops, resumes where it was.
 *
 * `-o out.vpc.gz` writes the file gzipped (a country is 10 000 items and more: 11 MB of JSON, 1.2 MB
 * gzipped), which the tile-server reads as it reads a plain one. 10 906 Luxembourg tiles took 206 s
 * at 16 reads in flight on a 700 KB/s link; a bucket listing (`--s3`) is 1 000 keys and their sizes
 * per page, cached to `--listing <file>` so a re-run lists nothing.
 *
 * THREE WAYS TO KNOW WHERE A TILE IS AND HOW MANY POINTS IT HOLDS
 *
 *   (default)          one header read per file: exact extent, count, WKT and date. An hour for the
 *                      337 206 tiles of IGN's LiDAR HD.
 *   --estimate <grid>  the footprint from the tile NAME (national campaigns are regular km grids, see
 *                      GRIDS) and `pc:count` from the file SIZE the listing gives, through a bytes-per-
 *                      point ratio fitted on `--calibrate N` (default 500) real header reads drawn at
 *                      random, which also give each tile's heights from its nearest calibrated
 *                      neighbours. The fit is printed. Such items carry `"3dtiled:estimated": ["pc:count",
 *                      "z"]`; a later run without `--estimate` (or with `--headers`) replaces them.
 *   --grid <grid> --extent xmin,ymin,xmax,ymax --url <template>
 *                      no listing and no read at all: every cell of the extent (km) becomes an item
 *                      whose href is the template with {x} / {y} filled in (km, zero-padded to 4),
 *                      `--points N` points each. A cell no file exists for 404s when a viewer reaches
 *                      it, which /aggregate reports as a failed child and the viewer skips.
 *
 * The result opens in QGIS, in PDAL (readers.stac) and here: /stream/tileset.json?format=vpc&url=<it>.
 * Past a few thousand items, split it with scripts/vpc-split.mjs into a root VPC over child VPCs.
 */
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { crsToEcef, ecefToLlh, fetchSourceRange } from '../packages/core/index.js';
import { copcHeaderInfo } from '../packages/tile-server/copc-live.js';

// ── the regular grids a tile name encodes ────────────────────────────────────────────────────────
//
// parse(name) → { x, y } in km, box(x, y) → [x0, y0, x1, y1] in metres of the grid's CRS, name(x, y) the
// file name of a cell (for --grid).
export const GRIDS = {
  // IGN LiDAR HD: 1 km Lambert-93 tiles named by their NORTH-WEST corner in km (LHD_FXX_0600_6833 spans
  // X 600 000–601 000, Y 6 832 000–6 833 000). flai's mirror keeps IGN's names, plus 16 older
  // `LHD_C_LA93-IGN69_0932-6503_2021` ones, same convention. Verified on both forms' headers.
  'ign-lidarhd': {
    epsg: 2154, size: 1000,
    parse: (name) => { const m = /LHD_(?:FXX_(\d{4})_(\d{4})|C_LA93-IGN69_(\d{4})-(\d{4}))/.exec(name); return m ? { x: +(m[1] ?? m[3]), y: +(m[2] ?? m[4]) } : null; },
    box: (x, y) => [x * 1000, (y - 1) * 1000, x * 1000 + 999.99, y * 1000 - 0.01],
    name: (x, y) => `LHD_FXX_${String(x).padStart(4, '0')}_${String(y).padStart(4, '0')}_PTS_C_LAMB93_IGN69`,
  },
  // swisstopo swissSURFACE3D: 1 km LV95 tiles named by their SOUTH-WEST corner in km
  // (swisssurface3d_2026_2671-1221 spans E 2 671 000–2 672 000, N 1 221 000–1 222 000). Verified on a header.
  'swisstopo': {
    epsg: 2056, size: 1000,
    parse: (name) => { const m = /_(\d{4})-(\d{4})(?:_|\.|$)/.exec(name); return m ? { x: +m[1], y: +m[2] } : null; },
    box: (x, y) => [x * 1000, y * 1000, x * 1000 + 999.99, y * 1000 + 999.99],
    name: (x, y) => `swisssurface3d_${x}-${y}`,
  },
};

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const flags = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const VALUE_FLAGS = new Set(['--crs', '--overview', '--s3', '--prefix', '--limit', '--list', '-o', '--listing', '--estimate', '--calibrate', '--bpp', '--grid', '--extent', '--url', '--points', '--z', '--concurrency', '--seed', '--cache']);
const urls = [];
for (let i = 0; i < argv.length; i++) { if (VALUE_FLAGS.has(argv[i])) { i++; continue; } if (!argv[i].startsWith('-')) urls.push(argv[i]); }
const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
const overview = flag('overview'), limit = Number(flag('limit')) || Infinity;
const estimateGrid = flag('estimate') ? GRIDS[flag('estimate')] : null;
const gridMode = flag('grid') ? GRIDS[flag('grid')] : null;
const concurrency = Number(flag('concurrency')) || 16;
if ((flag('estimate') && !estimateGrid) || (flag('grid') && !gridMode)) { console.error(`unknown grid: one of ${Object.keys(GRIDS).join(', ')}`); process.exit(1); }
// the CRS of files that declare none (and of every estimated item: nothing was read): --crs, else the grid's
const crsFlag = flag('crs') ?? ((estimateGrid ?? gridMode) ? `EPSG:${(estimateGrid ?? gridMode).epsg}` : null);

const sizes = new Map();                           // url → bytes, when a listing gave them

// ── sources ──────────────────────────────────────────────────────────────────────────────────────

/** Every `.copc.laz` key under the prefixes of an S3 bucket (ListObjectsV2, public), with sizes, cached as a TSV. */
async function listS3(host, prefixes, cacheFile) {
  const rows = [];
  if (cacheFile && existsSync(cacheFile)) {
    for (const line of (await fs.readFile(cacheFile, 'utf8')).split(/\r?\n/)) { const [key, size] = line.split('\t'); if (key) rows.push([key, +size]); }
    console.error(`  ${rows.length} keys from ${cacheFile}`);
  } else {
    let pages = 0;
    await Promise.all(prefixes.map(async (prefix) => {
      for (let token = null;;) {
        const u = `${host}/?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
        let x = null;
        for (let a = 0; a < 5 && x == null; a++) { try { const r = await fetch(u); if (r.ok) x = await r.text(); } catch { /* retry */ } if (x == null) await new Promise((r) => setTimeout(r, 1000 * (a + 1))); }
        if (x == null) throw new Error(`listing failed: ${u}`);
        for (const m of x.matchAll(/<Key>([^<]+)<\/Key>(?:(?!<\/Contents>).)*?<Size>(\d+)<\/Size>/gs)) rows.push([m[1], +m[2]]);
        if (++pages % 20 === 0) console.error(`  ${pages} pages, ${rows.length} keys`);
        token = /<IsTruncated>true/.test(x) ? /<NextContinuationToken>([^<]+)</.exec(x)?.[1] : null;
        if (!token) break;
      }
    }));
    if (cacheFile) await fs.writeFile(cacheFile, rows.map(([k, s]) => `${k}\t${s}`).join('\n') + '\n');
  }
  const kept = [];
  for (const [key, size] of rows) {
    if (!/\.copc\.laz$/i.test(key) || !prefixes.some((p) => key.startsWith(p))) continue;     // a cached listing may cover more than asked
    const url = `${host}/${key.split('/').map(encodeURIComponent).join('/')}`;
    sizes.set(url, size);
    kept.push(url);
  }
  return kept;
}

// (loops, not spreads: 337 206 arguments overflow the call stack)
if (flag('list')) for (const u of (await fs.readFile(flag('list'), 'utf8')).split(/\r?\n/)) { if (u.trim()) urls.push(u.trim()); }
if (flag('s3')) for (const u of await listS3(flag('s3').replace(/\/$/, ''), flags('prefix').length ? flags('prefix') : [''], flag('listing'))) urls.push(u);
if (gridMode) {
  const [x0, y0, x1, y1] = (flag('extent') ?? '').split(',').map(Number);
  const tpl = flag('url');
  if (![x0, y0, x1, y1].every(Number.isFinite) || !tpl) { console.error('--grid needs --extent xmin,ymin,xmax,ymax (km) and --url <template with {x} and {y}>'); process.exit(1); }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) urls.push(tpl.replace('{x}', String(x).padStart(4, '0')).replace('{y}', String(y).padStart(4, '0')));
}
if (urls.length > limit) urls.length = limit;
if (!urls.length || !out) {
  console.error('usage: node scripts/copc-to-vpc.mjs <copc url>… | --s3 <host> --prefix <dir/> [--listing keys.tsv] | --list <file> | --grid <grid> --extent x0,y0,x1,y1 --url <tpl>'
    + '\n       [--estimate <grid> [--calibrate N] [--bpp <bytes/point>]] [--crs EPSG:<n>] [--overview <url>] [--limit N] [--concurrency N] [--cache headers.ndjson] -o out.vpc[.gz]'
    + `\n       grids: ${Object.keys(GRIDS).join(', ')}`);
  process.exit(1);
}

const round = (v, d) => +v.toFixed(d);

// ── one file's header ────────────────────────────────────────────────────────────────────────────

const HEAD_BYTES = 2048;
/**
 * What the item needs from a COPC file, from its first 2 KB: the LAS 1.4 header (extent at 179, point
 * count at 247, creation day at 90) and its VLRs (the `copc` info record first, as the spec requires;
 * `LASF_Projection` 2112 is the WKT). When the VLRs run past the window, the full reader takes over.
 */
async function readHeader(url) {
  const b = Buffer.from(await fetchSourceRange(url, 0, HEAD_BYTES, { attempts: 3, timeoutMs: 30_000 }));
  if (b.length < 375 || b.toString('latin1', 0, 4) !== 'LASF') throw new Error('not a LAS/COPC file');
  const headerSize = b.readUInt16LE(94), vlrs = b.readUInt32LE(100);
  const max = [b.readDoubleLE(179), b.readDoubleLE(195), b.readDoubleLE(211)];
  const min = [b.readDoubleLE(187), b.readDoubleLE(203), b.readDoubleLE(219)];
  const pointCount = b[25] >= 4 ? Number(b.readBigUInt64LE(247)) : b.readUInt32LE(107);
  const doy = b.readUInt16LE(90), year = b.readUInt16LE(92);
  const created = year > 1990 && doy >= 1 && doy <= 366 ? new Date(Date.UTC(year, 0, doy)) : null;
  let wkt = null, copc = false;
  for (let i = 0, p = headerSize; i < vlrs; i++) {
    if (p + 54 > b.length) return copcHeaderInfo(url);
    const userId = b.toString('latin1', p + 2, p + 18).replace(/\0.*$/, ''), recordId = b.readUInt16LE(p + 18), length = b.readUInt16LE(p + 20);
    if (userId === 'copc' && recordId === 1) copc = true;
    if (userId === 'LASF_Projection' && recordId === 2112) {
      if (p + 54 + length > b.length) return copcHeaderInfo(url);
      wkt = b.toString('utf8', p + 54, p + 54 + length).replace(/\0+$/, '').trim() || null;
    }
    p += 54 + length;
  }
  if (!copc) throw new Error('not a COPC file (no copc info VLR)');
  return { min, max, pointCount, wkt, created };
}

// ── the item ─────────────────────────────────────────────────────────────────────────────────────

const projectors = new Map();
const projectorFor = (crs) => { if (!projectors.has(crs)) projectors.set(crs, crsToEcef(crs)); return projectors.get(crs); };

/** A STAC item over `url` from its extent (`min`/`max` in `crs`), count, date, and what was estimated. */
function makeItem(url, { min, max, pointCount, wkt, created, estimated = null }) {
  const crs = wkt || crsFlag;
  const toEcef = projectorFor(crs);
  if (!toEcef) throw new Error(`no CRS in the file: pass --crs EPSG:<n>`);
  const ll = (x, y, z) => { const [lon, lat] = ecefToLlh(...toEcef(x, y, z)); return [round(lon, 8), round(lat, 8)]; };
  const ring = [ll(min[0], min[1], min[2]), ll(max[0], min[1], min[2]), ll(max[0], max[1], min[2]), ll(min[0], max[1], min[2])];
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  return {
    type: 'Feature', stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/pointcloud/v1.0.0/schema.json', 'https://stac-extensions.github.io/projection/v1.1.0/schema.json'],
    id: decodeURIComponent(url.split('?')[0].split('/').pop()).replace(/\.copc\.laz$/i, ''),
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    bbox: [Math.min(...lons), Math.min(...lats), round(min[2], 2), Math.max(...lons), Math.max(...lats), round(max[2], 2)],
    properties: {
      datetime: (created ?? new Date()).toISOString(),                 // the LAS header's file creation day, as PDAL does
      'pc:count': pointCount, 'pc:type': 'lidar', 'pc:encoding': 'application/vnd.laszip+copc',
      'proj:bbox': [...min, ...max].map((v) => round(v, 2)),
      ...(wkt ? { 'proj:wkt2': wkt } : { 'proj:epsg': Number(/EPSG:(\d+)/i.exec(crsFlag)?.[1]) || null }),
      // what a header read would replace: the count came from the file size, the heights from neighbours
      ...(estimated ? { '3dtiled:estimated': estimated } : {}),
    },
    links: [],
    assets: { data: { href: url, roles: ['data'], type: 'application/vnd.laszip+copc' }, ...(overview ? { overview: { href: overview, roles: ['overview'] } } : {}) },
  };
}

// ── the header cache: a run that is killed resumes where it was ─────────────────────────────────
//
// `--cache <file>` appends one JSON line per header read as it lands: `["W", n, "<wkt>"]` declares a WKT
// once (a campaign's files all carry the same text), `[url, min, max, count, n | null, created | null]`
// a file. On start the file is read back and those URLs are not fetched again: 90 000 reads over a
// link that drops now and then are several runs, and the whole set of a country is worth keeping to
// rebuild the VPC with other options (an `--estimate` run calibrates from it for nothing).
const cache = { file: flag('cache'), rows: new Map(), wkts: [], wktIndex: new Map(), out: null };
if (cache.file) {
  if (existsSync(cache.file)) {
    for (const line of (await fs.readFile(cache.file, 'utf8')).split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }            // a line cut short by the kill
      if (r[0] === 'W') { cache.wkts[r[1]] = r[2]; cache.wktIndex.set(r[2], r[1]); continue; }
      const [url, min, max, pointCount, w, created] = r;
      cache.rows.set(url, { min, max, pointCount, wkt: w == null ? null : cache.wkts[w], created: created ? new Date(created) : null });
    }
    console.error(`  ${cache.rows.size} headers from ${cache.file}`);
  }
  cache.out = createWriteStream(cache.file, { flags: 'a' });
}
const headerInfo = async (url) => {
  const hit = cache.rows.get(url);
  if (hit) return hit;
  const h = await readHeader(url);
  if (cache.out) {
    let w = null;
    if (h.wkt) {
      w = cache.wktIndex.get(h.wkt);
      if (w == null) { w = cache.wkts.length; cache.wkts.push(h.wkt); cache.wktIndex.set(h.wkt, w); cache.out.write(JSON.stringify(['W', w, h.wkt]) + '\n'); }
    }
    cache.out.write(JSON.stringify([url, h.min, h.max, h.pointCount, w, h.created ? h.created.toISOString() : null]) + '\n');
  }
  return h;
};

async function headerItem(url) { return makeItem(url, await headerInfo(url)); }

async function pooled(items, worker, label) {
  const results = new Array(items.length), failed = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      try { results[i] = await worker(items[i], i); } catch (e) { failed.push(`${items[i]}: ${e.message}`); }
      if (++done % 500 === 0) console.error(`  ${label} ${done}/${items.length}`);
    }
  }));
  return { results, failed };
}

// ── estimate mode: names and sizes, a calibrated sample ─────────────────────────────────────────

/** A seeded shuffle's first n indices (deterministic sample: a re-run calibrates on the same files). */
function sample(n, total, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const idx = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0 && i >= total - n; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(Math.max(0, total - n));
}

/**
 * Items for every URL from the grid the name encodes and the size the listing gave. `--calibrate N`
 * files are read for real: their bytes / points give the ratio (a least-squares line through the
 * origin: Σ bytes·points / Σ points², and the spread of the per-file ratios), their heights give every
 * other tile's through its nearest calibrated neighbours in 10 km cells (the envelope of at least 3,
 * widened by a quarter of its own spread and 50 m: a mountain's tile is not placed from a valley's).
 */
async function estimateItems(grid) {
  const cells = urls.map((u) => grid.parse(decodeURIComponent(u.split('?')[0].split('/').pop())));
  const unnamed = cells.filter((c) => !c).length;
  if (unnamed) console.warn(`${unnamed} file names do not follow the ${flag('estimate')} grid: those get a header read`);
  const n = Math.min(urls.length, Number(flag('calibrate')) || 500);
  const bppFlag = Number(flag('bpp')) || null;
  const picked = sample(n, urls.length, Number(flag('seed')) || 7);
  console.error(`  calibrating on ${n} header reads`);
  const t0 = performance.now();
  const { results: heads, failed } = await pooled(picked, (i) => headerInfo(urls[i]), 'calibrate');
  const calib = picked.map((i, k) => heads[k] && { i, ...heads[k], size: sizes.get(urls[i]) ?? null }).filter(Boolean);
  const withSize = calib.filter((c) => c.size);
  let bpp = bppFlag;
  if (!bpp && !withSize.length) throw new Error('no file size to estimate counts from: give --bpp <bytes/point> or list the bucket (--s3)');
  const fit = {};
  if (withSize.length) {
    const sxy = withSize.reduce((s, c) => s + c.size * c.pointCount, 0), sxx = withSize.reduce((s, c) => s + c.pointCount ** 2, 0);
    const ratio = sxy / sxx;
    const ratios = withSize.map((c) => c.size / c.pointCount).sort((a, b) => a - b);
    const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];
    const err = withSize.map((c) => Math.abs(c.size / ratio - c.pointCount) / c.pointCount).sort((a, b) => a - b);
    Object.assign(fit, { files: withSize.length, bytesPerPoint: round(ratio, 3), median: round(q(0.5), 3), p10: round(q(0.1), 3), p90: round(q(0.9), 3),
      medianCountError: `${round(100 * err[Math.floor(err.length / 2)], 1)}%`, p90CountError: `${round(100 * err[Math.floor(err.length * 0.9)], 1)}%`,
      points: withSize.reduce((s, c) => s + c.pointCount, 0), bytes: withSize.reduce((s, c) => s + c.size, 0) });
    bpp ??= ratio;
  }
  console.log(`  bytes per point: ${bpp.toFixed(3)}${bppFlag ? ' (given)' : ''} — fit ${JSON.stringify(fit)}, ${Math.round(performance.now() - t0)} ms${failed.length ? `, ${failed.length} reads failed` : ''}`);
  const created = calib.map((c) => c.created).filter(Boolean).sort((a, b) => b - a)[0] ?? null;

  // heights by neighbourhood: calibrated tiles binned in 10 km cells of the grid's CRS
  const CELL = 10_000;
  const bins = new Map();
  for (const c of calib) { const k = `${Math.floor(c.min[0] / CELL)},${Math.floor(c.min[1] / CELL)}`; (bins.get(k) ?? bins.set(k, []).get(k)).push(c); }
  const zRange = (x, y) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let r = 1; r < 200; r++) {
      const near = [];
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const c of bins.get(`${cx + i},${cy + j}`) ?? []) near.push(c);
      if (near.length >= 3) {
        const lo = Math.min(...near.map((c) => c.min[2])), hi = Math.max(...near.map((c) => c.max[2]));
        const pad = Math.max(50, (hi - lo) / 4);
        return [round(lo - pad, 1), round(hi + pad, 1)];
      }
    }
    return [-100, 5000];
  };
  const byIndex = new Map(calib.map((c) => [c.i, c]));
  const items = new Array(urls.length);
  const rest = [];
  for (const [i, url] of urls.entries()) {
    const c = byIndex.get(i);
    if (c) { items[i] = makeItem(url, c); continue; }
    const cell = cells[i];
    const size = sizes.get(url);
    if (!cell || !size) { rest.push(i); continue; }
    const [x0, y0, x1, y1] = grid.box(cell.x, cell.y);
    const [z0, z1] = zRange(x0, y0);
    items[i] = makeItem(url, { min: [x0, y0, z0], max: [x1, y1, z1], pointCount: Math.round(size / bpp), wkt: null, created, estimated: ['pc:count', 'z'] });
  }
  if (rest.length) {
    console.error(`  ${rest.length} files without a grid name or a size: reading their headers`);
    const r = await pooled(rest, (i) => headerItem(urls[i]), 'headers');
    rest.forEach((i, k) => { items[i] = r.results[k]; });
    failed.push(...r.failed);
  }
  return { items, failed, fit: { ...fit, bytesPerPoint: round(bpp, 3), calibrated: calib.length, estimated: items.filter((it) => it?.properties['3dtiled:estimated']).length } };
}

/** --grid: every cell of the extent, nothing read. */
function gridItems(grid) {
  const points = Number(flag('points')) || 10_000_000;
  const [z0, z1] = (flag('z') ?? '0,500').split(',').map(Number);
  return { items: urls.map((url) => { const c = grid.parse(decodeURIComponent(url.split('/').pop())); const [x0, y0, x1, y1] = grid.box(c.x, c.y);
    return makeItem(url, { min: [x0, y0, z0], max: [x1, y1, z1], pointCount: points, wkt: null, created: null, estimated: ['pc:count', 'z', 'exists'] }); }), failed: [], fit: null };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

const t0 = performance.now();
const { items, failed, fit } = gridMode ? gridItems(gridMode) : estimateGrid ? await estimateItems(estimateGrid) : await pooled(urls, headerItem, 'headers').then((r) => ({ items: r.results, failed: r.failed, fit: null }));
const kept = items.filter(Boolean);
const json = JSON.stringify({ type: 'FeatureCollection', features: kept }, null, argv.includes('--pretty') ? 2 : 0) + '\n';
const bytes = out.endsWith('.gz') ? gzipSync(json, { level: 9 }) : Buffer.from(json);
await fs.writeFile(out, bytes);
console.log(`${urls.length} files → ${kept.length} items (${kept.reduce((n, f) => n + f.properties['pc:count'], 0).toLocaleString('en')} points${fit ? `, ${fit.estimated} estimated from ${fit.calibrated} calibrated` : ''}) → ${out}, `
  + `${(json.length / 1e6).toFixed(2)} MB of JSON${out.endsWith('.gz') ? ` (${(bytes.length / 1e6).toFixed(2)} MB gzipped)` : ''}, ${Math.round(performance.now() - t0)} ms`);
if (failed.length) console.warn(`${failed.length} failed:\n  ${failed.slice(0, 10).join('\n  ')}`);
if (cache.out) { await new Promise((r) => cache.out.end(r)); await new Promise((r) => setImmediate(r)); }
process.exit(0);

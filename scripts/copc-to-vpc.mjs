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
 *   node scripts/copc-to-vpc.mjs --s3 https://<bucket host> --prefix <dir/> [--limit N] [--crs …] -o out.vpc
 *   node scripts/copc-to-vpc.mjs --list urls.txt -o out.vpc            (one URL per line)
 *
 * `-o out.vpc.gz` writes the file gzipped (a country is 10 000 items and more: 11 MB of JSON, 1.2 MB
 * gzipped), which the tile-server reads as it reads a plain one. 10 906 Luxembourg tiles took 206 s
 * at 16 reads in flight on a 700 KB/s link.
 *
 * The result opens in QGIS, in PDAL (readers.stac) and here: /stream/tileset.json?format=vpc&url=<it>.
 */
import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { crsToEcef, ecefToLlh, fetchSourceRange } from '../packages/core/index.js';
import { copcHeaderInfo } from '../packages/tile-server/copc-live.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const VALUE_FLAGS = new Set(['--crs', '--overview', '--s3', '--prefix', '--limit', '--list', '-o', '--pretty']);
const urls = [];
for (let i = 0; i < argv.length; i++) { if (VALUE_FLAGS.has(argv[i])) { i++; continue; } if (!argv[i].startsWith('-')) urls.push(argv[i]); }
const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
const crsFlag = flag('crs'), overview = flag('overview'), limit = Number(flag('limit')) || Infinity;

if (flag('list')) urls.push(...(await fs.readFile(flag('list'), 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
if (flag('s3')) {
  const host = flag('s3').replace(/\/$/, ''), prefix = flag('prefix') ?? '';
  for (let token = null; urls.length < limit;) {
    const x = await (await fetch(`${host}/?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`)).text();
    for (const m of x.matchAll(/<Key>([^<]+)<\/Key>/g)) if (/\.copc\.laz$/i.test(m[1])) urls.push(`${host}/${m[1].split('/').map(encodeURIComponent).join('/')}`);
    token = /<IsTruncated>true/.test(x) ? /<NextContinuationToken>([^<]+)</.exec(x)?.[1] : null;
    if (!token) break;
  }
}
if (urls.length > limit) urls.length = limit;
if (!urls.length || !out) { console.error('usage: node scripts/copc-to-vpc.mjs <copc url>… | --s3 <host> --prefix <dir/> | --list <file>  [--crs EPSG:<n>] [--overview <url>] [--limit N] -o out.vpc'); process.exit(1); }

const round = (v, d) => +v.toFixed(d);

const HEAD_BYTES = 2048;
/**
 * What the item needs from a COPC file, from its first 2 KB: the LAS 1.4 header (extent at 179, point
 * count at 247, creation day at 90) and its VLRs (the `copc` info record first, as the spec requires;
 * `LASF_Projection` 2112 is the WKT). When the VLRs run past the window, the full reader takes over.
 */
async function headerInfo(url) {
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

async function item(url) {
  const { min, max, pointCount, wkt, created } = await headerInfo(url);
  const crs = wkt || crsFlag;
  const toEcef = crsToEcef(crs);
  if (!toEcef) throw new Error(`no CRS in the file: pass --crs EPSG:<n>`);
  const ll = (x, y, z) => { const [lon, lat] = ecefToLlh(...toEcef(x, y, z)); return [round(lon, 9), round(lat, 9)]; };
  const ring = [ll(min[0], min[1], min[2]), ll(max[0], min[1], min[2]), ll(max[0], max[1], min[2]), ll(min[0], max[1], min[2])];
  const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
  return {
    type: 'Feature', stac_version: '1.0.0',
    stac_extensions: ['https://stac-extensions.github.io/pointcloud/v1.0.0/schema.json', 'https://stac-extensions.github.io/projection/v1.1.0/schema.json'],
    id: decodeURIComponent(url.split('?')[0].split('/').pop()).replace(/\.copc\.laz$/i, ''),
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    bbox: [Math.min(...lons), Math.min(...lats), round(min[2], 3), Math.max(...lons), Math.max(...lats), round(max[2], 3)],
    properties: {
      datetime: (created ?? new Date()).toISOString(),                 // the LAS header's file creation day, as PDAL does
      'pc:count': pointCount, 'pc:type': 'lidar', 'pc:encoding': 'application/vnd.laszip+copc',
      'proj:bbox': [...min, ...max].map((v) => round(v, 3)),
      ...(wkt ? { 'proj:wkt2': wkt } : { 'proj:epsg': Number(/EPSG:(\d+)/i.exec(crsFlag)?.[1]) || null }),
    },
    links: [],
    assets: { data: { href: url, roles: ['data'] }, ...(overview ? { overview: { href: overview, roles: ['overview'] } } : {}) },
  };
}

const features = new Array(urls.length);
const failed = [];
let next = 0, done = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: Math.min(16, urls.length) }, async () => {
  for (let i = next++; i < urls.length; i = next++) {
    try { features[i] = await item(urls[i]); } catch (e) { failed.push(`${urls[i]}: ${e.message}`); }
    if (++done % 100 === 0) console.error(`  ${done}/${urls.length}`);
  }
}));
const kept = features.filter(Boolean);
const json = JSON.stringify({ type: 'FeatureCollection', features: kept }, null, argv.includes('--pretty') ? 2 : 0) + '\n';
const bytes = out.endsWith('.gz') ? gzipSync(json, { level: 9 }) : Buffer.from(json);
await fs.writeFile(out, bytes);
console.log(`${urls.length} files → ${kept.length} items (${kept.reduce((n, f) => n + f.properties['pc:count'], 0).toLocaleString('en')} points) → ${out}, `
  + `${(json.length / 1e6).toFixed(2)} MB of JSON${out.endsWith('.gz') ? ` (${(bytes.length / 1e6).toFixed(2)} MB gzipped)` : ''}, ${Math.round(performance.now() - t0)} ms`);
if (failed.length) console.warn(`${failed.length} failed:\n  ${failed.slice(0, 10).join('\n  ')}`);
process.exit(0);

/**
 * vpc-to-grid.mjs — a VPC over a national grid as a GRID VPC (packages/tile-server/vpc-grid.js): the grid,
 * a URL template and the rows of cells that exist, instead of one STAC item per tile.
 *
 *   node scripts/vpc-to-grid.mjs <in.vpc[.gz] | https://…vpc> --grid ign-lidarhd \
 *     --url 'https://host/dir/LHD_FXX_{x}_{y}_PTS_{v}_LAMB93_IGN69.copc.laz' -o france.gridvpc.json.gz
 *     [--title …] [--license …] [--attribution …] [--source …] [--overview <url>] [--no-stats] [--points-unit 100000]
 *
 * The input is a flat VPC (scripts/copc-to-vpc.mjs writes one) or a split one read from disk (the root and
 * its `./<name>/<key>.vpc.gz` children). Each item's place comes from its file NAME through the grid, its
 * heights and count from the item; `{v}` is whatever the template leaves open (IGN: `C` or `O`). An item
 * whose name is not of the grid, or that does not match the template, is kept whole under `extra`.
 * `--no-stats` leaves the per-cell heights and counts out: the availability alone (40 KB for France).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GRIDS, buildGridVpc, templateRe } from '../packages/tile-server/vpc-grid.js';
import { readCollection } from './vpc-split.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const VALUE = new Set(['--grid', '--url', '-o', '--title', '--license', '--attribution', '--source', '--overview', '--points-unit']);
const input = argv.find((a, i) => !a.startsWith('-') && !VALUE.has(argv[i - 1]));
const out = flag('o') ?? (argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null);
const grid = GRIDS[flag('grid')];
const template = flag('url');
if (!input || !out || !grid || !template) {
  console.error(`usage: node scripts/vpc-to-grid.mjs <in.vpc[.gz] | url> --grid <${Object.keys(GRIDS).join('|')}> --url <template with {x} {y} [{v}]> -o out.gridvpc.json[.gz]`);
  process.exit(1);
}

const inflate = (b) => (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);
const isHttp = (s) => /^https?:\/\//i.test(s);
const read = async (where) => readCollection(inflate(isHttp(where) ? Buffer.from(await (await fetch(where)).arrayBuffer()) : await fs.readFile(where)));

/** Every point cloud item of a VPC, nested child VPCs followed (from disk or over HTTP, relative to their parent). */
async function* items(where) {
  const doc = await read(where);
  for (const f of doc.features ?? []) {
    const href = f.assets?.data?.href ?? '';
    if (/\.vpc(\.gz)?$/i.test(href.split('?')[0]) || f.properties?.['pc:type'] === 'vpc') {
      yield* items(isHttp(href) ? href : isHttp(where) ? new URL(href, where).href : path.resolve(path.dirname(where), href));
    } else yield f;
  }
}

const t0 = performance.now();
const re = templateRe(template.split('/').pop());
const cells = [], extra = [];
let n = 0;
for await (const f of items(input)) {
  n++;
  const p = f.properties ?? {}, href = f.assets?.data?.href ?? '';
  const name = decodeURIComponent(href.split(/[?#]/)[0].split('/').pop());
  const at = grid.parse(name), m = re.exec(name);
  const box = Array.isArray(p['proj:bbox']) && p['proj:bbox'].length === 6 ? p['proj:bbox'] : null;
  if (at && m && +m.groups.x === at.x && +m.groups.y === at.y) cells.push({ x: at.x, y: at.y, v: m.groups.v ?? '', z0: box?.[2], z1: box?.[5], count: p['pc:count'] });
  else if (box && isHttp(href)) extra.push({ url: href, bbox: box.map((v) => +v.toFixed(2)), points: p['pc:count'] });
  else console.warn(`skipped (no grid name and no proj:bbox): ${href}`);
}
const { doc, stats } = buildGridVpc(cells, {
  crs: `EPSG:${grid.epsg}`, unit: grid.unit, cell: grid.cell, anchor: grid.anchor, pad: grid.pad, url: template,
  title: flag('title'), license: flag('license'), attribution: flag('attribution'), source: flag('source'), overview: flag('overview'),
  extra, withStats: !argv.includes('--no-stats'), pointsUnit: Number(flag('points-unit')) || 100_000,
});
const json = JSON.stringify(doc).replace(/"rows":\[/, '"rows":[\n').replace(/","(?=[.0-9a-z]{20})/g, '",\n"') + '\n';
const bytes = out.endsWith('.gz') ? gzipSync(json, { level: 9 }) : Buffer.from(json);
await fs.writeFile(out, bytes);
console.log(`${n} items → ${stats.present} cells of a ${stats.width} × ${stats.height} grid (${Object.entries(stats.variants).map(([v, c]) => `${c} "${v}"`).join(', ')}`
  + `${stats.duplicates ? `, ${stats.duplicates} squares named twice: first kept` : ''}), ${extra.length} extra, ${stats.points.toLocaleString('en')} points → ${out}, `
  + `${(json.length / 1e6).toFixed(2)} MB of JSON, ${(bytes.length / 1e3).toFixed(1)} KB written, ${Math.round(performance.now() - t0)} ms`);

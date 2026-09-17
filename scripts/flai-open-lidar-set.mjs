/**
 * flai-open-lidar-set.mjs — turn flai-ai/open-lidar-data's catalogue into an /aggregate set.
 *
 * flai mirrors national open LiDAR (Estonia, UK, Finland, Belgium, Poland, Spain, Denmark, France,
 * Germany, the Netherlands, NOAA …) as COPC in the public bucket `open-lidar-data`, CORS-open with
 * range requests. There is no machine-readable catalogue: the list is a Markdown table in the repo
 * README (name, EPSG, path, start, end, density, licence). Each path holds `copc/` (thousands of
 * tiles), `overview/overview.copc.laz` (ONE COPC for the whole dataset) and `shp/` (per-file bboxes).
 *
 * The set uses one entry per catalogue row, pointing at the overview COPC: a whole country's scan as
 * one child, streamed by range requests (only the header and hierarchy pages are ever read up front,
 * even for the 12 GB Danish overview). The files carry no CRS VLR at all, so each entry carries the
 * EPSG the table declares, and /aggregate passes it to /stream as `&crs=EPSG:<n>`.
 *
 *   node scripts/flai-open-lidar-set.mjs [--check]   → packages/tile-server/aggregate-sets/flai.json
 *
 * --check HEADs every overview first and drops the ones that don't exist.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const README = 'https://raw.githubusercontent.com/flai-ai/open-lidar-data/main/README.md';
const BUCKET = 'https://open-lidar-data.s3.eu-central-1.amazonaws.com';
const OUT = fileURLToPath(new URL('../packages/tile-server/aggregate-sets/flai.json', import.meta.url));
const CHECK = process.argv.includes('--check');

const md = await (await fetch(README)).text();
const unescape = (s) => s.replace(/\\([_()[\]])/g, '$1').trim();
const rows = md.split('\n')
  .filter((l) => /^\|.*\/copc\s*\|/.test(l))
  .map((l) => l.split('|').slice(1, -1).map(unescape));

const entries = [];
for (const [country, epsg, dataPath, start, end, density, licence] of rows) {
  const base = dataPath.replace(/\/copc\/?$/, '');
  // "data/FR/IGN/Lidar_2021" → agency "IGN", series "Lidar 2021"
  const [, cc, agency, series] = base.split('/');
  const url = `${BUCKET}/${base}/overview/overview.copc.laz`;
  if (CHECK) {
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok) { console.warn(`  skip ${base}: overview ${r.status}`); continue; }
  }
  entries.push({
    format: 'copc',
    url,
    crs: `EPSG:${epsg}`,
    name: `${country} — ${agency} ${series.replace(/_/g, ' ')}`,
    project: `${agency} (${cc})`,
    scene: country,
    // an ISO 8601 interval: these are multi-year national campaigns, not single captures
    date: start && end ? `${start}/${end}` : start || null,
    density: Number(density) || null,
    licence: licence.replace(/<br\/?>/g, ' '),
    // the agency is the data's author; flai is who mirrored it as COPC
    provider: agency,
    attribution: `${licence.split(/[,[]/)[0].trim()} — via flai open LiDAR`,
  });
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({
  label: `flai open LiDAR — ${entries.length} national COPC overviews`,
  provider: 'flai open LiDAR',
  attribution: 'National mapping agencies, mirrored by flai (github.com/flai-ai/open-lidar-data)',
  source: 'https://github.com/flai-ai/open-lidar-data',
  generatedAt: new Date().toISOString(),
  entries,
}, null, 2) + '\n');
console.log(`${rows.length} catalogue rows → ${entries.length} entries → ${path.relative(process.cwd(), OUT)}`);

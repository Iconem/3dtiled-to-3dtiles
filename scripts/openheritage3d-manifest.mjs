#!/usr/bin/env node
/**
 * Build packages/tile-server/aggregate-sets/openheritage3d.json from Open Heritage 3D itself.
 *
 * openheritage3d.org lists ~460 projects (DOIs 10.26301/xxxx-xxxx). Each one has a Potree viewer at
 * pointcloud.ucsd.edu/…/oh3d-vis/datasets/<doi>/potree/config.js that names every point cloud it
 * loads (`Potree.loadPointCloud("<metadata.json or cloud.js>", "<label>", …)`), a small JSON API for
 * the title / country / licence, and a project page whose map carries the site's coordinates (the
 * scans themselves are in local frames — the mosaic places each cloud at those coordinates through
 * /stream's &lon=&lat=).
 *
 *   node scripts/openheritage3d-manifest.mjs            # rewrite the manifest (≈ 460 × 3 requests)
 *   node scripts/openheritage3d-manifest.mjs --limit 20 # a quick sample
 *
 * Hand-set fields of the previous manifest (alt, a corrected lon/lat) survive for entries whose URL is
 * unchanged. Projects without a Potree config or without coordinates are listed in the summary.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../packages/tile-server/aggregate-sets/openheritage3d.json', import.meta.url));
const SITE = 'https://openheritage3d.org';
const VIS = 'https://pointcloud.ucsd.edu/archive_temp/oh3d_store/oh3d-vis';
const limit = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? +process.argv[i + 1] : Infinity; })();
const CONCURRENCY = 6;

const ISO3 = {
  Afghanistan: 'AFG', Argentina: 'ARG', Armenia: 'ARM', Australia: 'AUS', Austria: 'AUT', Bangladesh: 'BGD', Belgium: 'BEL',
  Bolivia: 'BOL', Brazil: 'BRA', Cambodia: 'KHM', Canada: 'CAN', Chile: 'CHL', China: 'CHN', Colombia: 'COL', Croatia: 'HRV',
  Cyprus: 'CYP', 'Czech Republic': 'CZE', Czechia: 'CZE', Denmark: 'DNK', Ecuador: 'ECU', Egypt: 'EGY', England: 'GBR',
  Ethiopia: 'ETH', France: 'FRA', Georgia: 'GEO', Germany: 'DEU', Greece: 'GRC', Guatemala: 'GTM', Honduras: 'HND',
  Hungary: 'HUN', India: 'IND', Indonesia: 'IDN', Iran: 'IRN', Iraq: 'IRQ', Ireland: 'IRL', Israel: 'ISR', Italy: 'ITA',
  Japan: 'JPN', Jordan: 'JOR', Kenya: 'KEN', Lebanon: 'LBN', Malaysia: 'MYS', Maldives: 'MDV', Mali: 'MLI', Mexico: 'MEX',
  Mongolia: 'MNG', Morocco: 'MAR', Myanmar: 'MMR', Nepal: 'NPL', Netherlands: 'NLD', 'New Zealand': 'NZL', Nigeria: 'NGA',
  Norway: 'NOR', Pakistan: 'PAK', Peru: 'PER', Philippines: 'PHL', Poland: 'POL', Portugal: 'PRT', Romania: 'ROU',
  Russia: 'RUS', 'Russian Federation': 'RUS', 'San Marino': 'SMR', 'Saudi Arabia': 'SAU', Scotland: 'GBR', Senegal: 'SEN',
  Serbia: 'SRB', Slovakia: 'SVK', Slovenia: 'SVN', 'South Africa': 'ZAF', 'South Korea': 'KOR', Spain: 'ESP', 'Sri Lanka': 'LKA',
  Sudan: 'SDN', Sweden: 'SWE', Switzerland: 'CHE', Syria: 'SYR', Tanzania: 'TZA', Thailand: 'THA', Tunisia: 'TUN', Turkey: 'TUR',
  Türkiye: 'TUR', Turkmenistan: 'TKM', Uganda: 'UGA', Ukraine: 'UKR', 'United Arab Emirates': 'ARE', 'United Kingdom': 'GBR',
  'United States': 'USA', 'United States of America': 'USA', USA: 'USA', Uzbekistan: 'UZB', Vietnam: 'VNM', Wales: 'GBR',
  Yemen: 'YEM', Zimbabwe: 'ZWE',
  'Myanmar (formerly Burma)': 'MMR', 'Cabo Verde': 'CPV', 'Antarctica': 'ATA', 'Somaliland': 'SOM', 'Taiwan': 'TWN', 'Panama': 'PAN', 'North Macedonia': 'MKD',
};

async function text(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const json = async (url) => JSON.parse(await text(url));

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } }));
  return out;
}

const page = await text(`${SITE}/data`);
const dois = [...new Set([...page.matchAll(/10\.26301\/([a-z0-9]{4}-[a-z0-9]{4})/g)].map((m) => m[1]))].slice(0, limit);
console.log(`${dois.length} projects`);

let previous = { entries: [] };
try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
const prevByUrl = new Map(previous.entries.map((e) => [e.url, e]));

const noConfig = [], noData = [], noCoords = [], failed = [];
const results = await mapLimit(dois, CONCURRENCY, async (doi, k) => {
  try {
    const [config, title, cite, project] = await Promise.all([
      text(`${VIS}/datasets/${doi}/potree/config.js`).catch(() => null),
      json(`${SITE}/api/project_title.php?doi=${doi}`).catch(() => ({})),
      json(`${SITE}/api/project_citation.php?doi=${doi}`).catch(() => ({})),
      text(`${SITE}/project.php?id=${doi}`).catch(() => ''),
    ]);
    if (!config) { noConfig.push(doi); return []; }
    const configUrl = `${VIS}/datasets/${doi}/potree/config.js`;
    // relative paths in a config resolve against it; a config may name a cloud that was never uploaded
    // (its metadata.json 404s), so each one is probed and the missing ones dropped
    const named = [...config.matchAll(/Potree\.loadPointCloud\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']/g)]
      .map((m) => ({ url: new URL(m[1].replace(/^pointcloud\.ucsd\.edu/, 'https://pointcloud.ucsd.edu'), configUrl).href, label: m[2].trim() }));
    const clouds = (await Promise.all(named.map(async (c) => {
      try { const r = await fetch(c.url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) }); return r.ok ? c : null; } catch { return null; }
    }))).filter(Boolean);
    if (named.length && !clouds.length) { noData.push(doi); return []; }
    if (!clouds.length) { noConfig.push(doi); return []; }
    // the project page's map: a polygon and/or a marker — the mean of every point is the site
    const lats = [...project.matchAll(/lat:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => +m[1]);
    const lngs = [...project.matchAll(/lng:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => +m[1]);
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const lat = mean(lats), lon = mean(lngs);
    if (lat == null || lon == null) noCoords.push(doi);
    const name = title.title || doi;
    const country = title.country || null;
    const dates = /dateCreated' content='(\d{4}-\d\d-\d\d)'/.exec(project);
    const licence = cite.license_type ? `${cite.license_type}${cite.license_link ? ` — ${cite.license_link}` : ''}` : null;
    if ((k + 1) % 25 === 0) console.log(`  ${k + 1}/${dois.length}`);
    return clouds.map((c) => {
      const prev = prevByUrl.get(c.url);
      const e = {
        format: 'potree',
        name: clouds.length > 1 && c.label ? `${name} — ${c.label}` : name,
        project: 'Open Heritage 3D',
        scene: country ? `${name}, ${country}` : name,
        ...(country && ISO3[country] ? { country: ISO3[country] } : {}),
        ...(dates ? { date: dates[1] } : {}),
        ...(licence ? { licence } : {}),
        doi: `10.26301/${doi}`,
        ...(lon != null && lat != null ? { lon: +lon.toFixed(6), lat: +lat.toFixed(6) } : {}),
        url: c.url,
      };
      // keep a hand-placed position / altitude from the previous manifest
      if (prev) { if (prev.alt != null) e.alt = prev.alt; if (prev.lon != null && prev.lat != null && prev.handPlaced) { e.lon = prev.lon; e.lat = prev.lat; e.handPlaced = true; } }
      return e;
    });
  } catch (err) { failed.push(`${doi}: ${err.message}`); return []; }
});

const entries = results.flat();
const manifest = {
  label: `Open Heritage 3D — terrestrial LiDAR and photogrammetry of heritage sites, ${entries.length} point clouds from ${dois.length - noConfig.length - noData.length} projects (Potree, via /stream)`,
  provider: 'Open Heritage 3D',
  attribution: '© CyArk / Open Heritage 3D and partners',
  source: `${SITE}/data — every project's Potree config.js (${VIS}/datasets/<doi>/potree/config.js) names its point clouds; title, country and licence from ${SITE}/api/project_*.php; coordinates from the project page's map. Rebuilt by scripts/openheritage3d-manifest.mjs.`,
  note: 'Licences are per dataset (CC BY or CC BY-NC-SA 4.0, chosen by the contributor): carried on each entry. The scans are in local frames; each is placed at its project\'s map coordinates (lon/lat), so a cloud sits at the site, not necessarily aligned to the imagery.',
  built: new Date().toISOString().slice(0, 10),
  entries,
};
await writeFile(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${entries.length} entries from ${dois.length - noConfig.length - noData.length} projects → ${OUT}`);
if (noData.length) console.log(`config names clouds that do not exist (404): ${noData.length} (${noData.slice(0, 10).join(", ")}…)`);
if (noConfig.length) console.log(`no Potree config: ${noConfig.length} (${noConfig.slice(0, 10).join(', ')}…)`);
if (noCoords.length) console.log(`no coordinates: ${noCoords.length} (${noCoords.slice(0, 10).join(', ')}…)`);
if (failed.length) console.log(`failed: ${failed.length}\n  ${failed.slice(0, 10).join('\n  ')}`);

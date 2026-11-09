/**
 * vpc-to-manifest.mjs — a Virtual Point Cloud (.vpc) → an /aggregate set manifest, bounds baked in.
 *
 * What /stream/tileset.json?format=vpc does on every request, written to a file instead: a manifest
 * to keep under .local/aggregate-sets/ or packages/tile-server/aggregate-sets/ (it becomes ?set=<name>),
 * to POST to /aggregate/set, or to edit (names, licences, attribution) before either.
 *
 *   node scripts/vpc-to-manifest.mjs <file.vpc | https://….vpc> [--base <url the hrefs are relative to>]
 *        [--sniff auto|all|0] [--label "…"] [-o manifest.json]
 *
 * Only COPC items are kept; the rest are counted on stderr with the reason. A local .vpc with relative
 * hrefs needs --base: the tile-server reads its sources over HTTP.
 */
import fs from 'node:fs/promises';
import { parseVpc, sortAmbiguous, vpcToSet, sniffParam } from '../packages/tile-server/vpc-live.js';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const input = argv.find((a, i) => !a.startsWith('-') && !['--base', '--sniff', '--label', '-o'].includes(argv[i - 1]));
if (!input) { console.error('usage: node scripts/vpc-to-manifest.mjs <file.vpc | url> [--base <url>] [--sniff auto|all|0] [--label "…"] [-o manifest.json]'); process.exit(1); }

const remote = /^https?:\/\//i.test(input);
const doc = JSON.parse(remote ? await (await fetch(input)).text() : await fs.readFile(input, 'utf8'));
const parsed = parseVpc(doc, flag('--base') ?? (remote ? input : null));
const sorted = await sortAmbiguous(parsed.ambiguous, sniffParam(flag('--sniff')));
let out;
try { out = vpcToSet(parsed, sorted, { url: remote ? input : null, label: flag('--label') }); }
catch (e) { console.error(e.message); process.exit(2); }
const { set, report } = out;
const json = JSON.stringify({ label: set.label, source: remote ? input : undefined, generatedAt: new Date().toISOString(), entries: set.entries }, null, 2) + '\n';
if (flag('-o')) await fs.writeFile(flag('-o'), json); else process.stdout.write(json);
console.error(`${report.items} items → ${report.streamed} COPC entries, ${report.skipped} skipped`
  + (report.skipped ? ` (${Object.entries(report.skippedReasons).map(([k, n]) => `${n} ${k}`).join('; ')})` : '')
  + `; bounds from ${Object.entries(report.boundsFrom).map(([k, n]) => `${k}: ${n}`).join(', ')}`);
process.exit(0);

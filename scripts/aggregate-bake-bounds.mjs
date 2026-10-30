#!/usr/bin/env node
/**
 * aggregate-bake-bounds.mjs — write each manifest entry's placement into the manifest itself, so
 * /aggregate builds the mosaic (and index.json, i.e. the picker's circles) without fetching a single
 * child root.
 *
 *   node scripts/aggregate-bake-bounds.mjs .local/aggregate-sets/iconem.json
 *     [--server=http://localhost:3001]   a running tile server: /stream wraps the Potree/COPC entries
 *     [--fresh]                          re-probe every entry (default: reuse baked bounds and the
 *                                        server's persisted child-root cache, .local/aggregate-cache/)
 *     [--dry-run]                        report, write nothing
 *
 * Each entry gains `bounds: { sphere: [x, y, z, r], geometricError, native? }` — exactly what the
 * server would derive from the child's root (ECEF sphere in the mosaic frame, the reference tile's GE,
 * the &native=1 source descriptor). A request with &ttl=0 or &curved= ignores baked bounds and probes.
 * Re-run after re-georeferencing or re-tiling a dataset; entries that fail to probe keep no bounds and
 * are probed by the server as before.
 *
 * `--server` must be the origin the server is reached at when it builds mosaics (the persisted cache is
 * keyed by the child URLs, which embed it). Share links stay where they already were: in the git-ignored
 * local manifest.
 */
import fs from 'node:fs/promises';
import { probeEntryBounds } from '../packages/tile-server/aggregate-live.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const fresh = argv.includes('--fresh'), dry = argv.includes('--dry-run');
const server = opt('server', 'http://localhost:3001').replace(/\/$/, '');
if (!file) { console.error('usage: aggregate-bake-bounds.mjs <manifest.json> [--server=…] [--fresh] [--dry-run]'); process.exit(2); }

const original = await fs.readFile(file, 'utf8');
const manifest = JSON.parse(original);
// Keep the file's layout so a bake is a small diff: one-line-per-entry manifests stay one line per
// entry, and number arrays (spheres, transforms) stay on one line in pretty-printed ones.
const oneLinePerEntry = /\n\s*\{ ?"/.test(original);
// `{ "k": v, "a": [1, 2] }` — the spacing the hand-written one-line manifests use
const inline = (v) => Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
  : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
  : JSON.stringify(v);
const endsWithNewline = original.endsWith('\n');
const collapseNumberArrays = (txt) => txt.replace(/\[\s*(-?[\d.eE+-]+(?:,\s*-?[\d.eE+-]+)*)\s*\]/g, (_, body) => `[${body.split(/,\s*/).join(', ')}]`);
const serialise = (m) => {
  let txt;
  if (!oneLinePerEntry) txt = collapseNumberArrays(JSON.stringify(m, null, 2));
  else {
    const { entries: list, ...head } = m;
    const headTxt = JSON.stringify(head, null, 2).replace(/\n}$/, '');
    txt = `${headTxt},\n  "entries": [\n${list.map((e) => '    ' + inline(e)).join(',\n')}\n  ]\n}`;
  }
  return endsWithNewline ? txt + '\n' : txt;
};
const entries = manifest.entries || [];
const round = (v, d) => +v.toFixed(d);
let baked = 0, kept = 0, failed = 0, unplaced = 0, done = 0;
const t0 = performance.now();

const CONCURRENCY = 8;
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < entries.length) {
    const e = entries[next++];
    if (!fresh && e.bounds?.sphere) { kept++; continue; }
    try {
      const info = await probeEntryBounds(e, server, { fresh });
      const [x, y, z, r] = info.sphere;
      e.bounds = { sphere: [round(x, 3), round(y, 3), round(z, 3), round(r, 3)], geometricError: round(info.geometricError, 3),
        ...(info.native ? { native: info.native } : {}) };
      if (Math.hypot(x, y, z) < 1e6) unplaced++;
      baked++;
    } catch (err) {
      failed++;
      delete e.bounds;
      console.warn(`  failed  ${e.name ?? e.label ?? ''}: ${String(err.message).slice(0, 120)}`);
    }
    if (++done % 50 === 0) console.log(`  ${done}/${entries.length - kept}`);
  }
}));

manifest.boundsBakedAt = new Date().toISOString();
if (!dry) await fs.writeFile(file, serialise(manifest));
console.log(`${entries.length} entries · baked ${baked} · kept ${kept} · failed ${failed} · without georeference ${unplaced}`
  + ` · ${((performance.now() - t0) / 1000).toFixed(1)} s${dry ? ' (dry run, nothing written)' : ` → ${file}`}`);
// the persisted cache writes on a 2 s debounce; let it flush, then exit (keep-alive sockets would hold us)
setTimeout(() => process.exit(failed && !baked ? 1 : 0), 2500);

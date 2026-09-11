/**
 * debug-aggregate-nesting.mjs — reproducible test for /aggregate's spatial auto-nesting.
 *
 * Serves a set of SYNTHETIC child tilesets from a throwaway localhost server, each a single root tile
 * with a bounding sphere at a real-world lon/lat and a realistic radius, then builds the mosaic under
 * each nesting scheme and prints the tree it produced. No remote hosts, so the result is stable and
 * the assertions below actually mean something in CI.
 *
 * What it checks:
 *   1. flat      — every dataset is a direct child of the root (the pre-nesting behaviour).
 *   2. mercator  — web-mercator/Bing-quadkey grouping: root fanout collapses, depth grows, and the
 *                  Paris datasets share an ancestor that the Rome datasets do not.
 *   3. geodetic  — same, under 3D Tiles implicit tiling's own lon/lat subdivision.
 *   4. Scale-awareness: a country-sized dataset must NOT be buried inside a city-sized cell.
 *   5. Monotonic geometric error — a parent's GE must exceed every child's, or clients mis-refine.
 *
 * Run: node scripts/debug-aggregate-nesting.mjs
 */
import http from 'node:http';
import { buildAggregate } from '../packages/tile-server/aggregate-live.js';
import { llhToEcef } from '../packages/core/index.js';

// name, lon, lat, radius(m) — radius is what decides how deep a dataset is allowed to nest
const DATASETS = [
  ['eiffel',      2.2945, 48.8584,   150],
  ['louvre',      2.3376, 48.8606,   200],
  ['sacre-coeur', 2.3431, 48.8867,   120],
  ['versailles',  2.1204, 48.8049,   400],
  ['san-pietro', 12.4534, 41.9022,   180],
  ['colosseum',  12.4922, 41.8902,   160],
  ['angkor-1',  103.8670, 13.4125,   250],
  ['angkor-2',  103.8730, 13.4180,   250],
  ['angkor-3',  103.8590, 13.4090,   250],
  ['geghard',    44.8181, 40.1408,   200],
  ['nyc',       -74.0060, 40.7128,   300],
  ['sydney',    151.2093,-33.8688,   300],
  ['reykjavik', -21.8277, 64.1265,   300],
  // deliberately country-scale: must stay shallow, never buried under a city cell
  ['france-wide', 2.4000, 46.6000, 400000],
];

const tilesetFor = ([, lon, lat, r]) => {
  const [x, y, z] = llhToEcef(lon, lat, 0);
  return { asset: { version: '1.1' }, geometricError: r, root: { boundingVolume: { sphere: [x, y, z, r] }, geometricError: r, refine: 'ADD', content: { uri: 'x.glb' } } };
};

const server = http.createServer((req, res) => {
  const name = req.url.replace(/^\/|\.json$/g, '');
  const d = DATASETS.find((e) => e[0] === name);
  if (!d) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(tilesetFor(d)));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const urls = DATASETS.map(([n]) => `${base}/${n}.json`);

/** Walk the produced tileset, returning [{ depth, path, label }] in reading order. */
function outline(tile, depth = 0, out = []) {
  const cell = tile.extras?.cell;
  const label = tile.content
    ? `• ${decodeURIComponent(tile.content.uri).split('/').pop().replace('.json', '')}`
        + (cell ? `   [${cell.scheme} key=${cell.key} morton=${cell.morton}]` : '')
    : `[group ${cell ? `key=${cell.key} L${cell.level}` : ''} r=${Math.round(tile.boundingVolume.sphere[3] / 1000)}km ge=${Math.round(tile.geometricError)}]`;
  out.push({ depth, label });
  for (const c of tile.children || []) outline(c, depth + 1, out);
  return out;
}

/** Ancestor path (indices) of the group chain leading to a given dataset name. */
function pathTo(tile, name, acc = []) {
  if (tile.content && decodeURIComponent(tile.content.uri).includes(`/${name}.json`)) return acc;
  for (let i = 0; i < (tile.children || []).length; i++) {
    const hit = pathTo(tile.children[i], name, [...acc, i]);
    if (hit) return hit;
  }
  return null;
}

const depthOf = (t, d = 0) => (t.children || []).reduce((a, c) => Math.max(a, depthOf(c, d + 1)), d);

/** 3D Tiles requires geometric error to decrease on refine. Violations mis-refine in every client. */
function geMonotonic(tile) {
  for (const c of tile.children || []) {
    if (!(tile.geometricError > c.geometricError)) return `parent ge ${tile.geometricError} !> child ge ${c.geometricError}`;
    const deeper = geMonotonic(c);
    if (deeper) return deeper;
  }
  return null;
}

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

for (const nest of ['flat', 'mercator', 'geodetic']) {
  // ttl 0 so each scheme re-derives instead of reading the previous run's cached mosaic
  const ts = await buildAggregate(urls, { nest, ttlMs: 0 });
  const info = ts.asset.extras.nesting;
  console.log(`\n=== nest=${nest} → ${JSON.stringify(info)}`);
  for (const { depth, label } of outline(ts.root)) console.log('   ' + '  '.repeat(depth) + label);

  console.log(`  checks:`);
  check('geometric error decreases on refine', geMonotonic(ts.root) === null, geMonotonic(ts.root) || '');

  if (nest === 'flat') {
    check('flat root holds every dataset', ts.root.children.length === DATASETS.length,
          `fanout ${ts.root.children.length}/${DATASETS.length}`);
    check('depth is 1', depthOf(ts.root) === 1);
  } else {
    check('root fanout collapsed below dataset count', ts.root.children.length < DATASETS.length,
          `fanout ${ts.root.children.length} < ${DATASETS.length}`);
    check('tree got deeper than flat', depthOf(ts.root) > 1, `depth ${depthOf(ts.root)}`);

    // Paris datasets must share a deeper ancestor than they share with Rome.
    const eiffel = pathTo(ts.root, 'eiffel'), louvre = pathTo(ts.root, 'louvre'), pietro = pathTo(ts.root, 'san-pietro');
    const shared = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
    check('Paris datasets group together, apart from Rome',
          shared(eiffel, louvre) > shared(eiffel, pietro),
          `eiffel∧louvre=${shared(eiffel, louvre)} vs eiffel∧sanpietro=${shared(eiffel, pietro)}`);

    // A 400 km dataset must not be pushed into a cell sized for a 150 m one.
    const france = pathTo(ts.root, 'france-wide');
    check('country-scale dataset stays shallow', france.length < eiffel.length,
          `france depth ${france.length} < eiffel depth ${eiffel.length}`);
  }
}

// ── scale: does this hold up at "every Iconem dataset in one endpoint" size? ──────────────────────
//
// The question that matters for a middleware is not whether the tree is correct but whether the COLD
// build (one tileset.json round-trip per child) is affordable and whether the cache actually removes
// it. 500 synthetic children, scattered over the globe in clusters, is the realistic upper bound.
const N = 500;
const scaleUrls = [];
for (let i = 0; i < N; i++) {
  // 25 clusters of 20, so the tree has something real to group — not uniform noise
  const c = i % 25, lon = -170 + (c * 13.7) % 340, lat = -55 + (c * 29.3) % 110;
  const name = `scale-${i}`;
  DATASETS.push([name, lon + ((i * 0.013) % 0.4), lat + ((i * 0.011) % 0.3), 150 + (i % 7) * 40]);
  scaleUrls.push(`${base}/${name}.json`);
}

console.log(`\n=== scale: ${N} datasets`);
const timed = async (fn) => { const t = performance.now(); const v = await fn(); return [v, performance.now() - t]; };

// The COLD cost is measurable exactly once per process: after any run with a live TTL, the child
// roots stay in memory. Measure it before the per-scheme loop, and report the two costs separately
// rather than calling a second scheme's run "cold" when its children are already cached.
// ttlMs:0 neither reads nor writes the cache, so this is the genuine 500-fetch path.
const [, coldMs] = await timed(() => buildAggregate(scaleUrls, { nest: 'mercator', ttlMs: 0 }));
console.log(`  cold build (500 child tileset.json fetches, loopback): ${coldMs.toFixed(0)} ms`);

for (const nest of ['mercator', 'geodetic']) {
  await buildAggregate(scaleUrls, { nest, ttlMs: 60_000 });                  // prime the child cache
  // With children cached this isolates the TREE BUILD itself — the part that would run on every
  // request if the assembled mosaic were not cached too.
  const [cold, buildMs] = await timed(() => buildAggregate(scaleUrls, { nest, ttlMs: 60_000 }));
  const n = cold.asset.extras.nesting;
  console.log(`  ${nest.padEnd(9)} tree build ${buildMs.toFixed(1)} ms `
    + `· rootFanout ${n.rootFanout} · depth ${n.depth} · groups ${n.groups}`);

  // The mosaic must not depend on cache state. Child roots are cached by reference, and the group
  // spheres are derived from those same arrays — so a stray mutation anywhere in the build would
  // make a warm mosaic differ from a cold one. Compare the two structurally.
  const uncached = await buildAggregate(scaleUrls, { nest, ttlMs: 0 });
  check(`${nest}: cached and uncached builds agree`,
        JSON.stringify(uncached.root) === JSON.stringify(cold.root), 'tree differs with cache state');
  check(`${nest}: root fanout stays small at ${N} datasets`, n.rootFanout <= 16, `fanout ${n.rootFanout}`);
  check(`${nest}: geometric error decreases on refine`, geMonotonic(cold.root) === null);
}

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

/**
 * Self-checks for the builder's pure core (tree ops, geo, export/import). No test runner in this app,
 * so it is a plain script:
 *
 *   node --experimental-strip-types apps/viewer/src/builder/selftest.ts
 *
 * Exits non-zero on the first failed check.
 */
import { ecefToLlh, llhToEcef, unionSphere, type Sphere } from './geo.ts';
import {
  addGroup, canMove, counts, createTree, docOrder, duplicateNode, groupChildrenBy, groupNodes, insertRows,
  moveNodes, removeNodes, shownChildren, updateNode, updateNodes, type GroupNode, type Row, type Tree,
} from './tree.ts';
import { fromProject, fromTileset, leafSphere, propertyKey, toManifest, toProject, toTileset, unwrapChildUrl } from './export.ts';

// `process` without @types/node: this file is type-checked with the browser app.
const proc = (globalThis as any).process;
let passed = 0;
function check(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL ${msg}`); proc.exit(1); }
  passed++;
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const kids = (t: Tree, id: string) => (t.nodes[id] as GroupNode).children;
const names = (t: Tree, id: string) => kids(t, id).map((c) => t.nodes[c].name);

// ── geo ──
{
  const [x, y, z] = llhToEcef(0, 0, 0);
  check(near(x, 6378137, 1e-6) && near(y, 0, 1e-6) && near(z, 0, 1e-6), 'equator/greenwich ECEF');
  const pole = llhToEcef(0, 90, 0);
  check(near(pole[2], 6356752.314, 1e-3), 'north pole ECEF z = semi-minor axis');
  const p = llhToEcef(103.859, 13.4412, 52.2);
  const back = ecefToLlh(...p);
  check(near(back[0], 103.859, 1e-9) && near(back[1], 13.4412, 1e-9) && near(back[2], 52.2, 1e-3), 'llh → ecef → llh round-trip');
  const a: Sphere = [0, 0, 0, 1], b: Sphere = [10, 0, 0, 1];
  const u = unionSphere(a, b);
  check(near(u[0], 5, 1e-9) && near(u[3], 6, 1e-9), 'union of two disjoint spheres');
  check(unionSphere(u, [5, 0, 0, 1]) === u, 'union with a contained sphere is unchanged');
}

// ── tree ops ──
const row = (i: number, extra: Partial<Row> = {}): Row => ({
  id: `r${i}`, name: `site ${i}`, format: '3dtiles', url: `https://example.org/${i}/tileset.json`,
  lon: 103.8 + i * 0.01, lat: 13.4, height: 50, radius: 100 + i, ...extra,
});
let t = createTree('Test');
const R = t.rootId;
let r1 = insertRows(t, R, undefined, [row(1, { scene: 'Bayon', date: '2019' }), row(2, { scene: 'Bayon', date: '2022-05' }), row(3, { scene: 'Kulen' })]);
t = r1.tree;
const [d1, d2, d3] = r1.ids;
check(names(t, R).join() === 'site 1,site 2,site 3', 'insert at end keeps order');
const gA = addGroup(t, R, 0, 'A');
t = gA.tree;
check(kids(t, R)[0] === gA.id, 'new group at index 0');
t = moveNodes(t, [d3, d1], gA.id);
check(names(t, gA.id).join() === 'site 1,site 3', 'move keeps document order');
check(names(t, R).join() === 'A,site 2', 'moved nodes left the root');
// Reorder within one parent: moving site 1 to after site 3 (index 2 in the current list).
t = moveNodes(t, [d1], gA.id, 2);
check(names(t, gA.id).join() === 'site 3,site 1', 'same-parent move accounts for its own removal');
const gB = addGroup(t, gA.id, undefined, 'B');
t = gB.tree;
check(!canMove(t, [gA.id], gB.id), 'cannot move a group into its own descendant');
check(moveNodes(t, [gA.id], gB.id) === t, 'forbidden move is a no-op');
check(!canMove(t, [R], gA.id), 'cannot move the root');
const dup = duplicateNode(t, gA.id);
t = dup.tree;
check(names(t, R).join() === 'A,A (copy),site 2', 'duplicate lands right after the original');
check(docOrder(t, dup.id).length === docOrder(t, gA.id).length && !docOrder(t, dup.id).some((id) => docOrder(t, gA.id).includes(id)), 'duplicate is a deep copy with fresh ids');
t = removeNodes(t, [dup.id]);
check(names(t, R).join() === 'A,site 2' && counts(t).datasets === 3, 'remove deletes the whole subtree');
const grouped = groupNodes(t, [d2, d1]);
t = grouped.tree;
check(kids(t, grouped.id).length === 2, 'group selection wraps both nodes');
check(names(t, R).join() === 'A', 'group selection sits where the first selected node was (inside A → root keeps A only)');
check(kids(t, gA.id).includes(grouped.id), 'selection group is created in the first node\'s parent');

// ── group-by and display modes ──
{
  let g = createTree('G');
  g = insertRows(g, g.rootId, undefined, [
    row(1, { scene: 'Bayon', date: '2019' }), row(2, { scene: 'Bayon', date: '2022-05' }), row(3, { scene: 'Kulen', date: '2020/2021' }), row(4),
  ]).tree;
  const byYear = groupChildrenBy(g, g.rootId, 'year');
  check(names(byYear, byYear.rootId).join() === '2019,2022,2020,site 4', 'group by year: one group per year, undated stay');
  const byScene = groupChildrenBy(g, g.rootId, 'scene');
  check(names(byScene, byScene.rootId).join() === 'Bayon,Kulen,site 4', 'group by scene');
  const again = groupChildrenBy(insertRows(byScene, byScene.rootId, undefined, [row(5, { scene: 'Bayon' })]).tree, byScene.rootId, 'scene');
  const bayon = kids(again, again.rootId).find((c) => again.nodes[c].name === 'Bayon')!;
  check(kids(again, bayon).length === 3 && names(again, again.rootId).join() === 'Bayon,Kulen,site 4', 'group by scene reuses existing groups');
  const latest = updateNode<GroupNode>(g, g.rootId, { mode: 'latest' });
  check(shownChildren(latest, latest.nodes[latest.rootId] as GroupNode).map((c) => latest.nodes[c].name).join() === 'site 2', 'latest keeps the newest dated child');
  const first = updateNode<GroupNode>(g, g.rootId, { mode: 'first' });
  check(shownChildren(first, first.nodes[first.rootId] as GroupNode).length === 1, 'first keeps one child');
}

// ── export ──
{
  const ts = toTileset(t, { now: new Date(0) });
  check(ts.asset.version === '1.1' && ts.asset.extras.builder.exported.datasets === 3, 'export counts');
  const leafGEs: number[] = [];
  const walk = (tile: any, parentGE: number, parentSphere: Sphere | null) => {
    check(tile.geometricError < parentGE, `GE decreases on refine (${tile.geometricError} < ${parentGE})`);
    const s = tile.boundingVolume.sphere as Sphere;
    if (parentSphere) {
      const d = Math.hypot(s[0] - parentSphere[0], s[1] - parentSphere[1], s[2] - parentSphere[2]);
      check(d + s[3] <= parentSphere[3] * (1 + 1e-9) + 1e-6, 'child sphere inside parent sphere');
    }
    check(tile.metadata && ['dataset', 'group'].includes(tile.metadata.class), 'every tile has metadata');
    if (tile.content) leafGEs.push(tile.geometricError);
    else check(tile.geometricError === 2 * Math.max(...tile.children.map((c: any) => c.geometricError)), 'group GE = 2 × max child GE');
    for (const c of tile.children ?? []) walk(c, tile.geometricError, s);
  };
  walk(ts.root, ts.geometricError + 1e-9, null);
  check(leafGEs.length === 3 && leafGEs.every((g) => g >= 100), 'leaf GE = radius');
  const s1 = leafSphere(t.nodes[d1] as any);
  check(near(ecefToLlh(s1[0], s1[1], s1[2])[0], 103.81, 1e-9), 'leaf sphere centred on its lon');
  // Custom metadata: sanitised keys, declared in the schema.
  const t2 = updateNode(t, d1, { kv: [{ key: 'capture team', value: 'Iconem' }, { key: 'name', value: 'x' }] });
  const ts2 = toTileset(t2);
  check(ts2.schema.classes.dataset.properties.capture_team?.type === 'STRING', 'custom key in schema, sanitised');
  check(ts2.schema.classes.dataset.properties.x_name, 'custom key never shadows a built-in');
  check(propertyKey('2nd survey', []) === '_2nd_survey', 'leading digit escaped');
  // Earth-centred root for a planet-wide mosaic.
  let w = createTree('World');
  w = insertRows(w, w.rootId, undefined, [row(1, { lon: 0, lat: 0 }), row(2, { lon: 120, lat: 0 }), row(3, { lon: -120, lat: 0 })]).tree;
  const wts = toTileset(w);
  check(wts.root.boundingVolume.sphere[0] === 0 && near(wts.root.boundingVolume.sphere[3], 6378137 + 50 + 103.5, 1), 'Earth-centred root when tighter');
  // Latest mode drops superseded captures from the export and the manifest.
  let l = createTree('L');
  l = insertRows(l, l.rootId, undefined, [row(1, { date: '2010' }), row(2, { date: '2022' })]).tree;
  l = updateNode<GroupNode>(l, l.rootId, { mode: 'latest' });
  check(toTileset(l).root.children.length === 1 && toManifest(l).entries.length === 1, 'latest mode applied to exports');
  let empty = false;
  try { toTileset(createTree()); } catch { empty = true; }
  check(empty, 'empty tree refuses to export');
}

// ── manifest ──
{
  const u = unwrapChildUrl('http://localhost:3001/stream/tileset.json?format=potree&url=https%3A%2F%2Fh%2Fcloud.js&cache=none');
  check(u.url === 'https://h/cloud.js' && u.format === 'potree', 'unwrap /stream');
  check(unwrapChildUrl('http://localhost:3001/proxy?url=https%3A%2F%2Fh%2Ft.json').proxy === true, 'unwrap /proxy');
  const keep = 'http://localhost:3001/stream/tileset.json?format=lcc&url=x&lon=2&lat=48';
  check(unwrapChildUrl(keep).url === keep, 'placed /stream URLs are kept whole');
  const m = toManifest(t);
  check(m.entries.length === 3 && m.entries.every((e) => e.group?.startsWith('A')), 'manifest entries carry their group path');
}

// ── import round-trip ──
{
  const t3 = updateNode(updateNode(t, d1, { ge: 42, notes: 'n', kv: [{ key: 'team', value: 'x' }] }), gA.id, { date: '2020', mode: 'all', refine: 'REPLACE' });
  const exported = toTileset(t3);
  const back = fromTileset(JSON.parse(JSON.stringify(exported)));
  // Empty group B is not exported (it bounds nothing), so compare with what the file holds.
  check(counts(back).datasets === 3 && counts(back).groups === exported.asset.extras.builder.exported.groups && counts(t3).groups === counts(back).groups + 1, 'round-trip keeps node counts');
  const a = Object.values(back.nodes).find((n) => n.name === 'A') as GroupNode;
  check(a?.date === '2020' && a.refine === 'REPLACE', 'round-trip keeps group date + refine');
  const leaf = Object.values(back.nodes).find((n) => n.name === 'site 1') as any;
  check(leaf.ge === 42 && leaf.notes === 'n' && leaf.kv[0]?.key === 'team' && near(leaf.radius, 101, 1e-6) && near(leaf.lon, 103.81, 1e-7), 'round-trip keeps leaf fields');
  // Server-style quadtree cells (no metadata) are flattened on request.
  const serverTs = { asset: { version: '1.1' }, geometricError: 1, root: { boundingVolume: { sphere: [0, 0, 0, 7e6] }, geometricError: 1, children: [
    { boundingVolume: { sphere: [...llhToEcef(1, 1, 0), 10] }, geometricError: 1, extras: { cell: { key: '0' } }, children: [
      { boundingVolume: { sphere: [...llhToEcef(1, 1, 0), 10] }, geometricError: 1, content: { uri: 'a/tileset.json' }, metadata: { class: 'dataset', properties: { name: 'A1' } } },
      { boundingVolume: { region: [0, 0, 0.1, 0.1, 0, 10] }, geometricError: 1, content: { uri: 'b/tileset.json' } },
    ] },
  ] } };
  const flat = fromTileset(serverTs, 'https://srv/x/tileset.json', { flatten: true });
  check(names(flat, flat.rootId).join() === 'A1,b', 'server cells flattened, names from metadata or URL');
  check((flat.nodes[kids(flat, flat.rootId)[1]] as any).url === 'https://srv/x/b/tileset.json', 'relative URIs resolved against the tileset');
  // By default a root whose only child is a plain cell absorbs it (a chain), which gives the same list.
  const kept = fromTileset(serverTs, 'https://srv/x/tileset.json');
  check(counts(kept).groups === 1 && names(kept, kept.rootId).join() === 'A1,b', 'root absorbs its single cell');
}

// ── hierarchical import of a server mosaic (3-level cell tree) ──
{
  const sph = (lon: number, lat: number, r = 10) => ({ sphere: [...llhToEcef(lon, lat, 0), r] });
  const cell = (key: string, level?: number) => ({ cell: { scheme: 'geodetic', key, ...(level != null ? { level } : {}) } });
  const leaf = (name: string, lon: number, lat: number, key: string, extra: Record<string, string> = {}) => ({
    boundingVolume: sph(lon, lat), geometricError: 10, refine: 'ADD', content: { uri: `${name}/tileset.json` }, extras: cell(key),
    metadata: { class: 'dataset', properties: { id: `id-${name}`, name, format: '3dtiles', provider: 'Iconem', attribution: '© Iconem', ...extra } },
  });
  const grp = (key: string, level: number, children: any[], refine = 'ADD') =>
    ({ boundingVolume: sph(1, 1, 1e4), geometricError: 100, refine, extras: cell(key, level), children });
  const ts = { asset: { version: '1.1' }, geometricError: 1000, root: grp('1', 1, [
    grp('10', 2, [
      leaf('L1', 1, 1, '1000', { scene: 'S1' }),
      grp('103', 3, [leaf('L2', 1.1, 1, '1030', { scene: 'S1' }), leaf('L3', 1.2, 1, '1031', { scene: 'S2' })], 'REPLACE'),
    ]),
    // A chain: 11 → 112 → (two leaves). 11 has no dataset and one child group, so it is collapsed.
    grp('11', 2, [grp('112', 4, [leaf('L4', 2, 2, '1120'), leaf('L5', 2.1, 2, '1121')])]),
    leaf('L6', 3, 3, '12'),
  ]) };
  const h = fromTileset(JSON.parse(JSON.stringify(ts)), 'https://srv/agg/tileset.json');
  check(counts(h).datasets === 6 && counts(h).groups === 4, `hierarchy: 6 datasets, root + 3 groups (got ${counts(h).groups})`);
  check(names(h, h.rootId).join() === 'cell 10 (L2, geodetic),cell 112 (L4, geodetic),L6', 'hierarchy: root children named from cells, chain collapsed');
  const g10 = kids(h, h.rootId)[0];
  check(names(h, g10).join() === 'L1,cell 103 (L3, geodetic)', 'hierarchy: datasets and sub-cells keep their order');
  const g103 = h.nodes[kids(h, g10)[1]] as GroupNode;
  check(g103.refine === 'REPLACE' && names(h, g103.id).join() === 'L2,L3', 'hierarchy: refine kept, leaves nested 3 levels deep');
  const l2 = h.nodes[g103.children[0]] as any;
  check(l2.provider === 'Iconem' && l2.attribution === '© Iconem' && l2.sourceId === 'id-L2' && l2.url === 'https://srv/agg/L2/tileset.json', 'hierarchy: leaves keep provider/attribution/id/url');
  // Exported and imported again, the groups come back with their names (now as metadata).
  const again = fromTileset(JSON.parse(JSON.stringify(toTileset(h))));
  check(counts(again).groups === 4 && counts(again).datasets === 6 && names(again, kids(again, again.rootId)[0]).join() === 'L1,cell 103 (L3, geodetic)', 'hierarchy: builder round-trip keeps the groups');
  // A named group over a single unnamed cell adopts the cell's children.
  const named = { asset: { version: '1.1' }, geometricError: 1, root: { boundingVolume: sph(1, 1, 1e4), geometricError: 1, children: [
    { boundingVolume: sph(1, 1, 1e4), geometricError: 1, metadata: { class: 'group', properties: { name: 'Site' } }, children: [grp('7', 3, [leaf('A', 1, 1, '70'), leaf('B', 1, 1, '71')])] },
    leaf('C', 1, 1, '8'),
  ] } };
  const n2 = fromTileset(named);
  check(names(n2, n2.rootId).join() === 'Site,C' && names(n2, kids(n2, n2.rootId)[0]).join() === 'A,B', 'named group absorbs its single unnamed cell');
  // Flatten keeps the old flat list; groupBy buckets every group's datasets.
  const f = fromTileset(ts, undefined, { flatten: true });
  check(names(f, f.rootId).join() === 'L1,L2,L3,L4,L5,L6', 'flatten: one flat list');
  const fs = fromTileset(ts, undefined, { flatten: true, groupBy: 'scene' });
  check(names(fs, fs.rootId).join() === 'S1,S2,L4,L5,L6' && names(fs, kids(fs, fs.rootId)[0]).join() === 'L1,L2', 'flatten + group by scene');
  const hs = fromTileset(ts, undefined, { groupBy: 'provider' });
  check(counts(hs).datasets === 6 && names(hs, kids(hs, hs.rootId)[0]).join() === 'Iconem,cell 103 (L3, geodetic)', 'hierarchy + group by provider in every group');
}

// ── provider / attribution ──
{
  let p = createTree('P');
  const ins = insertRows(p, p.rootId, undefined, [
    row(1, { provider: 'Iconem', attribution: '© Iconem', set: 'iconem' }), row(2, { provider: 'CRAIG', attribution: '© CRAIG' }),
    row(3, { provider: 'Iconem', attribution: null }), row(4, { provider: null }),
  ]);
  p = ins.tree;
  const leaf = p.nodes[ins.ids[0]] as any;
  check(leaf.provider === 'Iconem' && leaf.attribution === '© Iconem' && !('set' in leaf), 'row provider/attribution copied onto the dataset');
  check(!('provider' in p.nodes[ins.ids[3]]) && !('attribution' in p.nodes[ins.ids[2]]), 'null provider/attribution not copied');
  const ts = toTileset(p);
  const props = ts.schema.classes.dataset.properties;
  check(props.provider?.type === 'STRING' && props.attribution?.type === 'STRING', 'schema declares provider + attribution');
  const tiles = ts.root.children.map((c: any) => c.metadata.properties);
  check(tiles[0].provider === 'Iconem' && tiles[0].attribution === '© Iconem' && tiles[1].provider === 'CRAIG', 'tile metadata carries provider + attribution');
  check(!('provider' in tiles[3]), 'no empty provider property');
  const back = fromTileset(JSON.parse(JSON.stringify(ts)));
  const b1 = Object.values(back.nodes).find((n) => n.name === 'site 1') as any;
  check(b1.provider === 'Iconem' && b1.attribution === '© Iconem' && !b1.kv.some((x: any) => x.key === 'provider'), 'tileset import restores provider + attribution (not as custom keys)');
  const m = toManifest(p);
  check(m.entries[0].provider === 'Iconem' && m.entries[0].attribution === '© Iconem' && m.entries[1].provider === 'CRAIG' && !m.entries[3].provider, 'manifest entries carry provider + attribution');
  const proj = fromProject(JSON.parse(JSON.stringify(toProject(p))));
  check((proj.tree.nodes[ins.ids[1]] as any).attribution === '© CRAIG', 'project save/load keeps provider + attribution');
  const byProv = groupChildrenBy(p, p.rootId, 'provider');
  check(names(byProv, byProv.rootId).join() === 'Iconem,CRAIG,site 4', 'group by provider');
  const iconem = kids(byProv, byProv.rootId)[0];
  check(names(byProv, iconem).join() === 'site 1,site 3', 'provider group keeps document order');
}

// ── scale: 700 datasets ──
{
  let big = createTree('Big');
  const rows = Array.from({ length: 700 }, (_, i) => row(i, { scene: `scene ${i % 290}`, provider: i % 7 ? 'Iconem' : 'Other', date: `20${10 + (i % 15)}` }));
  let t0 = performance.now();
  big = insertRows(big, big.rootId, undefined, rows).tree;
  const grouped = groupChildrenBy(big, big.rootId, 'scene');
  const msGroup = performance.now() - t0;
  check(kids(grouped, grouped.rootId).length === 290 && counts(grouped).datasets === 700, 'group 700 datasets into 290 scenes');
  t0 = performance.now();
  const ts = toTileset(grouped);
  const msExport = performance.now() - t0;
  const gids = kids(grouped, grouped.rootId);
  const folded = updateNodes<GroupNode>(grouped, gids, (n) => (n.kind === 'group' ? { collapsed: true } : null));
  check(gids.every((g) => (folded.nodes[g] as GroupNode).collapsed) && !(grouped.nodes[gids[0]] as GroupNode).collapsed, 'updateNodes patches many, leaves the original alone');
  check(updateNodes(grouped, gids, () => null) === grouped, 'updateNodes with nothing to change returns the same tree');
  check(ts.asset.extras.builder.exported.datasets === 700, 'export 700 datasets');
  check(msGroup < 500 && msExport < 1000, `700 datasets: insert+group ${msGroup.toFixed(1)} ms, export ${msExport.toFixed(1)} ms`);
}

console.log(`builder selftest: ${passed} checks passed`);

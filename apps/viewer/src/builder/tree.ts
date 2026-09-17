/**
 * The Aggregate Builder's document: a tree of groups and dataset leaves, and every edit on it as a
 * pure function returning a NEW tree. Immutability is what makes undo/redo a plain array of states,
 * and lets React skip re-rendering rows whose node object did not change.
 *
 * Nodes live in a flat id → node map with `children` id lists, rather than as nested objects: a
 * drag-and-drop move is then two array splices, not a deep copy of both ancestor chains.
 *
 * No imports: selftest.ts runs this module under plain Node.
 */

export interface KV { key: string; value: string }

interface NodeBase {
  id: string;
  name: string;
  /** "YYYY", "YYYY-MM", "YYYY-MM-DD" or an ISO interval "start/end". */
  date?: string;
  notes?: string;
  kv: KV[];
}

/**
 * `mode` decides what the EXPORT keeps, because 3D Tiles itself has no "show one of these" switch:
 * `all` every child (ADD), `latest` only the newest dated child (a diachronic series of one site),
 * `first` only the first child (a manual pick among alternatives).
 */
export type DisplayMode = 'all' | 'latest' | 'first';

export interface GroupNode extends NodeBase {
  kind: 'group';
  refine: 'ADD' | 'REPLACE';
  mode: DisplayMode;
  collapsed?: boolean;
  children: string[];
}

export interface DatasetNode extends NodeBase {
  kind: 'dataset';
  /** The child URL a renderer loads: already wrapped through /stream or /proxy when it needs to be. */
  url: string;
  format: string;
  lon: number;
  lat: number;
  height: number;
  radius: number;
  licence?: string;
  project?: string;
  scene?: string;
  /** The /aggregate/index.json id this leaf came from (hash of the source URL). */
  sourceId?: string;
  /** Geometric-error override; unset = max(radius, 1), like the server's reference tiles. */
  ge?: number | null;
}

export type BNode = GroupNode | DatasetNode;

export interface Tree {
  rootId: string;
  nodes: Record<string, BNode>;
}

/** One /aggregate/index.json row — structurally the viewer's DatasetMarker. */
export interface Row {
  id: string;
  name: string;
  project?: string;
  scene?: string;
  group?: string | null;
  date?: string | null;
  format: string;
  url: string;
  lon: number;
  lat: number;
  height: number;
  radius: number;
  licence?: string;
}

// crypto.randomUUID only exists in secure contexts, and the viewer is also opened over plain http on
// the LAN (vite `host: true`) — ids only need to be unique within one document.
let seq = 0;
export const uid = (p = 'n') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function makeGroup(name: string, extra: Partial<GroupNode> = {}): GroupNode {
  return { kind: 'group', id: uid('g'), name, kv: [], refine: 'ADD', mode: 'all', children: [], ...extra };
}

export function datasetFromRow(r: Row): DatasetNode {
  return {
    kind: 'dataset', id: uid('d'), name: r.name, kv: [], url: r.url, format: r.format,
    lon: r.lon, lat: r.lat, height: r.height, radius: r.radius,
    ...(r.date ? { date: r.date } : {}), ...(r.licence ? { licence: r.licence } : {}),
    ...(r.project ? { project: r.project } : {}), ...(r.scene ? { scene: r.scene } : {}),
    sourceId: r.id,
  };
}

export function createTree(name = 'My mosaic'): Tree {
  const root = makeGroup(name);
  return { rootId: root.id, nodes: { [root.id]: root } };
}

const copy = (t: Tree): Tree => ({ rootId: t.rootId, nodes: { ...t.nodes } });
const group = (t: Tree, id: string): GroupNode | null => {
  const n = t.nodes[id];
  return n?.kind === 'group' ? n : null;
};

// ── queries ──────────────────────────────────────────────────────────────────────────────────────

export function parentMap(t: Tree): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of Object.values(t.nodes)) if (n.kind === 'group') for (const c of n.children) m.set(c, n.id);
  return m;
}

/** Depth-first, root first — the order rows appear in when everything is expanded. */
export function docOrder(t: Tree, from = t.rootId): string[] {
  const out: string[] = [];
  (function walk(id: string) {
    const n = t.nodes[id];
    if (!n) return;
    out.push(id);
    if (n.kind === 'group') n.children.forEach(walk);
  })(from);
  return out;
}

/** True when `id` is `ancestor` or lies below it. */
export function isWithin(t: Tree, ancestor: string, id: string, parents = parentMap(t)): boolean {
  for (let cur: string | undefined = id; cur; cur = parents.get(cur)) if (cur === ancestor) return true;
  return false;
}

export interface VisibleRow { id: string; depth: number; parent: string | null; index: number }

/** The rows the tree panel draws: document order, skipping collapsed groups' contents. */
export function visibleRows(t: Tree): VisibleRow[] {
  const out: VisibleRow[] = [];
  (function walk(id: string, depth: number, parent: string | null, index: number) {
    const n = t.nodes[id];
    if (!n) return;
    out.push({ id, depth, parent, index });
    if (n.kind === 'group' && !n.collapsed) n.children.forEach((c, i) => walk(c, depth + 1, id, i));
  })(t.rootId, 0, null, 0);
  return out;
}

export function counts(t: Tree): { groups: number; datasets: number } {
  let groups = 0, datasets = 0;
  for (const id of docOrder(t)) if (t.nodes[id].kind === 'group') groups++; else datasets++;
  return { groups, datasets };
}

export function leaves(t: Tree, from = t.rootId): DatasetNode[] {
  return docOrder(t, from).map((id) => t.nodes[id]).filter((n): n is DatasetNode => n.kind === 'dataset');
}

/** Drop ids that are inside another selected id (moving/deleting the ancestor already covers them). */
function topMost(t: Tree, ids: string[], parents: Map<string, string>): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = parents.get(id); p; p = parents.get(p)) if (set.has(p)) return false;
    return true;
  });
}

const inDocOrder = (t: Tree, ids: string[]) => {
  const pos = new Map(docOrder(t).map((id, i) => [id, i]));
  return [...new Set(ids)].filter((id) => pos.has(id)).sort((a, b) => pos.get(a)! - pos.get(b)!);
};

// ── dates ────────────────────────────────────────────────────────────────────────────────────────

const DATE_PART = String.raw`\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?`;
const DATE_RE = new RegExp(`^${DATE_PART}(/${DATE_PART})?$`);
export const isValidDate = (d: string) => DATE_RE.test(d);

/** A date as [first, last] fractional years — same rule as lib/aggregate.ts's dateSpan. */
export function dateSpan(d: string): [number, number] {
  const slash = d.indexOf('/');
  if (slash > 0) return [dateSpan(d.slice(0, slash))[0], dateSpan(d.slice(slash + 1))[1]];
  const [y, m, day] = d.split('-').map(Number);
  if (day) { const x = y + (m - 1) / 12 + (day - 1) / 365; return [x, x]; }
  if (m) return [y + (m - 1) / 12, y + m / 12 - 1e-6];
  return [y, y + 1 - 1e-6];
}

/** A node's date for "latest" comparisons: its own, else (for a group) its newest descendant's. */
export function effectiveDate(t: Tree, id: string): string | undefined {
  const n = t.nodes[id];
  if (!n) return undefined;
  if (n.date && isValidDate(n.date)) return n.date;
  if (n.kind !== 'group') return undefined;
  let best: string | undefined;
  for (const c of n.children) {
    const d = effectiveDate(t, c);
    if (d && (!best || dateSpan(d)[0] > dateSpan(best)[0])) best = d;
  }
  return best;
}

/** The children an export keeps, after the group's display mode. */
export function shownChildren(t: Tree, g: GroupNode): string[] {
  if (g.mode === 'first') return g.children.slice(0, 1);
  if (g.mode === 'latest') {
    let best: string | undefined, bestStart = -Infinity;
    for (const c of g.children) {
      const d = effectiveDate(t, c);
      if (d && dateSpan(d)[0] > bestStart) { best = c; bestStart = dateSpan(d)[0]; }
    }
    // Nothing dated: there is no "latest" to pick, so fall back to a manual pick rather than nothing.
    return best ? [best] : g.children.slice(0, 1);
  }
  return g.children;
}

// ── edits ────────────────────────────────────────────────────────────────────────────────────────

export function updateNode<N extends BNode>(t: Tree, id: string, patch: Partial<N>): Tree {
  const n = t.nodes[id];
  if (!n) return t;
  const out = copy(t);
  out.nodes[id] = { ...n, ...patch, id, kind: n.kind } as BNode;
  return out;
}

function insertIds(out: Tree, parentId: string, index: number | undefined, ids: string[]) {
  const p = group(out, parentId)!;
  const children = [...p.children];
  const at = index == null ? children.length : Math.max(0, Math.min(index, children.length));
  children.splice(at, 0, ...ids);
  out.nodes[parentId] = { ...p, children };
}

export function insertRows(t: Tree, parentId: string, index: number | undefined, rows: Row[]): { tree: Tree; ids: string[] } {
  if (!group(t, parentId) || !rows.length) return { tree: t, ids: [] };
  const out = copy(t);
  const nodes = rows.map(datasetFromRow);
  for (const n of nodes) out.nodes[n.id] = n;
  insertIds(out, parentId, index, nodes.map((n) => n.id));
  return { tree: out, ids: nodes.map((n) => n.id) };
}

export function addGroup(t: Tree, parentId: string, index: number | undefined, name = 'New group', extra: Partial<GroupNode> = {}): { tree: Tree; id: string } {
  if (!group(t, parentId)) return { tree: t, id: '' };
  const out = copy(t);
  const g = makeGroup(name, extra);
  out.nodes[g.id] = g;
  insertIds(out, parentId, index, [g.id]);
  return { tree: out, id: g.id };
}

/** Can `ids` be moved into `parentId`? No root, and no group into itself or its own descendants. */
export function canMove(t: Tree, ids: string[], parentId: string): boolean {
  if (!group(t, parentId) || !ids.length) return false;
  const parents = parentMap(t);
  return ids.every((id) => id !== t.rootId && t.nodes[id] && !isWithin(t, id, parentId, parents));
}

/**
 * Move `ids` (kept in document order) to `index` within `parentId`. `index` is a position in the
 * target's CURRENT children, so moved nodes that sit before it shift it back by one each.
 */
export function moveNodes(t: Tree, ids: string[], parentId: string, index?: number): Tree {
  if (!canMove(t, ids, parentId)) return t;
  const parents = parentMap(t);
  const moving = topMost(t, inDocOrder(t, ids), parents);
  const target = group(t, parentId)!;
  let at = index ?? target.children.length;
  for (const id of moving) if (parents.get(id) === parentId && target.children.indexOf(id) < at) at--;
  const out = copy(t);
  const movingSet = new Set(moving);
  for (const pid of new Set(moving.map((id) => parents.get(id)!))) {
    const p = group(out, pid)!;
    out.nodes[pid] = { ...p, children: p.children.filter((c) => !movingSet.has(c)) };
  }
  insertIds(out, parentId, at, moving);
  return out;
}

export function removeNodes(t: Tree, ids: string[]): Tree {
  const parents = parentMap(t);
  const doomed = topMost(t, ids.filter((id) => id !== t.rootId && t.nodes[id]), parents);
  if (!doomed.length) return t;
  const out = copy(t);
  const doomedSet = new Set(doomed);
  for (const pid of new Set(doomed.map((id) => parents.get(id)!))) {
    const p = group(out, pid)!;
    out.nodes[pid] = { ...p, children: p.children.filter((c) => !doomedSet.has(c)) };
  }
  for (const id of doomed) for (const d of docOrder(t, id)) delete out.nodes[d];
  return out;
}

/** Deep copy of a subtree with fresh ids, inserted right after the original. */
export function duplicateNode(t: Tree, id: string): { tree: Tree; id: string } {
  const parents = parentMap(t);
  const pid = parents.get(id);
  if (!pid) return { tree: t, id: '' };
  const out = copy(t);
  const dup = (srcId: string): string => {
    const n = t.nodes[srcId];
    const nid = uid(n.kind === 'group' ? 'g' : 'd');
    out.nodes[nid] = n.kind === 'group'
      ? { ...n, id: nid, kv: n.kv.map((x) => ({ ...x })), children: n.children.map(dup) }
      : { ...n, id: nid, kv: n.kv.map((x) => ({ ...x })) };
    return nid;
  };
  const nid = dup(id);
  const src = t.nodes[id];
  out.nodes[nid] = { ...out.nodes[nid], name: `${src.name} (copy)` };
  insertIds(out, pid, group(t, pid)!.children.indexOf(id) + 1, [nid]);
  return { tree: out, id: nid };
}

/** Wrap the selection in a new group, placed where the first selected node was. */
export function groupNodes(t: Tree, ids: string[], name = 'New group'): { tree: Tree; id: string } {
  const parents = parentMap(t);
  const sel = topMost(t, inDocOrder(t, ids.filter((id) => id !== t.rootId)), parents);
  if (!sel.length) return { tree: t, id: '' };
  const pid = parents.get(sel[0])!;
  const { tree, id } = addGroup(t, pid, group(t, pid)!.children.indexOf(sel[0]), name);
  return { tree: moveNodes(tree, sel, id), id };
}

export type GroupBy = 'scene' | 'project' | 'year';

const keyOf = (n: DatasetNode, by: GroupBy) =>
  by === 'year' ? (n.date && isValidDate(n.date) ? n.date.slice(0, 4) : '') : (n[by] ?? '').trim();

/**
 * Bucket a group's DIRECT dataset children by scene / project / year into sub-groups. Datasets
 * without that field stay where they are; an existing child group of the same name is reused, so the
 * helper can be applied again after adding more datasets. Year groups get that year as their date, so
 * a parent in `latest` mode can pick between them.
 */
export function groupChildrenBy(t: Tree, groupId: string, by: GroupBy): Tree {
  const g = group(t, groupId);
  if (!g) return t;
  const buckets = new Map<string, string[]>();
  for (const c of g.children) {
    const n = t.nodes[c];
    if (n.kind !== 'dataset') continue;
    const k = keyOf(n, by);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(c);
  }
  let out = t;
  for (const [k, ids] of buckets) {
    const cur = group(out, groupId)!;
    let target = cur.children.find((c) => { const n = out.nodes[c]; return n.kind === 'group' && n.name === k; });
    if (!target) {
      const made = addGroup(out, groupId, cur.children.indexOf(ids[0]), k, by === 'year' ? { date: k } : {});
      out = made.tree;
      target = made.id;
    }
    out = moveNodes(out, ids, target);
  }
  return out;
}

/** Sort a group's direct children by name or date (undated last). */
export function sortChildren(t: Tree, groupId: string, by: 'name' | 'date'): Tree {
  const g = group(t, groupId);
  if (!g) return t;
  const children = [...g.children].sort((a, b) => {
    if (by === 'name') return t.nodes[a].name.localeCompare(t.nodes[b].name, undefined, { numeric: true });
    const da = effectiveDate(t, a), db = effectiveDate(t, b);
    return (da ? dateSpan(da)[0] : Infinity) - (db ? dateSpan(db)[0] : Infinity);
  });
  return updateNode<GroupNode>(t, groupId, { children });
}

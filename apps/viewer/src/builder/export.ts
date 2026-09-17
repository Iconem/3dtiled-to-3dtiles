/**
 * Builder tree ⇄ files: a 3D Tiles 1.1 tileset.json (bounded the way /aggregate bounds a mosaic), an
 * aggregate-set manifest for the tile-server, and back from any aggregate/builder tileset.
 *
 * Bounds follow aggregate-live.js on purpose, so a hand-built mosaic refines exactly like a server-
 * built one: leaf sphere from the index row, group sphere = minimal union of its children's, group
 * GE = 2 × max child GE (strictly decreasing on refine), root = the tighter of the union sphere and an
 * Earth-centred one. See apps/docs/content/docs/guide/aggregate-builder.mdx.
 */
import { ecefToLlh, llhToEcef, sphereOfVolume, transformSphere, unionSphere, type Sphere } from './geo.ts';
import {
  counts, createTree, isValidDate, makeGroup, shownChildren, uid,
  type DatasetNode, type DisplayMode, type GroupNode, type KV, type Tree,
} from './tree.ts';

export const BUILDER_VERSION = 1;

/**
 * index.json rounds lon/lat to 1e-6° (≤ 0.11 m) and radius to 0.1 m, so a sphere rebuilt from a row
 * can miss the dataset's true sphere by a few decimetres. Half a metre of slack keeps it enclosing.
 */
const RADIUS_PAD = 0.5;

const DATASET_PROPS = ['id', 'name', 'project', 'scene', 'date', 'format', 'licence', 'notes'];
const GROUP_PROPS = ['name', 'date', 'notes', 'mode'];

/**
 * 3D Tiles metadata property ids must match ^[a-zA-Z_][a-zA-Z0-9_]*$, while users type "capture
 * team" or "2nd survey". Sanitise rather than reject, and never shadow a built-in property.
 */
export function propertyKey(key: string, reserved: string[]): string {
  let k = key.trim().replace(/[^A-Za-z0-9_]/g, '_') || '_';
  if (/^\d/.test(k)) k = `_${k}`;
  return reserved.includes(k) ? `x_${k}` : k;
}

const clean = (o: Record<string, string | undefined | null>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) as Record<string, string>;

export interface TilesetJson {
  asset: { version: string; generator?: string; extras?: any };
  schema?: any;
  geometricError: number;
  root: any;
  [k: string]: unknown;
}

export function leafSphere(n: DatasetNode): Sphere {
  return [...llhToEcef(n.lon, n.lat, n.height), n.radius + RADIUS_PAD] as Sphere;
}

export const leafGE = (n: DatasetNode) => (n.ge != null && n.ge > 0 ? n.ge : Math.max(n.radius, 1));

export function toTileset(tree: Tree, opts: { now?: Date } = {}): TilesetJson {
  const customKeys = { dataset: new Set<string>(), group: new Set<string>() };
  const custom = (kv: KV[], cls: 'dataset' | 'group') => {
    const out: Record<string, string> = {};
    for (const { key, value } of kv) {
      if (!key.trim()) continue;
      const k = propertyKey(key, cls === 'dataset' ? DATASET_PROPS : GROUP_PROPS);
      customKeys[cls].add(k);
      out[k] = value;
    }
    return out;
  };
  const leafSpheres: Sphere[] = [];
  let exportedGroups = 0, exportedDatasets = 0;

  type Built = { tile: any; sphere: Sphere; ge: number };
  const build = (id: string): Built | null => {
    const n = tree.nodes[id];
    if (!n) return null;
    if (n.kind === 'dataset') {
      const sphere = leafSphere(n);
      const ge = leafGE(n);
      leafSpheres.push(sphere);
      exportedDatasets++;
      const properties = {
        ...clean({ id: n.sourceId ?? n.id, name: n.name, project: n.project, scene: n.scene, date: n.date, format: n.format, licence: n.licence, notes: n.notes }),
        ...custom(n.kv, 'dataset'),
      };
      return {
        sphere, ge,
        tile: {
          boundingVolume: { sphere },
          geometricError: ge,
          refine: 'ADD',
          content: { uri: n.url },
          metadata: { class: 'dataset', properties },
          // Remembered so an import restores the override instead of mistaking it for a radius.
          ...(n.ge != null && n.ge > 0 ? { extras: { builder: { ge: n.ge } } } : {}),
        },
      };
    }
    const kids = shownChildren(tree, n).map(build).filter((b): b is Built => !!b);
    // An empty group bounds nothing; 3D Tiles has no way to express "no volume", so it is left out.
    if (!kids.length) return null;
    exportedGroups++;
    const sphere = kids.reduce<Sphere | null>((acc, k) => unionSphere(acc, k.sphere), null)!;
    const ge = 2 * Math.max(...kids.map((k) => k.ge));
    return {
      sphere, ge,
      tile: {
        boundingVolume: { sphere },
        geometricError: ge,
        refine: n.refine,
        metadata: { class: 'group', properties: { ...clean({ name: n.name, date: n.date, notes: n.notes, mode: n.mode }), ...custom(n.kv, 'group') } },
        children: kids.map((k) => k.tile),
      },
    };
  };

  const root = build(tree.rootId);
  if (!root) throw new Error('Nothing to export: add at least one dataset.');
  // Same rule as the server: a mosaic spread over continents is better bounded by a sphere centred on
  // the Earth than by the pairwise union, whose centre drifts and whose radius overshoots.
  const earthR = Math.max(...leafSpheres.map(([x, y, z, r]) => Math.hypot(x, y, z) + r));
  if (earthR < root.sphere[3]) root.tile.boundingVolume = { sphere: [0, 0, 0, earthR] };

  const stringProps = (names: Iterable<string>) => Object.fromEntries([...names].map((k) => [k, { type: 'STRING' }]));
  const total = counts(tree);
  const rootNode = tree.nodes[tree.rootId];
  return {
    asset: {
      version: '1.1',
      generator: '3D Tiled Aggregate Builder',
      extras: {
        builder: {
          version: BUILDER_VERSION,
          name: rootNode.name,
          exportedAt: (opts.now ?? new Date()).toISOString(),
          // `exported` < `total` when display modes (latest / first) left children out.
          total: { groups: total.groups, datasets: total.datasets },
          exported: { groups: exportedGroups, datasets: exportedDatasets },
        },
      },
    },
    schema: {
      id: 'aggregate',
      classes: {
        dataset: {
          description: 'One source dataset referenced by the mosaic',
          properties: stringProps([...DATASET_PROPS, ...customKeys.dataset]),
        },
        group: {
          description: 'A hand-made group of datasets (Aggregate Builder)',
          properties: stringProps([...GROUP_PROPS, ...customKeys.group]),
        },
      },
    },
    geometricError: root.ge * 2,
    root: root.tile,
  };
}

// ── aggregate-set manifest ───────────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  url: string;
  format: string;
  name?: string;
  project?: string;
  scene?: string;
  date?: string;
  licence?: string;
  notes?: string;
  group?: string;
  proxy?: boolean;
  crs?: string;
  properties?: Record<string, string>;
}

/**
 * A child URL back to what a manifest holds: the SOURCE and how to wrap it. The server re-wraps
 * manifest entries itself (childUrlFor), with its own origin — a manifest that stored this viewer's
 * localhost /stream URL would break on any other deployment. A /stream URL with extra params (e.g.
 * &lon=&lat= placement) cannot be expressed as an entry, so it is kept whole, as a 3D Tiles URL.
 */
export function unwrapChildUrl(url: string): { url: string; format?: string; proxy?: boolean; crs?: string } {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('url');
    if (inner && /\/(stream|tiles)\/tileset\.json$/.test(u.pathname)) {
      const extra = [...u.searchParams.keys()].filter((k) => !['url', 'format', 'cache', 'crs'].includes(k));
      if (!extra.length) return { url: inner, format: u.searchParams.get('format') ?? undefined, crs: u.searchParams.get('crs') ?? undefined };
    }
    if (inner && /\/proxy$/.test(u.pathname) && [...u.searchParams.keys()].length === 1) return { url: inner, proxy: true };
  } catch { /* relative or malformed: keep as is */ }
  return { url };
}

export function toManifest(tree: Tree): { label: string; generator: string; entries: ManifestEntry[] } {
  const entries: ManifestEntry[] = [];
  const walk = (id: string, path: string[]) => {
    const n = tree.nodes[id];
    if (n.kind === 'group') {
      const here = id === tree.rootId ? path : [...path, n.name];
      for (const c of shownChildren(tree, n)) walk(c, here);
      return;
    }
    const src = unwrapChildUrl(n.url);
    const props = Object.fromEntries(n.kv.filter((x) => x.key.trim()).map((x) => [x.key.trim(), x.value]));
    entries.push({
      url: src.url,
      format: src.format ?? n.format,
      ...clean({ name: n.name, project: n.project, scene: n.scene, date: n.date, licence: n.licence, notes: n.notes, crs: src.crs }),
      ...(path.length ? { group: path.join(' / ') } : {}),
      ...(src.proxy ? { proxy: true } : {}),
      ...(Object.keys(props).length ? { properties: props } : {}),
    });
  };
  walk(tree.rootId, []);
  return { label: tree.nodes[tree.rootId].name, generator: '3D Tiled Aggregate Builder', entries };
}

// ── import ───────────────────────────────────────────────────────────────────────────────────────

function mat4Multiply(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nameFromUrl(x: string): string {
  try {
    const u = new URL(x);
    const inner = u.searchParams.get('url');
    const p = (inner ? new URL(inner) : u).pathname.split('/').filter(Boolean);
    const last = p.pop() || u.hostname;
    return /^(tileset\.json|cloud\.js|metadata\.json)$/i.test(last) ? p.pop() || last : last;
  } catch { return x.slice(-40); }
}

function formatOfUrl(x: string): string {
  try {
    const u = new URL(x);
    if (/\/(stream|tiles|convert)\/tileset\.json$/.test(u.pathname)) return (u.searchParams.get('format') || '3dtiles').toLowerCase();
  } catch { /* relative */ }
  return '3dtiles';
}

const MODES: DisplayMode[] = ['all', 'latest', 'first'];

const kvOf = (props: Record<string, unknown>, reserved: string[]): KV[] =>
  Object.entries(props).filter(([k]) => !reserved.includes(k)).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }));

/**
 * Rebuild a tree from an aggregate or builder tileset: content tiles become datasets, content-less
 * tiles become groups. Server-made quadtree cells (no metadata, only `extras.cell`) carry no meaning a
 * user chose, so by default their children are lifted into the parent instead of becoming "cell 0312"
 * groups. Children a display mode left out of the export are not in the file and cannot come back —
 * the project JSON is the lossless format.
 */
export function fromTileset(ts: any, baseUrl?: string, { flattenCells = true } = {}): Tree {
  if (!ts?.root) throw new Error('Not a tileset: no root.');
  const tree = createTree(ts.asset?.extras?.builder?.name ?? ts.root.metadata?.properties?.name ?? 'Imported tileset');
  const resolve = (uri: string) => { try { return new URL(uri, baseUrl).toString(); } catch { return uri; } };

  const walk = (t: any, parentXf: number[] | undefined, isRoot: boolean): string[] => {
    const xf = t.transform ? (parentXf ? mat4Multiply(parentXf, t.transform) : t.transform) : parentXf;
    const props: Record<string, unknown> = t.metadata?.properties ?? {};
    const str = (k: string) => (typeof props[k] === 'string' && props[k] ? (props[k] as string) : undefined);
    const uri: string | undefined = t.content?.uri ?? t.content?.url;
    const kids = (t.children ?? []).flatMap((c: any) => walk(c, xf, false));
    const out: string[] = [];
    if (uri) {
      const bv = t.boundingVolume ?? {};
      const s0 = sphereOfVolume(bv);
      if (s0) {
        const [x, y, z, r] = bv.region ? s0 : transformSphere(s0, xf);
        const [lon, lat, height] = ecefToLlh(x, y, z);
        const url = resolve(uri);
        const date = str('date');
        const ge = t.extras?.builder?.ge;
        const leaf: DatasetNode = {
          kind: 'dataset', id: uid('d'), url,
          name: str('name') ?? nameFromUrl(url), format: str('format') ?? formatOfUrl(url),
          lon, lat, height, radius: Math.max(0, r - (t.metadata?.class === 'dataset' && ts.asset?.extras?.builder ? RADIUS_PAD : 0)),
          kv: kvOf(props, DATASET_PROPS),
          ...clean({ project: str('project'), scene: str('scene'), licence: str('licence'), notes: str('notes'), sourceId: str('id') }),
          ...(date && isValidDate(date) ? { date } : {}),
          ...(typeof ge === 'number' ? { ge } : {}),
        };
        tree.nodes[leaf.id] = leaf;
        out.push(leaf.id);
      }
    }
    if (!kids.length) return out;
    const unnamed = !t.metadata && !isRoot;
    if (unnamed && flattenCells && !uri) return kids;
    const date = str('date');
    const mode = str('mode') as DisplayMode | undefined;
    const g: GroupNode = makeGroup(str('name') ?? (t.extras?.cell ? `cell ${t.extras.cell.key}` : 'Group'), {
      refine: t.refine === 'REPLACE' ? 'REPLACE' : 'ADD',
      mode: mode && MODES.includes(mode) ? mode : 'all',
      kv: kvOf(props, GROUP_PROPS),
      children: [...out, ...kids],
      ...clean({ notes: str('notes') }),
      ...(date && isValidDate(date) ? { date } : {}),
    });
    tree.nodes[g.id] = g;
    return [g.id];
  };

  const top = walk(ts.root, undefined, true);
  const topNode = top.length === 1 ? tree.nodes[top[0]] : null;
  const root = tree.nodes[tree.rootId] as GroupNode;
  if (topNode?.kind === 'group') {
    // The imported root group BECOMES the document root (keeps its name, refine, mode and metadata).
    delete tree.nodes[topNode.id];
    tree.nodes[tree.rootId] = { ...topNode, id: tree.rootId, name: tree.nodes[tree.rootId].name };
  } else {
    tree.nodes[tree.rootId] = { ...root, children: top };
  }
  return tree;
}

// ── project files ────────────────────────────────────────────────────────────────────────────────

export interface ProjectFile {
  kind: 'aggregate-builder-project';
  version: number;
  savedAt: string;
  tree: Tree;
  /** Library rows added by URL: they belong to no server set, so they would be lost otherwise. */
  customRows?: unknown[];
}

export function toProject(tree: Tree, customRows: unknown[] = []): ProjectFile {
  return { kind: 'aggregate-builder-project', version: BUILDER_VERSION, savedAt: new Date().toISOString(), tree, customRows };
}

export function fromProject(j: any): ProjectFile {
  if (j?.kind !== 'aggregate-builder-project' || !j.tree?.nodes?.[j.tree?.rootId]) throw new Error('Not an Aggregate Builder project file.');
  return j as ProjectFile;
}

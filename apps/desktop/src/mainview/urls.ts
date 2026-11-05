/**
 * Pure helpers: the tileset URL for a dataset, the preview and viewer links, and the CLI command
 * equivalent to an export. No DOM, no state — what the components compute from their inputs.
 */
import { CATALOG } from './catalog';
import { base, docsUrl, staticPort, viewerUrl } from './host';
import type { DatasetOptions } from './library';

export const PLACEMENT = ['lon', 'lat', 'alt', 'heading'] as const;

export const EMPTY_FORM: Required<DatasetOptions> = { src: '', format: '', cache: 'none', lon: '', lat: '', alt: '', heading: '' };

/**
 * `/tiles` is the front door: it dispatches to /stream for cache=none|hierarchy and /convert for
 * cache=full, so the UI does not have to encode that routing rule a second time.
 */
export function buildUrlFrom(o: DatasetOptions): string {
  if (!base || !o.src) return '';
  const q = new URLSearchParams();
  q.set('url', o.src);
  if (o.format) q.set('format', o.format);
  q.set('cache', o.cache);
  for (const k of PLACEMENT) {
    const v = o[k];
    if (v != null && v !== '') q.set(k, v);
  }
  return `${base}/tiles/tileset.json?${q.toString()}`;
}

/** The stock Cesium harness, served by the static server the main process started. */
export const previewUrl = (u: string) =>
  staticPort ? `http://127.0.0.1:${staticPort}/cesium-harness.html?url=${encodeURIComponent(u)}` : '';

/** The demo viewer, told to load a tileset on start (its `?load=` parameter). */
export function viewerLink(tilesetUrl: string, type = 'mesh'): string {
  if (!viewerUrl || !tilesetUrl) return '';
  return `${viewerUrl}/?mode=stream&format=3dtiles&renderer=3dtrjs&type=${type}&load=${encodeURIComponent(tilesetUrl)}`;
}

export const typeOfFormat = (format: string) => (['copc', 'potree'].includes(format) ? 'pointcloud' : ['sog', 'lcc', 'rad', 'geosplats'].includes(format) ? 'splat' : 'mesh');
export const kindOf = (fmt: string) => CATALOG.find((g) => g.format === fmt)?.kind ?? 'mesh';
export const iconOf = (fmt: string) => CATALOG.find((g) => g.format === fmt)?.icon ?? '◱';

/** Short display name from a path or URL — the entry file name is the same for every dataset. */
export function nameFor(src: string): string {
  const clean = src.split('?')[0]!.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const last = parts.pop() ?? src;
  if (/^(tileset\.json|cloud\.js|metadata\.json|lod-meta\.json|meta\.lcc)$/i.test(last)) {
    return parts.pop() ?? last;
  }
  return last;
}

export const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const docsBase = docsUrl.replace(/\/$/, '');
export const DOC_LINKS = {
  exportDoc: docsBase ? `${docsBase}/guide/desktop-app#export-to-a-folder` : '#',
  cliDoc: docsBase ? `${docsBase}/guide/cli-usage#export-a-tileset-to-a-folder` : '#',
  middleware: base ? `${base}/` : '#',
};

// ── export ──────────────────────────────────────────────────────────────────────────────────────

/** The export card's own settings, next to the dataset form. */
export interface ExportSettings {
  outDir: string;
  method: 'crawl' | 'convert';
  runner: 'server' | 'cli';
  depth: string;
  verify: string;
  hierarchyErrors: string;
  /** Tile worker threads: '' is one thread, 'auto' (the app's default), or a count. The app's one setting (App.tsx). */
  workers: string;
  keepImplicit: boolean;
  pack3tz: boolean;
  pack3dtiles: boolean;
  convTiling: string;
  convScale: string;
  convGeScale: string;
  convGeLayer: string;
  convCentroids: boolean;
}

export const DEFAULT_EXPORT: ExportSettings = {
  outDir: '', method: 'crawl', runner: 'server', depth: '', verify: 'sample', hierarchyErrors: 'error', workers: 'auto',
  keepImplicit: true, pack3tz: false, pack3dtiles: false,
  convTiling: '', convScale: '', convGeScale: '', convGeLayer: '', convCentroids: false,
};

/** What `POST /export` takes, built from the dataset form and the export card. */
export function exportRequest(f: DatasetOptions, s: ExportSettings) {
  const depth = s.depth.trim();
  const pack = [s.pack3tz && '3tz', s.pack3dtiles && '3dtiles'].filter(Boolean) as string[];
  const options: Record<string, unknown> = {};
  if (s.convTiling) options['tiling'] = s.convTiling;
  for (const [v, key] of [[s.convScale, 'scale'], [s.convGeScale, 'geScale'], [s.convGeLayer, 'geLayer']] as const) {
    if (v.trim() !== '') options[key] = Number(v.trim());
  }
  if (s.convCentroids) options['centroidsOnly'] = true;
  return {
    method: s.method,
    url: buildUrlFrom(f), src: f.src, format: f.format, outDir: s.outDir.trim(),
    maxDepth: depth === '' ? null : Number(depth), keepImplicit: s.keepImplicit, pack, options,
    verify: s.verify,
    hierarchyErrors: s.hierarchyErrors,
    workers: s.workers || null,
  };
}

export type ExportRequest = ReturnType<typeof exportRequest>;

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/**
 * The CLI doing the same thing, as argv arrays (after `node`, from the repo root): what the card
 * displays AND what "Run in: CLI subprocess" executes, so the two cannot drift. `then` is the pack
 * step for the offline converter, whose default path has no `--pack`.
 */
export function exportCliArgs(r: ExportRequest): { args: string[]; then?: string[] } {
  const out = r.outDir || '<empty folder>';
  if (r.method === 'crawl') {
    const args = ['packages/convert/cli.js', 'export', r.url || '<tileset url>', out];
    if (r.maxDepth != null) args.push('--max-depth', String(r.maxDepth));
    if (r.keepImplicit) args.push('--keep-implicit');
    if (r.pack.length) args.push('--pack', r.pack.join(','));
    if (r.verify !== 'sample') args.push('--verify', r.verify);
    if (r.hierarchyErrors !== 'error') args.push('--hierarchy-errors', r.hierarchyErrors);
    // no --workers: a crawl's tiles are built by the server it reads from, not by this process
    return { args };
  }
  const o = r.options;
  const args = ['packages/convert/cli.js', r.src || '<source>', out];
  if (r.format) args.push('--format', r.format);
  if (o['tiling']) args.push('--tiling', String(o['tiling']));
  for (const [key, fl] of [['scale', '--scale'], ['geScale', '--ge-scale'], ['geLayer', '--ge-layer']] as const) {
    if (o[key] != null) args.push(fl, String(o[key]));
  }
  if (o['centroidsOnly']) args.push('--centroids-only');
  if (r.verify !== 'sample') args.push('--verify', r.verify);
  if (r.hierarchyErrors !== 'error') args.push('--hierarchy-errors', r.hierarchyErrors);
  if (r.workers) args.push('--workers', r.workers);
  if (!r.pack.length) return { args };
  const name = out.split(/[\\/]/).filter(Boolean).pop() || 'tileset';
  return { args, then: ['scripts/pack-3dtiles.mjs', out, `${out}/${name}`] };
}

/** Shell-ish rendering for display/copy: plain tokens bare, anything else (paths, URLs) quoted. */
const shellLine = (args: string[]) => ['node', ...args].map((a) => (/^[\w.,/=-]+$/.test(a) ? a : q(a))).join(' ');

/** The CLI command doing the same thing (from the repo root; `3dtiled` once the package is linked). */
export function exportCli(r: ExportRequest): string {
  const { args, then } = exportCliArgs(r);
  return then ? `${shellLine(args)}\n# then (writes both .3tz and .3dtiles):\n${shellLine(then)}` : shellLine(args);
}

/** One block per step of the run, as the progress bar shows it. */
export interface Steps { step: number | null; steps: number; done?: number | null; total?: number | null }

/** "[2/3] Downloading tiles: 14/315 · 3 tilesets · 1.8 MB" → the step it reports, from the last such line. */
export function stepsFromCliOutput(lines: string[]): Steps | null {
  const m = [...lines].reverse().map((l) => /\[(\d+)\/(\d+)\] [^:·]+?(?:: (\d+)\/(\d+))?(?: ·|\s*$)/.exec(l)).find(Boolean);
  if (!m) return null;
  return { step: Number(m[1]), steps: Number(m[2]), done: m[3] ? Number(m[3]) : null, total: m[4] ? Number(m[4]) : null };
}

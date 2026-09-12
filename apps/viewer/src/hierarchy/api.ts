/**
 * Client for the tile-server's `/stats/tileset.json` walker.
 *
 * `/stats` is deliberately a STRUCTURAL analyser: it walks tileset JSON + `.subtree` availability
 * buffers and never downloads geometry, which is what makes it fast enough to run against a live
 * remote host. Content numbers (triangles/points/extensions/compression) only appear when you pass
 * `sample=N`, which fetches N tiles and reads their GLB JSON chunk — hence opt-in here too.
 */
import { MW } from '@/lib/formats';

/** One tile in the walk. Field names are terse because a 4 000-node dump ships on every request. */
export interface StatsNode {
  i: number;      // index (also the implicit id — parents always precede children)
  p: number;      // parent index, -1 for a root
  l: number;      // depth level
  ge: number;     // geometric error
  r: number;      // bounding-volume radius, metres
  c: 0 | 1;       // has content
}

export interface StatsLevel {
  level: number;
  tiles: number;
  content: number;
  leaves: number;
  geMin: number;
  geMax: number;
}

export interface ContentSampleTile {
  level: number; leaf: boolean; ok: boolean;
  bytes?: number; triangles?: number; points?: number; reason?: string;
}

export interface ContentSample {
  sampled: number; decoded: number; leavesSampled: number;
  avgBytes: number; avgTriangles: number; avgPoints: number; avgVertices: number;
  totalTriangles: number; totalPoints: number;
  extensions: Record<string, number>;
  compression: Record<string, number>;
  textures: Record<string, number>;
  perTile: ContentSampleTile[];
}

export interface Stats {
  url: string;
  tilesetGeometricError: number | null;
  totalNodes: number;
  contentNodes: number;
  leafNodes: number;
  maxFanout: number;
  maxDepth: number;
  truncated: boolean;
  /** Which budget stopped the walk: 'nodes' | 'depth' | 'external'. Empty when it completed. */
  truncatedBy?: ('nodes' | 'depth' | 'external')[];
  limits?: { maxNodes: number; maxDepth: number; maxExternal: number };
  subtreesFetched: number;
  externalTilesets: number;
  levels: StatsLevel[];
  content?: ContentSample;
  nodes: StatsNode[];
}

export interface FetchStatsOptions {
  maxNodes?: number;
  /** Hard cap on depth — the walk stops descending past this level. */
  maxDepth?: number;
  /** Cap on external-tileset refs followed. LoD-chain formats (RAD) exhaust this first. */
  maxExternal?: number;
  /** Tiles to download and inspect (0 = none). Stratified across depth by the server. */
  sample?: number;
  signal?: AbortSignal;
}

export async function fetchStats(url: string, opts: FetchStatsOptions = {}): Promise<Stats> {
  const q = new URLSearchParams({ url });
  if (opts.maxNodes) q.set('maxNodes', String(opts.maxNodes));
  if (opts.maxDepth) q.set('maxDepth', String(opts.maxDepth));
  if (opts.maxExternal) q.set('maxExternal', String(opts.maxExternal));
  if (opts.sample) q.set('sample', String(opts.sample));
  const r = await fetch(`${MW}/stats/tileset.json?${q}`, { signal: opts.signal });
  // The endpoint answers errors as plain text, so surface that rather than a JSON parse failure.
  if (!r.ok) throw new Error((await r.text()).slice(0, 300) || `HTTP ${r.status}`);
  return r.json();
}

/**
 * A short human label for a tileset URL. Middleware URLs nest the real source inside `?url=`, so the
 * useful name is in the inner URL — "…/stream/tileset.json?url=…%2Fcloud.js&format=potree" should
 * read as "cloud.js (potree)", not "tileset.json".
 */
export function labelForUrl(raw: string): string {
  try {
    const u = new URL(raw, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
    const inner = u.searchParams.get('url');
    const fmt = u.searchParams.get('format');
    if (inner) {
      const innerName = labelForUrl(inner);
      return fmt ? `${innerName} (${fmt})` : innerName;
    }
    if (u.pathname.endsWith('/aggregate/tileset.json')) {
      // ?set=<name> expands server-side, so there are no url= params to count — name the set instead.
      const set = u.searchParams.get('set');
      const nest = u.searchParams.get('nest');
      const what = set ? `set=${set}` : `×${u.searchParams.getAll('url').length || '?'}`;
      // Filters change which datasets are in the mosaic, so two otherwise-identical URLs are
      // genuinely different tilesets — the label has to say so or a comparison is unreadable.
      const only = u.searchParams.getAll('only');
      const exclude = u.searchParams.getAll('exclude');
      const filter = [
        only.length ? `only ${only.join('+')}` : '',
        exclude.length ? `−${exclude.join('−')}` : '',
      ].filter(Boolean).join(' ');
      return `aggregate ${what}${nest ? ` (${nest})` : ''}${filter ? ` [${filter}]` : ''}`;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.pop() ?? u.hostname;
    // Every format's entry file is a fixed name — cloud.js, metadata.json, tileset.json,
    // lod-meta.json — so the filename alone labels every Potree dataset identically. Prefer the
    // containing folder, unless that is an opaque storage token (api.iconem.com/s/<24-char id>/…),
    // in which case the host is the only thing that actually tells them apart.
    // An opaque name — a UUID or a storage token — identifies nothing to a reader. Both the fixed
    // entry filenames AND hash-like filenames fall back to the folder, then to the host.
    const opaque = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s) || /^[A-Za-z0-9_-]{16,}$/.test(s);
    const fixedEntry = /^(tileset\.json|cloud\.js|metadata\.json|lod-meta\.json|meta\.lcc)$/i.test(last);
    if (fixedEntry || opaque(last.replace(/\.[a-z0-9]+$/i, ''))) {
      const folder = parts.pop();
      if (folder && !opaque(folder)) return folder;
      return `${u.hostname}${folder ? `/${folder.slice(0, 6)}…` : ''}`;
    }
    return last;
  } catch {
    return raw.slice(0, 40);
  }
}

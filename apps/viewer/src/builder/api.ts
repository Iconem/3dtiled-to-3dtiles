/**
 * Tile-server calls the builder makes: which sets exist, their rows, resolving an ad-hoc URL into a
 * placed row, and parking a draft for preview.
 */
import { MW } from '@/lib/formats';
import { aggregateIndexUrl, type AggregateIndex } from '@/lib/aggregate';
import type { Row } from './tree';
import type { TilesetJson } from './export';

export interface SetInfo { name: string; label: string; count: number; local: boolean }

export async function fetchSets(): Promise<SetInfo[]> {
  const r = await fetch(`${MW}/aggregate/demo.json`);
  if (!r.ok) throw new Error(`demo.json → HTTP ${r.status}`);
  const j = await r.json();
  return Object.entries<any>(j).map(([name, v]) => ({ name, label: v.label ?? name, count: v.count ?? 0, local: !!v.local }));
}

async function readIndex(url: string, signal?: AbortSignal): Promise<AggregateIndex> {
  const r = await fetch(url, { signal });
  if (r.status === 422) {
    // Nothing placeable: the body says why (no georeference, or every child failed to fetch).
    const j = await r.json().catch(() => ({}));
    if (j.unplaced?.length) throw new Error(`unplaced — ${j.unplaced[0].reason}. Place it first with /stream's &lon=&lat=.`);
    throw new Error(`failed — ${j.failed?.[0]?.error ?? j.error ?? 'not placeable'}`);
  }
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `HTTP ${r.status}`);
  return r.json();
}

/** `nest=flat`: the index is flattened anyway, and the flat tree is the cheapest to build. */
export const fetchSetRows = (set: string, signal?: AbortSignal) =>
  readIndex(`${MW}/aggregate/index.json?set=${encodeURIComponent(set)}&nest=flat`, signal);

export const fetchIndexUrl = (url: string, signal?: AbortSignal) =>
  readIndex(aggregateIndexUrl(url), signal);

/** Source format from a raw URL — the same file names /stream recognises. */
export function guessFormat(url: string): 'potree' | 'copc' | '3dtiles' {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/(^|\/)(cloud\.js|metadata\.json)$/.test(path)) return 'potree';
  if (path.endsWith('.copc.laz')) return 'copc';
  return '3dtiles';
}

/**
 * A raw URL → the child URL a mosaic references, wrapped like the server's childUrlFor: point clouds
 * through /stream, non-CORS 3D Tiles hosts through the tileset-aware /proxy.
 */
export function wrapChildUrl(raw: string, { proxy = false, crs = '' } = {}): { url: string; format: string } {
  const format = guessFormat(raw);
  if (format === '3dtiles') return { url: proxy ? `${MW}/proxy?url=${encodeURIComponent(raw)}` : raw, format };
  const url = `${MW}/stream/tileset.json?format=${format}&url=${encodeURIComponent(raw)}&cache=none`
    + (crs ? `&crs=${encodeURIComponent(crs)}` : '');
  return { url, format };
}

/**
 * Resolve one URL into a placed row. A single-URL /aggregate/index.json does exactly the work needed:
 * it fetches the child root, derives its sphere and reports lon/lat/height/radius — or answers 422
 * when the dataset has no georeference.
 */
export async function resolveUrl(raw: string, opts: { proxy?: boolean; crs?: string } = {}): Promise<Row> {
  const { url, format } = wrapChildUrl(raw.trim(), opts);
  const idx = await readIndex(`${MW}/aggregate/index.json?url=${encodeURIComponent(url)}&nest=flat`);
  if (idx.failed?.length) throw new Error(idx.failed[0].error);
  const d = idx.datasets[0];
  if (!d) throw new Error('unplaced — the server returned no dataset');
  return { ...d, format: d.format || format } as Row;
}

export async function postDraft(ts: TilesetJson): Promise<{ id: string; url: string }> {
  const r = await fetch(`${MW}/aggregate/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ts),
  });
  if (!r.ok) throw new Error(`draft → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'mosaic';

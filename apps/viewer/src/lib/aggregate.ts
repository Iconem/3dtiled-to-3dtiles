/**
 * Client helpers for the tile-server's /aggregate mosaics: which sets the server has, the per-dataset
 * index of a loaded mosaic, and the search that runs over it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { MW } from './formats';
import { snapRasterFor, type TerrainMode } from './terrainModes';

/** One placed dataset of a mosaic, as returned by /aggregate/index.json. */
export interface DatasetMarker {
  /** Stable short id (hash of the source URL) — what `&hide=` takes. */
  id: string;
  name: string;
  project?: string;
  scene?: string;
  /** Platform scene when known (`scene:<uuid>`): datasets sharing one belong to the same site. */
  group?: string | null;
  /** Capture date, "YYYY", "YYYY-MM", "YYYY-MM-DD" or an ISO interval "start/end"; null when unknown. */
  date?: string | null;
  format: string;
  url: string;
  lon: number;
  lat: number;
  height: number;
  radius: number;
  licence?: string;
  /** Who the data comes from ("Iconem", "Aerometrex", "CRAIG" …) and the credit line to show for it. */
  provider?: string | null;
  attribution?: string | null;
  /** The server set the row came from. */
  set?: string | null;
  /** ISO 3166-1 alpha-3 of the country the dataset is in, when the server knows it, and its name. */
  country?: string | null;
  countryName?: string | null;
  /** The quadtree cell the dataset's external root hangs under, and its depth in the mosaic tree. */
  cell?: { scheme: string; key: string; morton?: string; level: number };
  depth?: number;
  /** Server-side snap to ground (&snap=): the vertical offset applied to this dataset. */
  snap?: { terrain: string; dz: number | null; bins?: number; spread?: number };
  /** Set by the client: the marker colour of the active colour mode. */
  color?: string;
  /** Set by the client: listed in the full index but excluded from the loaded mosaic. */
  inactive?: boolean;
}

export interface AggregateIndex {
  count: number;
  datasets: DatasetMarker[];
  unplaced: { url: string; reason: string }[];
  failed: { url: string; error: string }[];
}

// Server-built mosaics and the Aggregate Builder's drafts (/aggregate/draft/<id>/tileset.json) — both
// have an index.json next to them and honour the picker params.
export const isAggregateUrl = (u: string) => /\/aggregate\/(draft\/[0-9a-f-]{36}\/)?tileset\.json(\?|$)/.test(u);

/** The index.json describing an aggregate tileset URL (same query, so the same selection). */
export const aggregateIndexUrl = (tilesetUrl: string) =>
  tilesetUrl.replace(/\/aggregate\/(draft\/[^/?]+\/)?tileset\.json/, '/aggregate/$1index.json');

// ── the picker's state lives in the mosaic URL ─────────────────────────────────────────────────
//
// Show/hide, "latest only", the date range and the format filter are all server-side selection
// params, so a filtered view is still one plain 3D Tiles URL (shareable, pasteable into Unreal).
// The picker reads its state back from the loaded URL rather than keeping a copy that could drift.
export interface PickerState {
  hide: Set<string>;
  latest: boolean;
  from: string;
  to: string;
  formats: string[];
}
const PICKER_KEYS = ['hide', 'latest', 'from', 'to', 'format'];

export function readPicker(url: string): PickerState {
  const q = new URL(url, location.href).searchParams;
  return {
    hide: new Set(q.getAll('hide').flatMap((s) => s.split(',')).filter(Boolean)),
    latest: ['1', 'true'].includes(q.get('latest') ?? ''),
    from: q.get('from') ?? '',
    to: q.get('to') ?? '',
    formats: q.getAll('format').flatMap((s) => s.split(',')).filter(Boolean),
  };
}

/** The mosaic URL without any picker param: its index lists everything the picker can offer. */
export function pickerBaseUrl(url: string): string {
  const u = new URL(url, location.href);
  for (const k of PICKER_KEYS) u.searchParams.delete(k);
  return u.toString();
}

export function withPicker(url: string, st: PickerState): string {
  const u = new URL(pickerBaseUrl(url));
  if (st.formats.length) u.searchParams.set('format', st.formats.join(','));
  if (st.latest) u.searchParams.set('latest', '1');
  if (st.from) u.searchParams.set('from', st.from);
  if (st.to) u.searchParams.set('to', st.to);
  if (st.hide.size) u.searchParams.set('hide', [...st.hide].sort().join(','));
  return u.toString();
}

/** How group tiles are bounded (`&bv=`). `cell` — the quadtree cell itself — is the server default. */
export const BV_MODES = ['cell', 'sphere', 'region', 'box'] as const;
export type BvMode = typeof BV_MODES[number];
export const readBv = (url: string): BvMode =>
  (new URL(url, location.href).searchParams.get('bv') as BvMode | null) ?? 'cell';

function withParam(url: string, key: string, value: string | null): string {
  const u = new URL(url, location.href);
  if (value == null) u.searchParams.delete(key); else u.searchParams.set(key, value);
  return u.toString();
}
export const withBv = (url: string, bv: BvMode) => withParam(url, 'bv', bv === 'cell' ? null : bv);

/** `&snap=` for the terrain on screen (its raster twin for the quantized mesh), or off. */
export const readSnap = (url: string) => new URL(url, location.href).searchParams.get('snap');
export function withSnap(url: string, terrain: TerrainMode | null): string {
  if (!terrain) return withParam(url, 'snap', null);
  return withParam(url, 'snap', snapRasterFor(terrain) ?? 'mapterhorn-ellipsoid');
}

/**
 * Open ONE dataset of a mosaic on its own, in a new tab: a Potree cloud in the potree lab (raw
 * `cloud.js`, PotreePlugin), anything else in the 3DTRjs viewer. `url` is the mosaic leaf's content
 * URL — a `/stream` wrapper for Potree/COPC, whose `url` param is the source.
 */
export function externalViewerUrl(d: { url: string; format: string }): { href: string; label: string } {
  const u = new URL(d.url, location.href);
  const src = /\/stream\/tileset\.json/.test(u.pathname) ? u.searchParams.get('url') : null;
  if (d.format === 'potree' && src) return { href: `/potree-lab?url=${encodeURIComponent(src)}`, label: 'open in potree lab' };
  const type = d.format === '3dtiles' ? 'mesh' : 'pointcloud';
  return { href: `/?renderer=3dtrjs&load=${encodeURIComponent(d.url)}&type=${type}`, label: 'open in 3DTRjs' };
}

/** The index shares the mosaic's exact query, so both describe the same selection. */
export async function fetchAggregateIndex(tilesetUrl: string, signal?: AbortSignal): Promise<AggregateIndex> {
  const r = await fetch(aggregateIndexUrl(tilesetUrl), { signal });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || `HTTP ${r.status}`);
  return r.json();
}

// ── which sets exist on this server ────────────────────────────────────────────────────────────
//
// Machine-local sets (the Iconem share-link manifest) only exist where that manifest was generated,
// so their pills must be hidden elsewhere rather than shown and left to fail with "unknown set".
// Fetched once per page; every TopBar render shares the same promise.
let setsPromise: Promise<Set<string>> | null = null;
function loadAvailableSets(): Promise<Set<string>> {
  setsPromise ??= fetch(`${MW}/aggregate/demo.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .then((j) => new Set(Object.keys(j)))
    .catch(() => new Set<string>());
  return setsPromise;
}

/** `null` while loading — callers should treat that as "not available yet". */
export function useAvailableSets(): Set<string> | null {
  const [sets, setSets] = useState<Set<string> | null>(null);
  useEffect(() => {
    let alive = true;
    loadAvailableSets().then((s) => { if (alive) setSets(s); });
    return () => { alive = false; };
  }, []);
  return sets;
}

// ── your own manifest, uploaded from a file ──────────────────────────────────────────────────────
//
// The same JSON as a server's `.local/aggregate-sets/<name>.json` ({ label, entries: [{ url, format,
// name? … }] }), POSTed to /aggregate/set: the server keeps it in memory and answers with a set name
// (a hash of the manifest) every /aggregate param works with. The file is also kept in localStorage
// under that name, so a link to the mosaic survives a server restart: restoreUploadedSet re-sends it.
const UPLOAD_PREFIX = '3dtiled:manifest:';
const UPLOAD_KEY = (set: string) => `${UPLOAD_PREFIX}${set}`;

export interface UploadedSet { set: string; label: string; count: number; url: string; pointsOnly: boolean }

/** The mosaic URL of an uploaded set, on this page's tile-server. */
export const uploadedSetUrl = (set: string) => `${MW}/aggregate/tileset.json?set=${set}&nest=geodetic`;
/** The `set=upload-…` name an /aggregate URL refers to, or null. */
export function uploadedSetOf(url: string): string | null {
  try {
    const set = new URL(url, location.href).searchParams.get('set');
    return set?.startsWith('upload-') ? set : null;
  } catch { return null; }
}

// ── the uploaded manifests this browser knows: pills in the Aggregate row ────────────────────────
//
// Every manifest kept in localStorage becomes a pill, like a server set. One opened through a shared
// `?load=` link, without the file, is listed too (for this page only): the server still holds it.
const uploadListeners = new Set<() => void>();
const transient = new Map<string, UploadedSet>();
let uploadsCache: UploadedSet[] | null = null;
const describe = (set: string, text: string): UploadedSet => {
  let label = 'uploaded manifest', count = 0, pointsOnly = false;
  try {
    const m = JSON.parse(text);
    const entries: any[] = Array.isArray(m) ? m : m?.entries ?? [];
    label = (!Array.isArray(m) && m?.label) || label;
    count = entries.length;
    pointsOnly = count > 0 && entries.every((e) => e?.format === 'potree' || e?.format === 'copc');
  } catch { /* unreadable: still a pill, the server decides */ }
  return { set, label, count, url: uploadedSetUrl(set), pointsOnly };
};
function uploadsChanged() { uploadsCache = null; uploadListeners.forEach((f) => f()); }
export function listUploadedSets(): UploadedSet[] {
  if (uploadsCache) return uploadsCache;
  const out = new Map<string, UploadedSet>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(UPLOAD_PREFIX)) out.set(k.slice(UPLOAD_PREFIX.length), describe(k.slice(UPLOAD_PREFIX.length), localStorage.getItem(k) ?? ''));
  }
  transient.forEach((v, k) => { if (!out.has(k)) out.set(k, v); });
  return (uploadsCache = [...out.values()]);
}
/** List a mosaic URL's uploaded set without its file (a shared link opened in another browser). */
export function noteUploadedUrl(url: string) {
  const set = uploadedSetOf(url);
  if (!set || transient.has(set) || localStorage.getItem(UPLOAD_KEY(set))) return;
  transient.set(set, { set, label: 'uploaded manifest', count: 0, url: uploadedSetUrl(set), pointsOnly: false });
  uploadsChanged();
}
export function forgetUploadedSet(set: string) {
  localStorage.removeItem(UPLOAD_KEY(set));
  transient.delete(set);
  uploadsChanged();
}
export function useUploadedSets(): UploadedSet[] {
  return useSyncExternalStore((cb) => { uploadListeners.add(cb); return () => { uploadListeners.delete(cb); }; }, listUploadedSets);
}

async function postManifest(text: string): Promise<{ set: string; label: string; count: number; url: string }> {
  const r = await fetch(`${MW}/aggregate/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
  if (!r.ok) throw new Error((await r.text()).slice(0, 300) || `HTTP ${r.status}`);
  return r.json();
}

export async function uploadManifest(file: File): Promise<UploadedSet> {
  const text = await file.text();
  let m: any;
  try { m = JSON.parse(text); } catch (e) { throw new Error(`${file.name} is not JSON: ${(e as Error).message}`); }
  const entries: any[] = Array.isArray(m) ? m : m?.entries ?? [];
  const res = await postManifest(text);
  try { localStorage.setItem(UPLOAD_KEY(res.set), text); }
  catch { /* over quota: the mosaic still works, it just won't survive a server restart */ }
  const up = { ...res, url: uploadedSetUrl(res.set), pointsOnly: entries.length > 0 && entries.every((e) => e?.format === 'potree' || e?.format === 'copc') };
  transient.set(res.set, up);                 // listed even when localStorage refused it
  uploadsChanged();
  return up;
}

/** Re-send the stored manifest a mosaic URL refers to (a no-op for any other URL). */
export async function restoreUploadedSet(tilesetUrl: string): Promise<void> {
  let set: string | null = null;
  try { set = new URL(tilesetUrl, location.href).searchParams.get('set'); } catch { return; }
  if (!set?.startsWith('upload-')) return;
  const text = localStorage.getItem(UPLOAD_KEY(set));
  if (text) await postManifest(text).catch((e) => console.warn('[manifest] could not re-send', set, e));
}

// ── dataset search ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, accents stripped — "Quéribus" must match "queribus". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Levenshtein distance, giving up (returning max+1) as soon as it cannot stay within `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed for a term: none below 4 letters (too many false hits), 1 up to 6, then 2. */
const typoBudget = (t: string) => (t.length < 4 ? 0 : t.length < 7 ? 1 : 2);

/**
 * How well one term matches a folded haystack: 0 exact substring, 1–2 within the typo budget of
 * some word — or of a same-length window of a word, since names glue words together ("MesAynak",
 * "PhnomKulen") — and Infinity for no match.
 */
function termCost(term: string, hay: string, words: string[]): number {
  if (hay.includes(term)) return 0;
  const k = typoBudget(term);
  if (!k) return Infinity;
  let best = Infinity;
  for (const w of words) {
    if (w.length + k < term.length) continue;
    for (let len = term.length - k; len <= term.length + k; len++) {
      for (let i = 0; i + len <= w.length && best > 1; i++) {
        best = Math.min(best, editDistance(term, w.slice(i, i + len), k));
      }
    }
    if (best <= 1) break;
  }
  return best <= k ? best : Infinity;
}

/**
 * Every whitespace-separated term must match the dataset's name, project, scene, format or date —
 * exactly, or within a small typo budget ("mes aynek", "queribs", "venezzia"). Ranked by typos, then
 * by where the first term hit (start of the name, inside it, elsewhere). Runs per keystroke over
 * ~700 rows: exact hits short-circuit, and the edit distance bails out past its budget.
 */
export function searchDatasets(datasets: DatasetMarker[], query: string, limit = 8): DatasetMarker[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { d: DatasetMarker; s: number }[] = [];
  for (const d of datasets) {
    const name = fold(d.name || '');
    const hay = `${name} ${fold(d.project || '')} ${fold(d.scene || '')} ${d.format} ${d.date ?? ''}`;
    const words = hay.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    let typos = 0;
    for (const t of terms) {
      typos += termCost(t, hay, words);
      if (typos === Infinity) break;
    }
    if (typos === Infinity) continue;
    const where = name.startsWith(terms[0]) ? 0 : name.includes(terms[0]) ? 1 : 2;
    scored.push({ d, s: typos * 10 + where });
  }
  return scored.sort((a, b) => a.s - b.s || a.d.name.localeCompare(b.d.name)).slice(0, limit).map((x) => x.d);
}

/** A capture date as a [first, last] span in fractional years: "2012" → [2012, 2013). */
export function dateSpan(d: string): [number, number] {
  // an ISO 8601 interval ("2021-01-01/2025-01-01": a multi-year national campaign)
  const slash = d.indexOf('/');
  if (slash > 0) return [dateSpan(d.slice(0, slash))[0], dateSpan(d.slice(slash + 1))[1]];
  const [y, m, day] = d.split('-').map(Number);
  if (day) { const t = y + (m - 1) / 12 + (day - 1) / 365; return [t, t]; }
  if (m) return [y + (m - 1) / 12, y + m / 12 - 1e-6];
  return [y, y + 1 - 1e-6];
}

/** "2015-11-08" → 2015.85 — for the timeline slider. */
export function dateToYear(d: string): number {
  const [y, m = '6', day = '15'] = d.split('/')[0].split('-');
  return +y + (+m - 1) / 12 + (+day - 1) / 365;
}

// ── world search (OpenStreetMap via Photon) ────────────────────────────────────────────────────

export interface Place {
  label: string;
  detail: string;
  lon: number;
  lat: number;
  /** [minLon, maxLat, maxLon, minLat] when the place has an area. */
  extent?: [number, number, number, number];
}

/**
 * Photon (komoot) is an OSM geocoder that needs no key and sends CORS headers. Its fair-use policy
 * expects modest traffic, so the caller debounces and only queries from 3 characters.
 */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`, { signal });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.features || []).map((f: any) => {
    const p = f.properties || {};
    const detail = [p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
    return {
      label: p.name || p.street || p.city || 'Unnamed place',
      detail: detail || `${p.osm_key ?? ''} ${p.osm_value ?? ''}`.trim(),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      extent: Array.isArray(p.extent) ? p.extent : undefined,
    } as Place;
  });
}

/** Camera height that frames a place: its extent's diagonal if it has one, else a street-level view. */
export function heightForPlace(p: Place): number {
  if (!p.extent) return 2500;
  const [w, n, e, s] = p.extent;
  const mPerDeg = 111_320;
  const dx = (e - w) * mPerDeg * Math.cos((p.lat * Math.PI) / 180);
  const dy = (n - s) * mPerDeg;
  return Math.min(20_000_000, Math.max(800, Math.hypot(dx, dy) * 1.2));
}

/**
 * Client helpers for the tile-server's /aggregate mosaics: which sets the server has, the per-dataset
 * index of a loaded mosaic, and the search that runs over it.
 */
import { useEffect, useState } from 'react';
import { MW } from './formats';

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

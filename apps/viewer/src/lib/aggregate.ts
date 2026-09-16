/**
 * Client helpers for the tile-server's /aggregate mosaics: which sets the server has, the per-dataset
 * index of a loaded mosaic, and the search that runs over it.
 */
import { useEffect, useState } from 'react';
import { MW } from './formats';

/** One placed dataset of a mosaic, as returned by /aggregate/index.json. */
export interface DatasetMarker {
  name: string;
  project?: string;
  scene?: string;
  format: string;
  url: string;
  lon: number;
  lat: number;
  height: number;
  radius: number;
}

export interface AggregateIndex {
  count: number;
  datasets: DatasetMarker[];
  unplaced: { url: string; reason: string }[];
  failed: { url: string; error: string }[];
}

export const isAggregateUrl = (u: string) => /\/aggregate\/tileset\.json(\?|$)/.test(u);

/** The index shares the mosaic's exact query, so both describe the same selection. */
export async function fetchAggregateIndex(tilesetUrl: string, signal?: AbortSignal): Promise<AggregateIndex> {
  const r = await fetch(tilesetUrl.replace('/aggregate/tileset.json', '/aggregate/index.json'), { signal });
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

/**
 * Every whitespace-separated term must appear somewhere in the dataset's name, project, scene or
 * format; results that START with the first term in their name rank first. Deliberately simple: it
 * runs on every keystroke over ~700 rows, and a predictable substring match beats a fuzzy one for
 * names like "PhnomKulen_02-1".
 */
export function searchDatasets(datasets: DatasetMarker[], query: string, limit = 8): DatasetMarker[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { d: DatasetMarker; s: number }[] = [];
  for (const d of datasets) {
    const name = fold(d.name || '');
    const hay = `${name} ${fold(d.project || '')} ${fold(d.scene || '')} ${d.format}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    scored.push({ d, s: name.startsWith(terms[0]) ? 0 : name.includes(terms[0]) ? 1 : 2 });
  }
  return scored.sort((a, b) => a.s - b.s || a.d.name.localeCompare(b.d.name)).slice(0, limit).map((x) => x.d);
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

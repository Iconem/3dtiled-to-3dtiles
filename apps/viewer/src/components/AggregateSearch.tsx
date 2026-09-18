/**
 * Search, markers and a show/hide picker for /aggregate mosaics.
 *
 * Shown only while an /aggregate tileset is the loaded one. Two indexes are fetched:
 *  - the FULL index (the loaded URL minus every picker param): what search, markers and the picker
 *    can offer — including datasets the current filters exclude, so they can be brought back;
 *  - the CURRENT index (the loaded URL as is): which of those are actually in the mosaic.
 * Every picker change (show/hide, latest only, dates, formats) rewrites the mosaic URL, so the URL
 * stays the whole state and a filtered view is still a plain 3D Tiles endpoint — but the renderer
 * does not reload it: it keeps the unfiltered mosaic and hides the excluded datasets in place, by the
 * `id` in each leaf's tile metadata (ViewerHandle.setDatasetStyle). Only the bounding volumes (`bv`)
 * and the snap to ground change the tree itself, and reload it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import {
  BV_MODES, dateSpan, externalViewerUrl, fetchAggregateIndex, heightForPlace, isAggregateUrl, pickerBaseUrl, readBv, readPicker, readSnap,
  searchDatasets, searchPlaces, withBv, withPicker, withSnap, type AggregateIndex, type BvMode, type DatasetMarker,
  type PickerState, type Place,
} from '@/lib/aggregate';
import { markerColors, providerColor, type ColorMode, type DatasetStyle } from '@/lib/datasetStyle';
import { MARKER_COLORS } from './Viewport/DatasetTooltip';

type Row = { kind: 'dataset'; d: DatasetMarker } | { kind: 'place'; p: Place };

/** A dataset joins the "in view" list a little before its marker hands off (10%). */
const IN_VIEW_FRACTION = 0.03;
const IN_VIEW_POLL_MS = 1000;

const Dot = ({ color, dim }: { color?: string; dim?: boolean }) => (
  <span className="size-2 shrink-0 rounded-full" style={{ background: dim ? '#6b7280' : color ?? '#94a3b8' }} />
);

/** A small segmented control. */
function Segmented<T extends string>({ value, options, onChange, title }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; title?: string;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded border" title={title}>
      {options.map((o) => (
        <button key={o} type="button" onClick={() => o !== value && onChange(o)}
          className={`px-1.5 py-0.5 ${o === value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}>{o}</button>
      ))}
    </span>
  );
}

const BV_HELP = 'Bounding volume of the mosaic\'s group tiles. cell: the quadtree cell itself (default — tight, never overlapping); '
  + 'sphere / region / box: fitted to the datasets inside. Each dataset keeps its own volumes below.';

const cellLabel = (d: DatasetMarker) => (d.cell ? ` · cell ${d.cell.key || '(root)'} z${d.cell.level}, depth ${d.depth}` : '');

export default function AggregateSearch({ activeHandleRef, renderer }: {
  activeHandleRef: React.RefObject<ViewerHandle | null>;
  renderer: string;
}) {
  const lastLoadUrl = useViewerStore((s) => s.lastLoadUrl);
  const active = isAggregateUrl(lastLoadUrl);
  const baseUrl = useMemo(() => (active ? pickerBaseUrl(lastLoadUrl) : ''), [active, lastLoadUrl]);
  const picker = useMemo(() => (active ? readPicker(lastLoadUrl) : null), [active, lastLoadUrl]);
  const filtered = baseUrl !== '' && baseUrl !== new URL(lastLoadUrl, location.href).toString();

  const [full, setFull] = useState<AggregateIndex | null>(null);
  const [current, setCurrent] = useState<AggregateIndex | null>(null);
  const [error, setError] = useState('');
  const [showMarkers, setShowMarkers] = useState(true);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [panel, setPanel] = useState(true);
  const [inView, setInView] = useState<string[]>([]);
  const [years, setYears] = useState<number[] | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('format');
  // providers whose MARKERS are hidden (the data itself is the picker's business)
  const [mutedProviders, setMutedProviders] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);
  const terrainMode = useViewerStore((s) => s.terrainMode);

  // What the active renderer actually has loaded. The picker only rewrites the URL (selfUrl) when the
  // renderer already holds this mosaic unfiltered; anything else — another load, a renderer switch —
  // is a real load of `lastLoadUrl`.
  const loadedRef = useRef({ renderer: '', url: '' });
  const selfUrlRef = useRef('');
  useEffect(() => {
    if (renderer !== loadedRef.current.renderer || lastLoadUrl !== selfUrlRef.current) loadedRef.current = { renderer, url: lastLoadUrl };
    selfUrlRef.current = '';
  }, [lastLoadUrl, renderer]);

  // Full index: only when the underlying mosaic changes, not on every picker tweak.
  useEffect(() => {
    setFull(null); setError(''); setQuery(''); setPlaces([]); setInView([]);
    if (!baseUrl) return;
    const ac = new AbortController();
    fetchAggregateIndex(baseUrl, ac.signal).then(setFull).catch((e) => { if (!ac.signal.aborted) setError(String(e.message || e)); });
    return () => ac.abort();
  }, [baseUrl]);

  // Current index: what the loaded (filtered) URL actually contains. The previous one stays until the
  // next arrives, so rapid clicks keep working instead of every row flashing disabled meanwhile.
  useEffect(() => { setCurrent(null); }, [baseUrl]);
  useEffect(() => {
    if (!active || !filtered) return;
    const ac = new AbortController();
    fetchAggregateIndex(lastLoadUrl, ac.signal).then(setCurrent).catch((e) => { if (!ac.signal.aborted) setError(String(e.message || e)); });
    return () => ac.abort();
  }, [lastLoadUrl, active, filtered]);

  const activeIds = useMemo(() => {
    if (!full) return new Set<string>();
    const src = filtered ? current : full;
    // index on its way: the hand-hidden set is known already, the rest follows with the index
    if (!src) return new Set(full.datasets.filter((d) => !picker?.hide.has(d.id)).map((d) => d.id));
    return new Set(src.datasets.map((d) => d.id));
  }, [full, current, filtered, picker]);

  const colors = useMemo(() => markerColors(full?.datasets ?? [], colorMode), [full, colorMode]);

  /**
   * Markers: datasets of a type that is filtered out, or of a muted provider, are not shown at all;
   * those hidden by hand, by date or by "latest only" stay as grey dots, so they can be found again.
   */
  const markers = useMemo(() => {
    if (!full || !picker) return null;
    if (filtered && !current) return null;                      // wait, rather than flash everything as hidden
    return full.datasets
      .filter((d) => !(picker.formats.length && !picker.formats.includes(d.format)))
      .filter((d) => !mutedProviders.has(d.provider ?? ''))
      .map((d) => ({ ...d, color: colors.get(d.id), ...(activeIds.has(d.id) ? {} : { inactive: true }) }));
  }, [full, current, filtered, activeIds, picker, mutedProviders, colors]);

  // Push markers to the renderer. Re-run on renderer switch: the handle behind the ref changes.
  useEffect(() => {
    activeHandleRef.current?.setDatasetMarkers?.(active && showMarkers && markers ? markers : null);
    return () => { activeHandleRef.current?.setDatasetMarkers?.(null); };
  }, [markers, showMarkers, active, renderer, activeHandleRef]);

  // Hide the datasets themselves, in place. `undefined` = the current index is still on its way.
  // The colour mode is for the markers only; the data keeps its own colours.
  const style = useMemo((): DatasetStyle | null | undefined => {
    if (!full) return null;
    if (filtered && !current) return undefined;
    const hidden = new Set(full.datasets.filter((d) => !activeIds.has(d.id)).map((d) => d.id));
    return hidden.size ? { hidden, colors: null } : null;
  }, [full, current, filtered, activeIds]);
  useEffect(() => {
    if (style !== undefined) activeHandleRef.current?.setDatasetStyle?.(active ? style : null);
  }, [style, active, renderer, activeHandleRef]);
  useEffect(() => () => { activeHandleRef.current?.setDatasetStyle?.(null); }, [renderer, activeHandleRef]);

  // Which datasets are on screen and big enough to be rendering (or about to).
  useEffect(() => {
    if (!active || !full) return;
    let last = '';
    const tick = () => {
      const ids = activeHandleRef.current?.datasetsInView?.(full.datasets, IN_VIEW_FRACTION) ?? [];
      const key = ids.join(',');
      if (key !== last) { last = key; setInView(ids); }
    };
    tick();
    const t = setInterval(tick, IN_VIEW_POLL_MS);
    return () => clearInterval(t);
  }, [active, full, renderer, activeHandleRef]);

  // World search: debounced, abortable, only from 3 characters (Photon fair use).
  useEffect(() => {
    setPlaces([]);
    const q = query.trim();
    if (q.length < 3) return;
    const ac = new AbortController();
    const t = setTimeout(() => { searchPlaces(q, ac.signal).then(setPlaces).catch(() => {}); }, 350);
    return () => { clearTimeout(t); ac.abort(); };
  }, [query]);

  // Close the dropdown on outside clicks.
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('pointerdown', onDown);
    return () => removeEventListener('pointerdown', onDown);
  }, []);

  const datasetHits = useMemo(() => (full ? searchDatasets(full.datasets, query) : []), [full, query]);
  const rows: Row[] = [
    ...datasetHits.map((d) => ({ kind: 'dataset' as const, d })),
    ...places.map((p) => ({ kind: 'place' as const, p })),
  ];

  // Formats present in THIS mosaic, with counts — the chips are derived, not hardcoded.
  const formatCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of full?.datasets ?? []) m.set(d.format, (m.get(d.format) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [full]);

  const providerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of full?.datasets ?? []) m.set(d.provider ?? '', (m.get(d.provider ?? '') ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [full]);
  const providerNames = useMemo(() => providerCounts.map(([p]) => p), [providerCounts]);

  // Year span of the dated datasets, for the timeline.
  const yearSpan = useMemo(() => {
    const dated = (full?.datasets ?? []).filter((d) => d.date);
    const ys = dated.flatMap((d) => dateSpan(d.date!)).map(Math.floor);
    if (!ys.length) return null;
    return { min: Math.min(...ys), max: Math.max(...ys), dated: dated.length };
  }, [full]);
  useEffect(() => {
    if (!yearSpan || !picker) { setYears(null); return; }
    setYears([picker.from ? +picker.from.slice(0, 4) : yearSpan.min, picker.to ? +picker.to.slice(0, 4) : yearSpan.max]);
  }, [yearSpan, picker]);

  // The in-view list, grouped by platform scene. A group lists ALL its datasets (overlapping
  // captures of one site are exactly what the picker is for), in date order.
  const groups = useMemo(() => {
    if (!full) return [];
    const byGroup = new Map<string, DatasetMarker[]>();
    for (const d of full.datasets) {
      const k = d.group ?? `id:${d.id}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k)!.push(d);
    }
    const seen = new Set<string>();
    const out: { key: string; title: string; items: DatasetMarker[] }[] = [];
    for (const id of inView) {
      const d = full.datasets.find((x) => x.id === id);
      if (!d) continue;
      const k = d.group ?? `id:${d.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const items = [...byGroup.get(k)!].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.name.localeCompare(b.name));
      out.push({ key: k, title: d.group ? (d.scene || d.project || d.name) : d.name, items });
    }
    return out;
  }, [full, inView]);

  // Credits for what is on screen — a mosaic mixes providers, and each one's attribution must be
  // shown while its data is visible (Aerometrex's previews, the national agencies' LiDAR …).
  const credits = useMemo(() => {
    if (!full) return [];
    const byId = new Map(full.datasets.map((d) => [d.id, d]));
    const seen = new Set<string>();
    for (const id of inView) {
      if (!activeIds.has(id)) continue;
      const d = byId.get(id);
      const c = d?.attribution || d?.provider;
      if (c) seen.add(c);
    }
    return [...seen];
  }, [full, inView, activeIds]);

  if (!active || !picker) return null;

  /**
   * Make `url` the mosaic's state. The renderer keeps (or gets) the UNFILTERED mosaic and hides what
   * `url` excludes itself, so a selection change never reloads; `reload` forces one (the tree changed).
   */
  function commit(url: string, reload = false) {
    const h = activeHandleRef.current;
    if (!h || url === lastLoadUrl) return;
    const st = useViewerStore.getState();
    const base = pickerBaseUrl(url);
    const inPlace = !reload && typeof h.setDatasetStyle === 'function'
      && loadedRef.current.renderer === renderer && loadedRef.current.url === base;
    selfUrlRef.current = url;
    st.setLastLoadUrl(url);
    st.setUrlField(url);
    if (inPlace) return;
    loadedRef.current = { renderer, url: base };
    // keep the camera where it is: the user is looking at what they are filtering
    h.load(base, st.currentType, { skipAutoFrame: true });
  }
  const apply = (next: PickerState) => commit(withPicker(lastLoadUrl, next));
  const patch = (p: Partial<PickerState>) => apply({ ...picker!, ...p });

  function toggleDataset(d: DatasetMarker, show: boolean) {
    const hide = new Set(picker!.hide);
    if (show) hide.delete(d.id); else hide.add(d.id);
    patch({ hide });
  }
  /**
   * "latest" hides the group's dated captures that ENDED before its newest one started — so a site
   * captured in one campaign (Venice, 12 datasets all 2021-06) keeps every piece; "all" shows all.
   * Undated datasets are left alone. Same rule as the server's &latest=1, minus the footprint test.
   */
  function groupMode(items: DatasetMarker[], mode: 'all' | 'latest') {
    const hide = new Set(picker!.hide);
    for (const d of items) hide.delete(d.id);
    if (mode === 'latest') {
      const dated = items.filter((d) => d.date);
      const newestStart = Math.max(...dated.map((d) => dateSpan(d.date!)[0]));
      for (const d of dated) if (dateSpan(d.date!)[1] < newestStart) hide.add(d.id);
    }
    patch({ hide });
  }
  function toggleFormat(f: string) {
    const all = formatCounts.map(([k]) => k);
    const cur = new Set(picker!.formats.length ? picker!.formats : all);
    if (cur.has(f)) cur.delete(f); else cur.add(f);
    if (!cur.size) return;                                           // never filter everything away
    patch({ formats: cur.size === all.length ? [] : all.filter((k) => cur.has(k)) });
  }

  function pick(row: Row) {
    const h = activeHandleRef.current;
    if (!h) return;
    if (row.kind === 'dataset') {
      const { lon, lat, height, radius } = row.d;
      if (h.flyToSphere) h.flyToSphere(lon, lat, height, radius);
      else h.flyToLocalFrame(lon, lat, height, Math.max(150, radius * 3));
      useViewerStore.getState().setStatus(`${row.d.name}${row.d.project ? ` — ${row.d.project}` : ''} [${row.d.format}]`);
    } else {
      h.flyToCity(row.p.lon, row.p.lat, heightForPlace(row.p));
    }
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter' && rows[cursor]) { e.preventDefault(); pick(rows[cursor]); }
    else if (e.key === 'Escape') setOpen(false);
  }

  const supportsMarkers = typeof activeHandleRef.current?.setDatasetMarkers === 'function';
  const bv = readBv(lastLoadUrl);
  const snap = readSnap(lastLoadUrl);
  const colorOf = (d: DatasetMarker) => colors.get(d.id) ?? MARKER_COLORS[d.format];
  const shownCount = filtered ? (current?.count ?? '…') : full?.count;
  const reasonOf = (d: DatasetMarker) => (picker.hide.has(d.id) ? 'hidden'
    : picker.formats.length && !picker.formats.includes(d.format) ? 'format filter'
    : picker.latest ? 'superseded by a newer capture (latest only)' : 'outside the date range');

  return (
    <div ref={boxRef} data-testid="aggregate-search" className="absolute top-2 left-2 z-20 w-[380px] max-w-[calc(100%-1rem)] rounded-lg border bg-background/90 p-2 shadow-lg backdrop-blur">
      <Input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={full ? `Search ${full.count} datasets or any place…` : 'Loading datasets…'}
        className="h-8 text-sm"
      />
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={showMarkers} onCheckedChange={(v) => setShowMarkers(v === true)} disabled={!supportsMarkers} />
          markers
        </label>
        <span className="min-w-0 flex-1 truncate">
          {error ? <span className="text-destructive">{error}</span>
            : full ? `${shownCount}/${full.count} shown${full.unplaced.length ? ` · ${full.unplaced.length} unplaced` : ''}${full.failed.length ? ` · ${full.failed.length} failed` : ''}`
            : '…'}
        </span>
        <button type="button" data-testid="picker-toggle" onClick={() => setPanel((v) => !v)}
          className={`shrink-0 rounded border px-1.5 py-0.5 ${panel ? 'bg-accent text-foreground' : ''}`}>
          in view {inView.length} {panel ? '▴' : '▾'}
        </button>
      </div>

      {credits.length > 0 && (
        <div data-testid="credits" className="mt-1 text-[10px] leading-snug text-muted-foreground" title="Attribution of the datasets on screen">
          Data: {credits.join(' · ')}
        </div>
      )}
      {open && query.trim() && (
        <div className="mt-2 max-h-[360px] overflow-y-auto rounded-md border bg-popover text-sm">
          {datasetHits.length > 0 && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">Datasets</div>}
          {rows.map((row, i) => {
            const first = row.kind === 'place' && (i === 0 || rows[i - 1].kind !== 'place');
            return (
              <div key={row.kind === 'dataset' ? row.d.id : `${row.p.lon},${row.p.lat},${i}`}>
                {first && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">Places</div>}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                  className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${i === cursor ? 'bg-accent' : ''}`}
                >
                  {row.kind === 'dataset' ? (
                    <>
                      <span className="mt-1.5"><Dot color={colorOf(row.d)} dim={!activeIds.has(row.d.id)} /></span>
                      <span className="min-w-0">
                        <span className="block truncate">{row.d.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[row.d.project, row.d.format, row.d.date, !activeIds.has(row.d.id) && 'not shown'].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mt-0.5 shrink-0 text-xs">📍</span>
                      <span className="min-w-0">
                        <span className="block truncate">{row.p.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">{row.p.detail}</span>
                      </span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
          {rows.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No match{query.trim().length < 3 ? ' — type 3+ characters to search places' : ''}</div>}
          {places.length > 0 && <div className="border-t px-2 py-1 text-[10px] text-muted-foreground">Places: © OpenStreetMap contributors · Photon by komoot</div>}
        </div>
      )}

      {panel && full && (
        <div data-testid="picker" className="mt-2 space-y-2 rounded-md border bg-popover p-2 text-xs">
          {/* filters — each one is a server-side selection param */}
          <div className="flex flex-wrap items-center gap-1">
            {formatCounts.map(([f, n]) => {
              const on = !picker.formats.length || picker.formats.includes(f);
              return (
                <button key={f} type="button" onClick={() => toggleFormat(f)} title={on ? `hide ${f}` : `show ${f}`}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${on ? 'bg-accent' : 'opacity-50'}`}>
                  <Dot color={MARKER_COLORS[f]} dim={!on} />{f} <span className="text-muted-foreground">{n}</span>
                </button>
              );
            })}
            <label className="ml-auto flex items-center gap-1.5" title="Among datasets covering the same ground at different dates, keep only the newest">
              <Checkbox checked={picker.latest} onCheckedChange={(v) => patch({ latest: v === true })} />
              latest only
            </label>
          </div>
          {providerCounts.length > 1 && (
            <div className="flex flex-wrap items-center gap-1" title="Show or hide the markers of a provider's datasets (not the datasets)">
              <span className="text-muted-foreground">markers</span>
              {providerCounts.map(([p, n]) => {
                const on = !mutedProviders.has(p);
                return (
                  <button key={p || '-'} type="button"
                    onClick={() => setMutedProviders((m) => { const x = new Set(m); if (on) x.add(p); else x.delete(p); return x; })}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${on ? 'bg-accent' : 'opacity-50'}`}>
                    <Dot color={colorMode === 'provider' ? providerColor(p, providerNames) : undefined} dim={!on} />
                    {p || 'unknown'} <span className="text-muted-foreground">{n}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">colour</span>
              <Segmented value={colorMode} options={['format', 'provider', 'dataset'] as const} onChange={setColorMode}
                title="Colour the markers by format, provider or dataset" />
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">bounds</span>
              <Segmented value={bv} options={BV_MODES} onChange={(v: BvMode) => commit(withBv(lastLoadUrl, v), true)} title={BV_HELP} />
            </span>
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">snap</span>
              <Segmented value={snap ? 'ground' : 'off'} options={['off', 'ground'] as const}
                onChange={(v) => commit(withSnap(lastLoadUrl, v === 'ground' ? terrainMode : null), true)}
                title="Put every dataset on the terrain, each with its own vertical offset (server-side, from its own geometry against Mapterhorn)" />
            </span>
          </div>
          {yearSpan && years && yearSpan.max > yearSpan.min && (
            <div>
              <div className="mb-1 flex justify-between text-muted-foreground">
                <span>capture date <b className="text-foreground">{years[0]} – {years[1]}</b></span>
                <span>{yearSpan.dated} dated · undated always shown</span>
              </div>
              <Slider min={yearSpan.min} max={yearSpan.max} step={1} value={years}
                onValueChange={setYears}
                onValueCommit={([lo, hi]) => patch({
                  from: lo > yearSpan.min ? String(lo) : '',
                  to: hi < yearSpan.max ? String(hi) : '',
                })} />
            </div>
          )}
          {filtered && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>{picker.hide.size ? `${picker.hide.size} hidden by hand` : 'filters active'}</span>
              <button type="button" className="underline" onClick={() => apply({ hide: new Set(), latest: false, from: '', to: '', formats: [] })}>reset all</button>
            </div>
          )}

          {/* what is on screen, by site */}
          <div className="max-h-[300px] space-y-1.5 overflow-y-auto border-t pt-1.5">
            {groups.length === 0 && <div className="text-muted-foreground">Nothing large enough on screen — zoom towards a marker.</div>}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-1.5 font-medium">
                  <span className="min-w-0 flex-1 truncate" title={g.title}>{g.title}</span>
                  {g.items.length > 1 && (
                    <>
                      <button type="button" className="rounded border px-1 font-normal" onClick={() => groupMode(g.items, 'all')}
                        title="Show every dataset of this site (pieces of one site, e.g. an airborne scan with detail captures)">all</button>
                      <button type="button" className="rounded border px-1 font-normal" onClick={() => groupMode(g.items, 'latest')}
                        title="Show only the newest dated capture of this site (a diachronic series)">latest</button>
                    </>
                  )}
                </div>
                {g.items.map((d) => {
                  const on = activeIds.has(d.id);
                  const lockedOff = !on && !picker.hide.has(d.id);
                  return (
                    <label key={d.id} className={`flex items-center gap-1.5 py-0.5 pl-1 ${lockedOff ? 'opacity-50' : ''}`}
                      title={(on ? d.name : `${d.name} — ${reasonOf(d)}`) + cellLabel(d)
                        + (d.snap?.dz != null ? ` · snapped ${d.snap.dz} m` : '')}>
                      <Checkbox checked={on} disabled={lockedOff} onCheckedChange={(v) => toggleDataset(d, v === true)} />
                      <Dot color={colorOf(d)} dim={!on} />
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      <span className="shrink-0 text-muted-foreground">{d.date ? d.date.replace(/-\d\d(?=\/|$)/g, '').replace('/', '→') : '—'}</span>
                      <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" title="fly to"
                        onClick={(e) => { e.preventDefault(); pick({ kind: 'dataset', d }); }}>↗</button>
                      <a className="shrink-0 text-muted-foreground hover:text-foreground" title={`${externalViewerUrl(d).label} (new tab)`}
                        href={externalViewerUrl(d).href} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>⧉</a>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

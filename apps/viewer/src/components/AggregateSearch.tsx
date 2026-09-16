/**
 * Search + "there is data here" markers for /aggregate mosaics.
 *
 * Shown only while an /aggregate tileset is the loaded one. On load it fetches the mosaic's
 * index.json (same query → same selection) and hands the rows to the active renderer as markers.
 * The search box matches those rows locally as you type, and also queries the world through Photon
 * (OpenStreetMap) so you can jump to a place that has no dataset yet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import {
  fetchAggregateIndex, heightForPlace, isAggregateUrl, searchDatasets, searchPlaces,
  type AggregateIndex, type DatasetMarker, type Place,
} from '@/lib/aggregate';

const FORMAT_DOT: Record<string, string> = { potree: '#f59e0b', copc: '#38bdf8', '3dtiles': '#a78bfa' };

type Row = { kind: 'dataset'; d: DatasetMarker } | { kind: 'place'; p: Place };

export default function AggregateSearch({ activeHandleRef, renderer }: {
  activeHandleRef: React.RefObject<ViewerHandle | null>;
  renderer: string;
}) {
  const lastLoadUrl = useViewerStore((s) => s.lastLoadUrl);
  const active = isAggregateUrl(lastLoadUrl);
  const [index, setIndex] = useState<AggregateIndex | null>(null);
  const [error, setError] = useState('');
  const [showMarkers, setShowMarkers] = useState(true);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Load the index whenever a (different) mosaic is loaded; clear everything when something else is.
  useEffect(() => {
    setIndex(null); setError(''); setQuery(''); setPlaces([]);
    if (!active) return;
    const ac = new AbortController();
    fetchAggregateIndex(lastLoadUrl, ac.signal).then(setIndex).catch((e) => { if (!ac.signal.aborted) setError(String(e.message || e)); });
    return () => ac.abort();
  }, [lastLoadUrl, active]);

  // Push markers to the renderer. Re-run on renderer switch: the handle behind the ref changes.
  useEffect(() => {
    const h = activeHandleRef.current;
    h?.setDatasetMarkers?.(active && showMarkers && index ? index.datasets : null);
    return () => { activeHandleRef.current?.setDatasetMarkers?.(null); };
  }, [index, showMarkers, active, renderer, activeHandleRef]);

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

  const datasetHits = useMemo(() => (index ? searchDatasets(index.datasets, query) : []), [index, query]);
  const rows: Row[] = [
    ...datasetHits.map((d) => ({ kind: 'dataset' as const, d })),
    ...places.map((p) => ({ kind: 'place' as const, p })),
  ];

  if (!active) return null;

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

  return (
    <div ref={boxRef} className="absolute top-2 left-2 z-20 w-[360px] max-w-[calc(100%-1rem)] rounded-lg border bg-background/90 p-2 shadow-lg backdrop-blur">
      <Input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={index ? `Search ${index.count} datasets or any place…` : 'Loading datasets…'}
        className="h-8 text-sm"
      />
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Checkbox checked={showMarkers} onCheckedChange={(v) => setShowMarkers(v === true)} disabled={!supportsMarkers} />
          markers
        </label>
        <span className="truncate">
          {error ? <span className="text-destructive">{error}</span>
            : index ? `${index.count} placed${index.unplaced.length ? ` · ${index.unplaced.length} without georeference` : ''}${index.failed.length ? ` · ${index.failed.length} failed` : ''}`
            : '…'}
          {!supportsMarkers && ' · markers: Cesium only'}
        </span>
      </div>
      {open && query.trim() && (
        <div className="mt-2 max-h-[360px] overflow-y-auto rounded-md border bg-popover text-sm">
          {datasetHits.length > 0 && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">Datasets</div>}
          {rows.map((row, i) => {
            const first = row.kind === 'place' && (i === 0 || rows[i - 1].kind !== 'place');
            return (
              <div key={row.kind === 'dataset' ? row.d.url : `${row.p.lon},${row.p.lat},${i}`}>
                {first && <div className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">Places</div>}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(row)}
                  className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${i === cursor ? 'bg-accent' : ''}`}
                >
                  {row.kind === 'dataset' ? (
                    <>
                      <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: FORMAT_DOT[row.d.format] ?? '#94a3b8' }} />
                      <span className="min-w-0">
                        <span className="block truncate">{row.d.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[row.d.project, row.d.format].filter(Boolean).join(' · ')}
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
    </div>
  );
}

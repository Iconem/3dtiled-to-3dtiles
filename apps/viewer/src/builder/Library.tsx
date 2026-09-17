/**
 * Library: the datasets a mosaic can be built from — a server set, an imported selection, or URLs
 * added by hand — searchable, filterable by format, groupable, and dragged (or "added") into the tree.
 *
 * Sets reach ~700 rows (iconem), so the list is windowed: only the rows in view are mounted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { searchDatasets, type AggregateIndex } from '@/lib/aggregate';
import { MARKER_COLORS } from '@/components/Viewport/DatasetTooltip';
import { cn } from '@/lib/utils';
import { fetchIndexUrl, fetchSetRows, fetchSets, resolveUrl, type SetInfo } from './api';
import { addGroup, insertRows, leaves, type Row } from './tree';
import { endDrag, startDrag } from './dnd';
import { insertionTarget, useBuilder } from './store';

export const Dot = ({ format, className }: { format: string; className?: string }) => (
  <span className={cn('size-2 shrink-0 rounded-full', className)} style={{ background: MARKER_COLORS[format] ?? '#94a3b8' }} title={format} />
);

export const fmtRadius = (r: number) => (r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${Math.round(r)} m`);

type GroupKey = 'none' | 'project' | 'scene';
type Item = { kind: 'header'; key: string; label: string; rows: Row[] } | { kind: 'row'; row: Row };
const HEADER_H = 28;
const ROW_H = 42;

interface Loaded { rows: Row[]; error?: string; loading?: boolean; note?: string }

function useSets() {
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { fetchSets().then(setSets).catch((e) => setError(String(e.message || e))); }, []);
  return { sets, error };
}

export default function Library({ importUrl }: { importUrl: string | null }) {
  const { sets, error: setsError } = useSets();
  const customRows = useBuilder((s) => s.customRows);
  const urlErrors = useBuilder((s) => s.urlErrors);
  const tree = useBuilder((s) => s.tree);
  const [source, setSource] = useState(importUrl ? 'import' : 'set:angkor');
  const [cache, setCache] = useState<Record<string, Loaded>>({});
  const [reloadTick, setReloadTick] = useState(0);
  const [query, setQuery] = useState('');
  const [formats, setFormats] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<GroupKey>('none');
  // Selection lives in a ref (read by drag start, which can fire before React re-renders after a
  // click) and is mirrored into state for rendering.
  const selRef = useRef<Set<string>>(new Set());
  const [selected, setSelectedState] = useState<Set<string>>(selRef.current);
  const setSelected = (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    selRef.current = typeof v === 'function' ? v(selRef.current) : v;
    setSelectedState(selRef.current);
  };
  const anchor = useRef<string | null>(null);

  // Load the chosen source once (and again on refresh). An aborted load leaves `loading` set, so it
  // counts as not loaded and is fetched again next time.
  const lastTick = useRef(0);
  useEffect(() => {
    if (source === 'custom') return;
    const key = source;
    const force = reloadTick !== lastTick.current;
    lastTick.current = reloadTick;
    if (cache[key] && !cache[key].error && !cache[key].loading && !force) return;
    const ac = new AbortController();
    setCache((c) => ({ ...c, [key]: { rows: c[key]?.rows ?? [], loading: true } }));
    const p: Promise<AggregateIndex> = key === 'import' ? fetchIndexUrl(importUrl!, ac.signal) : fetchSetRows(key.slice(4), ac.signal);
    p.then((idx) => {
      const skipped = (idx.unplaced?.length ?? 0) + (idx.failed?.length ?? 0);
      setCache((c) => ({ ...c, [key]: { rows: idx.datasets as Row[], note: skipped ? `${idx.unplaced.length} unplaced, ${idx.failed.length} failed — not listed` : undefined } }));
    }).catch((e) => {
      if (!ac.signal.aborted) setCache((c) => ({ ...c, [key]: { rows: [], error: String(e.message || e) } }));
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, reloadTick, importUrl]);

  useEffect(() => { setSelected(new Set()); anchor.current = null; setFormats([]); }, [source]);

  const loaded: Loaded = source === 'custom' ? { rows: customRows } : cache[source] ?? { rows: [], loading: true };
  const rows = loaded.rows;

  const inTree = useMemo(() => {
    const s = new Set<string>();
    for (const l of leaves(tree)) { s.add(l.url); if (l.sourceId) s.add(l.sourceId); }
    return s;
  }, [tree]);

  const formatCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.format, (m.get(r.format) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const byFormat = formats.length ? rows.filter((r) => formats.includes(r.format)) : rows;
    return query.trim() ? (searchDatasets(byFormat as any, query, byFormat.length) as Row[]) : byFormat;
  }, [rows, formats, query]);

  const items = useMemo<Item[]>(() => {
    if (groupBy === 'none') return filtered.map((row) => ({ kind: 'row', row }));
    const buckets = new Map<string, Row[]>();
    for (const r of filtered) {
      const k = (r[groupBy] ?? '').trim();
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(r);
    }
    const keys = [...buckets.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    return keys.flatMap((k) => [
      { kind: 'header' as const, key: k, label: k || `(no ${groupBy})`, rows: buckets.get(k)! },
      ...buckets.get(k)!.map((row) => ({ kind: 'row' as const, row })),
    ]);
  }, [filtered, groupBy]);

  const flatRows = useMemo(() => items.flatMap((it) => (it.kind === 'row' ? [it.row] : [])), [items]);

  function clickRow(e: React.MouseEvent, r: Row) {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const toggle = !e.shiftKey && (e.ctrlKey || e.metaKey);
    const from = e.shiftKey ? anchor.current : null;
    if (!from) anchor.current = r.id;
    // Functional update: two clicks in one task must not both start from the same stale set.
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      const a = from ? flatRows.findIndex((x) => x.id === from) : -1, b = flatRows.findIndex((x) => x.id === r.id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(flatRows[i].id);
      else if (toggle && next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
  }

  const selectedRows = flatRows.filter((r) => selected.has(r.id));
  const focus = useBuilder((s) => s.focus);
  const target = insertionTarget(tree, focus);

  function addRows(list: Row[], asGroup?: string) {
    if (!list.length) return;
    const st = useBuilder.getState();
    let t = st.tree, parent = insertionTarget(t, st.focus);
    if (asGroup) {
      const made = addGroup(t, parent, undefined, asGroup);
      t = made.tree;
      parent = made.id;
    }
    const { tree: next, ids } = insertRows(t, parent, undefined, list);
    st.commit(next, { select: asGroup ? [parent] : ids });
    st.setStatus(`Added ${list.length} dataset${list.length > 1 ? 's' : ''} to “${next.nodes[parent].name}”.`);
  }

  function dragRows(e: React.DragEvent, r: Row | Row[]) {
    const sel = selRef.current;
    const list = Array.isArray(r) ? r : sel.has(r.id) ? flatRows.filter((x) => sel.has(x.id)) : [r];
    startDrag(e, { kind: 'rows', rows: list });
  }

  // `?import=` selection first, then the server's sets; "custom" collects rows added by URL.
  const allSources = [
    ...(importUrl ? [{ value: 'import', label: 'Imported selection' }] : []),
    ...sets.map((s) => ({ value: `set:${s.name}`, label: `${s.name} — ${s.count}${s.local ? ' · local' : ''}` })),
    { value: 'custom', label: `Added by URL — ${customRows.length}` },
  ];

  return (
    <section className="flex min-h-0 flex-col border-r" data-testid="library">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center gap-1.5">
          <h2 className="mr-auto text-xs font-semibold tracking-wide text-muted-foreground uppercase">Library</h2>
          {loaded.loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Button size="icon" variant="ghost" className="size-7" title="Reload this source" onClick={() => setReloadTick((n) => n + 1)} disabled={source === 'custom'}>
            <RefreshCw />
          </Button>
        </div>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="w-full text-xs" data-testid="source-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            {allSources.map((s) => <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {setsError && <p className="text-xs text-destructive">Sets unavailable: {setsError}</p>}
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${rows.length} datasets…`} className="h-7 pl-7 text-xs" data-testid="library-search" />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {formatCounts.map(([f, n]) => {
            const on = !formats.length || formats.includes(f);
            return (
              <button key={f} type="button"
                onClick={() => setFormats((cur) => {
                  const all = formatCounts.map(([k]) => k);
                  const s = new Set(cur.length ? cur : all);
                  if (s.has(f)) s.delete(f); else s.add(f);
                  return s.size === all.length || !s.size ? [] : all.filter((k) => s.has(k));
                })}
                className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', on ? 'bg-accent' : 'opacity-50')}>
                <Dot format={f} />{f} <span className="text-muted-foreground">{n}</span>
              </button>
            );
          })}
          <ToggleGroup type="single" size="sm" value={groupBy} onValueChange={(v) => v && setGroupBy(v as GroupKey)} className="ml-auto" title="Group the list">
            {(['none', 'project', 'scene'] as const).map((g) => (
              <ToggleGroupItem key={g} value={g} className="h-6 px-1.5 text-[11px]">{g === 'none' ? 'flat' : g}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {loaded.error && (
        <div className="m-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <TriangleAlert className="size-4 shrink-0" />{loaded.error}
        </div>
      )}
      {loaded.note && <div className="px-2 pt-1 text-[11px] text-muted-foreground">{loaded.note}</div>}

      <VirtualList
        items={items}
        render={(it) => it.kind === 'header' ? (
          <div
            draggable
            onDragStart={(e) => dragRows(e, it.rows)}
            onDragEnd={endDrag}
            onClick={() => { setSelected(new Set(it.rows.map((r) => r.id))); anchor.current = it.rows[0]?.id ?? null; }}
            className="group flex h-full cursor-pointer items-center gap-1.5 border-b bg-muted/40 px-2 text-[11px] font-medium"
            title="Click to select all · drag to add all"
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            <span className="text-muted-foreground">{it.rows.length}</span>
            <button type="button" className="invisible rounded border px-1 font-normal group-hover:visible" title="Add all as a new group"
              onClick={(e) => { e.stopPropagation(); addRows(it.rows, it.label); }}>+ group</button>
          </div>
        ) : (
          <div
            draggable
            data-testid="library-row"
            data-id={it.row.id}
            onDragStart={(e) => dragRows(e, it.row)}
            onDragEnd={endDrag}
            onClick={(e) => clickRow(e, it.row)}
            onDoubleClick={() => addRows([it.row])}
            className={cn('flex h-full cursor-grab items-center gap-2 border-b border-border/40 px-2 select-none active:cursor-grabbing',
              selected.has(it.row.id) ? 'bg-sky-500/20' : 'hover:bg-accent/60')}
            title={`${it.row.name}\n${it.row.url}\nDouble-click to add`}
          >
            <Dot format={it.row.format} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs">{it.row.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {[it.row.project, it.row.scene, it.row.date?.replace('/', ' → '), fmtRadius(it.row.radius)].filter(Boolean).join(' · ')}
              </div>
            </div>
            {(inTree.has(it.row.id) || inTree.has(it.row.url)) && <span className="text-[10px] text-emerald-400" title="Already in the tree">✓</span>}
          </div>
        )}
      />

      <div className="space-y-2 border-t p-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{selected.size ? `${selected.size} selected` : `${filtered.length} shown`}</span>
          <Button size="sm" className="ml-auto h-7" disabled={!selectedRows.length} onClick={() => addRows(selectedRows)} data-testid="add-selected"
            title="Add the selected datasets to the focused group (non drag-and-drop alternative)">
            <Plus />Add to “{tree.nodes[target]?.name}”
          </Button>
        </div>
        <AddUrl onAdded={() => setSource('custom')} />
        {urlErrors.map((e) => (
          <div key={e.url} className="flex gap-1.5 rounded border border-destructive/40 bg-destructive/10 p-1.5 text-[11px] text-destructive" data-testid="url-error">
            <TriangleAlert className="size-3.5 shrink-0" />
            <span className="min-w-0 break-all"><b>{e.error}</b><br />{e.url}</span>
            <button type="button" className="ml-auto shrink-0" title="Dismiss"
              onClick={() => useBuilder.getState().setUrlErrors(useBuilder.getState().urlErrors.filter((x) => x !== e))}>×</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddUrl({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [proxy, setProxy] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add() {
    const raw = url.trim();
    if (!raw) return;
    setBusy(true);
    const st = useBuilder.getState();
    try {
      const row = await resolveUrl(raw, { proxy });
      st.addCustomRow(row);
      st.setUrlErrors(st.urlErrors.filter((e) => e.url !== raw));
      st.setStatus(`Resolved “${row.name}” (${row.format}, ${fmtRadius(row.radius)}) — in “Added by URL”.`);
      setUrl('');
      onAdded();
    } catch (e) {
      st.setUrlErrors([...st.urlErrors.filter((x) => x.url !== raw), { url: raw, error: String((e as Error).message || e) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Add URL: tileset.json · cloud.js · metadata.json · .copc.laz" className="h-7 text-xs" data-testid="add-url" />
        <Button size="sm" variant="outline" className="h-7" onClick={add} disabled={busy || !url.trim()} data-testid="add-url-btn">
          {busy ? <Loader2 className="animate-spin" /> : 'Add'}
        </Button>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title="For 3D Tiles hosts that send no CORS headers: route the whole tileset through the tile-server's /proxy">
        <Checkbox checked={proxy} onCheckedChange={(v) => setProxy(v === true)} className="size-3.5" />
        via /proxy (host without CORS)
      </label>
    </div>
  );
}

/** Fixed-height windowing: offsets are a prefix sum, the first visible item a binary search. */
function VirtualList({ items, render }: { items: Item[]; render: (it: Item) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const offsets = useMemo(() => {
    const o = new Float64Array(items.length + 1);
    items.forEach((it, i) => { o[i + 1] = o[i] + (it.kind === 'header' ? HEADER_H : ROW_H); });
    return o;
  }, [items]);
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] <= scroll) lo = mid + 1; else hi = mid; }
  const start = Math.max(0, lo - 5);
  let end = lo;
  while (end < items.length && offsets[end] < scroll + height) end++;
  end = Math.min(items.length, end + 5);
  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: offsets[items.length] }} />
      {items.slice(start, end).map((it, k) => {
        const i = start + k;
        return (
          <div key={it.kind === 'header' ? `h:${it.key}` : it.row.id} className="absolute inset-x-0" style={{ top: offsets[i], height: offsets[i + 1] - offsets[i] }}>
            {render(it)}
          </div>
        );
      })}
      {!items.length && <div className="absolute inset-x-0 top-4 text-center text-xs text-muted-foreground">No datasets</div>}
    </div>
  );
}

/**
 * Library: the datasets a mosaic can be built from. Several sources at once (server sets, an
 * imported selection, URLs added by hand), merged and de-duplicated by row id. Search, a free-text
 * tag filter, and chips for format / provider / set narrow the list; it can be grouped; rows are
 * dragged (or "added") into the tree.
 *
 * Scale: iconem + world + flai is ~820 rows. The list is windowed (only rows in view are mounted),
 * search and tag input are debounced, and the pipeline is split into memoised stages so a chip click
 * does not re-run the fuzzy search. `window.__builderLibPerf` exposes the last stage timings.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, RotateCw, Search, Tag, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { searchDatasets, type AggregateIndex } from '@/lib/aggregate';
import { MARKER_COLORS } from '@/components/Viewport/DatasetTooltip';
import { cn } from '@/lib/utils';
import { fetchIndexUrl, fetchSetRows, fetchSets, resolveUrl, type SetInfo } from './api';
import { addGroup, insertRows, type Row, type Tree } from './tree';
import { endDrag, startDrag } from './dnd';
import { insertionTarget, useBuilder } from './store';

export const Dot = ({ format, className }: { format: string; className?: string }) => (
  <span className={cn('size-2 shrink-0 rounded-full', className)} style={{ background: MARKER_COLORS[format] ?? '#94a3b8' }} title={format} />
);

export const fmtRadius = (r: number) => (r >= 1000 ? `${(r / 1000).toFixed(1)} km` : `${Math.round(r)} m`);

type GroupKey = 'none' | 'project' | 'scene' | 'provider' | 'set';
type Item = { kind: 'header'; key: string; label: string; rows: Row[] } | { kind: 'row'; row: Row };
type Dim = 'format' | 'provider' | 'set';
const HEADER_H = 28;
const ROW_H = 42;
const PREFS_KEY = 'aggregate-builder:library';
const CHIPS_COLLAPSED = 8;

interface Loaded { rows: Row[]; error?: string; loading?: boolean; note?: string; ms?: number }

/** What the library remembers between visits. Source keys: `set:<name>`, `import`, `custom`. */
interface Prefs {
  sources: string[];
  formats: string[];
  providers: string[];
  sets: string[];
  tag: string;
  groupBy: GroupKey;
  sourcesOpen: boolean;
}

function readPrefs(): Partial<Prefs> | null {
  try { const j = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null'); return j && typeof j === 'object' ? j : null; }
  catch { return null; }
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    // Clearing applies at once: an emptied box should not leave a stale filter for a beat.
    if (value === '' as unknown) { setV(value); return; }
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type SetsState = { status: 'loading' | 'ok' | 'error'; sets: SetInfo[]; error?: string };

function useSets(): SetsState {
  const [s, setS] = useState<SetsState>({ status: 'loading', sets: [] });
  useEffect(() => {
    fetchSets().then((sets) => setS({ status: 'ok', sets })).catch((e) => setS({ status: 'error', sets: [], error: String(e.message || e) }));
  }, []);
  return s;
}

const leafKeys = (t: Tree) => {
  const s = new Set<string>();
  for (const n of Object.values(t.nodes)) if (n.kind === 'dataset') { s.add(n.url); if (n.sourceId) s.add(n.sourceId); }
  return s;
};

/**
 * The ✓ marks: which rows are already in the tree. Kept outside the render path and only replaced
 * when its contents change, so renaming a node does not re-render the library.
 */
function useInTree(): Set<string> {
  const [keys, setKeys] = useState(() => leafKeys(useBuilder.getState().tree));
  useEffect(() => useBuilder.subscribe((s, prev) => {
    if (s.tree === prev.tree) return;
    const next = leafKeys(s.tree);
    setKeys((cur) => (cur.size === next.size && [...next].every((k) => cur.has(k)) ? cur : next));
  }), []);
  return keys;
}

const perf = { mergeMs: 0, searchMs: 0, tagMs: 0, facetMs: 0, groupMs: 0, rows: 0, shown: 0, loads: {} as Record<string, number> };
(globalThis as any).__builderLibPerf = perf;

export default function Library({ importUrl }: { importUrl: string | null }) {
  const setsState = useSets();
  const { sets } = setsState;
  const customRows = useBuilder((s) => s.customRows);
  const urlErrors = useBuilder((s) => s.urlErrors);

  const saved = useRef(readPrefs()).current;
  const [sources, setSources] = useState<string[]>(() => importUrl ? ['import'] : strs(saved?.sources));
  const [formats, setFormats] = useState<string[]>(() => strs(saved?.formats));
  const [providers, setProviders] = useState<string[]>(() => strs(saved?.providers));
  const [setFilter, setSetFilter] = useState<string[]>(() => strs(saved?.sets));
  const [tag, setTag] = useState(() => (typeof saved?.tag === 'string' ? saved.tag : ''));
  const [groupBy, setGroupBy] = useState<GroupKey>(() => saved?.groupBy ?? 'none');
  const [sourcesOpen, setSourcesOpen] = useState(() => saved?.sourcesOpen ?? true);
  const [query, setQuery] = useState('');
  const dQuery = useDebounced(query.trim(), 120);
  const dTag = useDebounced(tag.trim(), 120);

  useEffect(() => {
    const p: Prefs = { sources: sources.filter((k) => k !== 'import'), formats, providers, sets: setFilter, tag, groupBy, sourcesOpen };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode: not remembered */ }
  }, [sources, formats, providers, setFilter, tag, groupBy, sourcesOpen]);

  // Once the server's sets are known: drop remembered sets it no longer has (never load a missing
  // `angkor`), and when no set is left, default to `world`, else the first set.
  useEffect(() => {
    if (setsState.status !== 'ok') return;
    setSources((cur) => {
      const names = new Set(sets.map((s) => `set:${s.name}`));
      const valid = cur.filter((k) => k === 'custom' || (k === 'import' && importUrl) || names.has(k));
      const hasData = valid.some((k) => k !== 'custom');
      const userChoseNone = !!saved && strs(saved.sources).length > 0 && valid.length === strs(saved.sources).length;
      if (hasData || userChoseNone || !sets.length) return valid.length === cur.length ? cur : valid;
      const def = sets.find((s) => s.name === 'world') ?? sets[0];
      return [...valid, `set:${def.name}`];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setsState.status]);

  // Selection lives in a ref (read by drag start, which can fire before React re-renders after a
  // click) and is mirrored into state for rendering.
  const selRef = useRef<Set<string>>(new Set());
  const [selected, setSelectedState] = useState<Set<string>>(selRef.current);
  const setSelected = useCallback((v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    selRef.current = typeof v === 'function' ? v(selRef.current) : v;
    setSelectedState(selRef.current);
  }, []);
  const anchor = useRef<string | null>(null);

  // ── loading: every chosen source, concurrently, each once (again on reload) ──
  const [cache, setCache] = useState<Record<string, Loaded>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inflight = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const ac of inflight.current.values()) ac.abort(); }, []);

  const load = useCallback((key: string, force = false) => {
    if (key === 'custom') return;
    const cur = cacheRef.current[key];
    if (!force && (inflight.current.has(key) || (cur && !cur.error))) return;
    inflight.current.get(key)?.abort();
    const ac = new AbortController();
    inflight.current.set(key, ac);
    const t0 = performance.now();
    setCache((c) => ({ ...c, [key]: { rows: c[key]?.rows ?? [], loading: true } }));
    const p: Promise<AggregateIndex> = key === 'import' ? fetchIndexUrl(importUrl!, ac.signal) : fetchSetRows(key.slice(4), ac.signal);
    p.then((idx) => {
      const unplaced = idx.unplaced?.length ?? 0, failed = idx.failed?.length ?? 0;
      const note = unplaced + failed ? `${unplaced} unplaced, ${failed} failed — not listed` : undefined;
      const ms = Math.round(performance.now() - t0);
      perf.loads[key] = ms;
      setCache((c) => ({ ...c, [key]: { rows: idx.datasets as Row[], note, ms } }));
    }).catch((e) => {
      if (!ac.signal.aborted) setCache((c) => ({ ...c, [key]: { rows: [], error: String(e.message || e) } }));
    }).finally(() => {
      if (inflight.current.get(key) === ac) inflight.current.delete(key);
    });
  }, [importUrl]);

  // Filtered in render too: the effect above corrects `sources` one render late, and the load effect
  // below must not fetch a remembered set in between. If demo.json failed, remembered sets are tried
  // (and fail visibly, per set).
  const active = useMemo(() => {
    const known = setsState.status === 'ok' ? new Set(sets.map((s) => `set:${s.name}`)) : null;
    return sources.filter((k) => (k === 'import' ? !!importUrl : k === 'custom' || !known || known.has(k)));
  }, [sources, importUrl, setsState.status, sets]);
  // Wait for demo.json before loading remembered sets, so a set the server dropped is never asked for.
  const ready = setsState.status !== 'loading' || !!importUrl;
  useEffect(() => { if (ready) for (const k of active) load(k); }, [ready, active, load]);

  const toggleSource = (key: string, on: boolean) =>
    setSources((cur) => (on ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter((k) => k !== key)));

  const sourceLabel = (key: string) => (key === 'import' ? 'import' : key === 'custom' ? 'by URL' : key.slice(4));

  // ── pipeline: merge → search → tag → facets (chips) → grouping ──
  const merged = useMemo(() => {
    const t0 = performance.now();
    const rows: Row[] = [];
    const member = new Map<string, string[]>();
    for (const k of active) {
      const list = k === 'custom' ? customRows : cache[k]?.rows ?? [];
      const label = sourceLabel(k);
      for (const r of list) {
        const m = member.get(r.id);
        if (m) { if (!m.includes(label)) m.push(label); continue; }
        member.set(r.id, [label]);
        rows.push(r);
      }
    }
    perf.mergeMs = performance.now() - t0;
    perf.rows = rows.length;
    return { rows, member };
  }, [active, cache, customRows]);
  const { rows, member } = merged;

  // The fuzzy search is the one costly stage (tens of ms on ~800 rows): results are cached per query
  // for the current rows, so backspacing or re-typing a query is free.
  const searchCache = useMemo(() => new Map<string, Row[]>(), [rows]);
  const searched = useMemo(() => {
    const t0 = performance.now();
    let out = dQuery ? searchCache.get(dQuery) : rows;
    if (!out) {
      out = searchDatasets(rows as any, dQuery, rows.length) as Row[];
      if (searchCache.size > 50) searchCache.clear();
      searchCache.set(dQuery, out);
      // Recorded only when the search ran (dev StrictMode calls this twice; the 2nd is a cache hit).
      perf.searchMs = performance.now() - t0;
    }
    return out;
  }, [rows, dQuery, searchCache]);

  // The tag filter's haystack, folded once per row object.
  const hay = useMemo(() => new WeakMap<Row, string>(), [member]);
  const tagged = useMemo(() => {
    const t0 = performance.now();
    const terms = fold(dTag).split(/\s+/).filter(Boolean);
    let out = searched;
    if (terms.length) {
      out = searched.filter((r) => {
        let h = hay.get(r);
        if (h === undefined) {
          h = fold([r.project, r.scene, r.date, r.provider, r.attribution, r.licence, r.format, ...(member.get(r.id) ?? [])].filter(Boolean).join(' '));
          hay.set(r, h);
        }
        return terms.every((t) => h!.includes(t));
      });
    }
    perf.tagMs = performance.now() - t0;
    return out;
  }, [searched, dTag, hay, member]);

  const facets = useMemo(() => {
    const t0 = performance.now();
    const sel: Record<Dim, Set<string>> = { format: new Set(formats), provider: new Set(providers), set: new Set(setFilter) };
    const counts: Record<Dim, Map<string, number>> = { format: new Map(), provider: new Map(), set: new Map() };
    const out: Row[] = [];
    // Faceted counts: a chip counts the rows it would show given the OTHER dimensions' choices. Values
    // that count 0 that way are still listed (dimmed), so choosing one set never hides the providers
    // of the others.
    const bump = (d: Dim, v: string, hit: boolean) => {
      const n = counts[d].get(v) ?? 0;
      if (hit || !counts[d].has(v)) counts[d].set(v, n + (hit ? 1 : 0));
    };
    for (const r of tagged) {
      const prov = r.provider || '';
      const sets = member.get(r.id) ?? [];
      // AND across dimensions, OR within one.
      const okF = !sel.format.size || sel.format.has(r.format);
      const okP = !sel.provider.size || sel.provider.has(prov);
      const okS = !sel.set.size || sets.some((s) => sel.set.has(s));
      if (okF && okP && okS) out.push(r);
      bump('format', r.format, okP && okS);
      bump('provider', prov, okF && okS);
      for (const s of sets) bump('set', s, okF && okP);
    }
    perf.facetMs = performance.now() - t0;
    perf.shown = out.length;
    return { filtered: out, counts };
  }, [tagged, member, formats, providers, setFilter]);
  const { filtered } = facets;

  const items = useMemo<Item[]>(() => {
    const t0 = performance.now();
    let out: Item[];
    if (groupBy === 'none') out = filtered.map((row) => ({ kind: 'row', row }));
    else {
      const buckets = new Map<string, Row[]>();
      for (const r of filtered) {
        const k = groupBy === 'set' ? (member.get(r.id)?.[0] ?? '') : (r[groupBy] ?? '').trim();
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(r);
      }
      const keys = [...buckets.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
      out = keys.flatMap((k) => [
        { kind: 'header' as const, key: k, label: k || `(no ${groupBy})`, rows: buckets.get(k)! },
        ...buckets.get(k)!.map((row) => ({ kind: 'row' as const, row })),
      ]);
    }
    perf.groupMs = performance.now() - t0;
    return out;
  }, [filtered, groupBy, member]);

  const flatRows = useMemo(() => (groupBy === 'none' ? filtered : items.flatMap((it) => (it.kind === 'row' ? [it.row] : []))), [items, filtered, groupBy]);
  const flatRef = useRef(flatRows);
  flatRef.current = flatRows;

  const inTree = useInTree();

  const clickRow = useCallback((e: React.MouseEvent, r: Row) => {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const toggle = !e.shiftKey && (e.ctrlKey || e.metaKey);
    const from = e.shiftKey ? anchor.current : null;
    if (!from) anchor.current = r.id;
    const list = flatRef.current;
    // Functional update: two clicks in one task must not both start from the same stale set.
    setSelected((prev) => {
      const next = new Set(additive ? prev : []);
      const a = from ? list.findIndex((x) => x.id === from) : -1, b = list.findIndex((x) => x.id === r.id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(list[i].id);
      else if (toggle && next.has(r.id)) next.delete(r.id);
      else next.add(r.id);
      return next;
    });
  }, [setSelected]);

  // Only rows still listed count: a filter change hides, and so un-targets, a selected row.
  const selectedRows = useMemo(() => flatRows.filter((r) => selected.has(r.id)), [flatRows, selected]);
  const targetName = useBuilder((s) => s.tree.nodes[insertionTarget(s.tree, s.focus)]?.name);

  const addRows = useCallback((list: Row[], asGroup?: string) => {
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
  }, []);

  const dragRows = useCallback((e: React.DragEvent, r: Row | Row[]) => {
    const sel = selRef.current;
    const list = Array.isArray(r) ? r : sel.has(r.id) ? flatRef.current.filter((x) => sel.has(x.id)) : [r];
    startDrag(e, { kind: 'rows', rows: list });
  }, []);

  const selectAll = () => { setSelected(new Set(flatRows.map((r) => r.id))); anchor.current = flatRows[0]?.id ?? null; };

  const setFor: Record<Dim, (f: (cur: string[]) => string[]) => void> = { format: setFormats, provider: setProviders, set: setSetFilter };
  const chosen: Record<Dim, string[]> = { format: formats, provider: providers, set: setFilter };
  const toggleChip = (d: Dim, v: string) => setFor[d]((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  const anyFilter = formats.length + providers.length + setFilter.length > 0 || !!tag.trim();
  const clearFilters = () => { setFormats([]); setProviders([]); setSetFilter([]); setTag(''); };

  const allSources = [
    ...(importUrl ? [{ key: 'import', label: 'Imported selection', count: undefined as number | undefined, local: false }] : []),
    ...sets.map((s) => ({ key: `set:${s.name}`, label: s.name, count: s.count as number | undefined, local: s.local, title: s.label })),
    { key: 'custom', label: 'Added by URL', count: customRows.length, local: false },
  ];
  const loadingAny = active.some((k) => cache[k]?.loading);
  const failedSources = active.filter((k) => cache[k]?.error);

  return (
    <section className="flex min-h-0 flex-col border-r" data-testid="library">
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center gap-1.5">
          <h2 className="mr-auto text-xs font-semibold tracking-wide text-muted-foreground uppercase">Library</h2>
          {loadingAny && <Loader2 className="size-3.5 animate-spin text-muted-foreground" data-testid="library-loading" />}
          <Button size="icon" variant="ghost" className="size-7" title="Reload the chosen sources" onClick={() => active.forEach((k) => load(k, true))}>
            <RefreshCw />
          </Button>
        </div>

        <div className="rounded-md border">
          <button type="button" className="flex w-full items-center gap-1 px-2 py-1 text-left text-xs" onClick={() => setSourcesOpen((o) => !o)} data-testid="sources-toggle">
            {sourcesOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <span className="font-medium">Sources</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {active.length ? active.map(sourceLabel).join(', ') : 'none'} · {rows.length} rows
            </span>
          </button>
          {sourcesOpen && (
            <div className="max-h-44 space-y-0.5 overflow-y-auto border-t px-2 py-1" data-testid="sources">
              {setsState.status === 'loading' && <div className="text-[11px] text-muted-foreground">Loading sets…</div>}
              {setsState.error && <div className="text-[11px] text-destructive">Sets unavailable: {setsState.error}</div>}
              {allSources.map((s) => {
                const on = active.includes(s.key);
                const c = cache[s.key];
                const n = s.key === 'custom' ? customRows.length : c && !c.loading && !c.error ? c.rows.length : undefined;
                return (
                  <label key={s.key} className="flex items-center gap-1.5 text-xs" title={('title' in s ? s.title : '') + (c?.note ? `\n${c.note}` : '')} data-testid="source-option" data-key={s.key}>
                    <Checkbox checked={on} onCheckedChange={(v) => toggleSource(s.key, v === true)} className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{s.label}{s.local && <span className="text-muted-foreground"> · local</span>}</span>
                    {c?.loading && on && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                    {c?.error && <TriangleAlert className="size-3 text-destructive" />}
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {n != null && s.count != null && n !== s.count ? `${n}/${s.count}` : n ?? s.count ?? ''}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${rows.length} datasets…`} className="h-7 pl-7 text-xs" data-testid="library-search" />
        </div>
        <div className="relative">
          <Tag className="pointer-events-none absolute top-2 left-2 size-3.5 text-muted-foreground" />
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag: project · scene · date · provider · set" className="h-7 pr-7 pl-7 text-xs" data-testid="library-tag" />
          {tag && <button type="button" className="absolute top-1.5 right-2 text-muted-foreground" onClick={() => setTag('')} title="Clear"><X className="size-3.5" /></button>}
        </div>
        <ChipRow dim="format" label="format" counts={facets.counts.format} chosen={chosen.format} onToggle={toggleChip} />
        <ChipRow dim="provider" label="provider" counts={facets.counts.provider} chosen={chosen.provider} onToggle={toggleChip} />
        {(active.length > 1 || setFilter.length > 0) && (
          <ChipRow dim="set" label="set" counts={facets.counts.set} chosen={chosen.set} onToggle={toggleChip} />
        )}
        <div className="flex items-center gap-1">
          {anyFilter && (
            <button type="button" className="text-[11px] text-sky-400 hover:underline" onClick={clearFilters} data-testid="clear-filters">Clear filters</button>
          )}
          <ToggleGroup type="single" size="sm" value={groupBy} onValueChange={(v) => v && setGroupBy(v as GroupKey)} className="ml-auto" title="Group the list">
            {(['none', 'project', 'scene', 'provider', 'set'] as const).map((g) => (
              <ToggleGroupItem key={g} value={g} className="h-6 px-1.5 text-[11px]">{g === 'none' ? 'flat' : g}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {failedSources.map((k) => (
        <div key={k} className="mx-2 mt-1 flex items-center gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-1 text-[11px] text-destructive" data-testid="source-error">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={cache[k].error}><b>{sourceLabel(k)}</b>: {cache[k].error}</span>
          <button type="button" title="Retry" onClick={() => load(k, true)}><RotateCw className="size-3.5" /></button>
          <button type="button" title="Remove this source" onClick={() => toggleSource(k, false)}><X className="size-3.5" /></button>
        </div>
      ))}

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
          <LibraryRow
            row={it.row}
            sets={member.get(it.row.id)}
            selected={selected.has(it.row.id)}
            inTree={inTree.has(it.row.id) || inTree.has(it.row.url)}
            onClick={clickRow}
            onDrag={dragRows}
            onAdd={addRows}
          />
        )}
      />

      <div className="space-y-2 border-t p-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground tabular-nums" data-testid="library-count">
            {selectedRows.length ? `${selectedRows.length} selected` : `${filtered.length} shown`}
          </span>
          <button type="button" className="text-[11px] text-sky-400 hover:underline disabled:opacity-40" disabled={!flatRows.length}
            onClick={selectAll} data-testid="select-all" title="Select every listed row">all</button>
          {selectedRows.length > 0 && (
            <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => setSelected(new Set())}>none</button>
          )}
          <Button size="sm" className="ml-auto h-7 max-w-[60%]" disabled={!selectedRows.length} onClick={() => addRows(selectedRows)} data-testid="add-selected"
            title="Add the selected datasets to the focused group (non drag-and-drop alternative)">
            <Plus /><span className="truncate">Add to “{targetName}”</span>
          </Button>
        </div>
        <AddUrl onAdded={() => toggleSource('custom', true)} />
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

/** One filter dimension. Nothing chosen = no filter; chosen values stay listed even at 0. */
function ChipRow({ dim, label, counts, chosen, onToggle }: {
  dim: Dim;
  label: string;
  counts: Map<string, number>;
  chosen: string[];
  onToggle: (d: Dim, v: string) => void;
}) {
  const [more, setMore] = useState(false);
  const entries = useMemo(() => {
    const m = new Map(counts);
    for (const v of chosen) if (!m.has(v)) m.set(v, 0);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [counts, chosen]);
  if (!entries.length) return null;
  // Collapsed: the top values that still match something, plus whatever is chosen.
  const shown = more ? entries : entries.filter(([v, n], i) => (i < CHIPS_COLLAPSED && n > 0) || chosen.includes(v));
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`chips-${dim}`}>
      <span className="w-12 shrink-0 text-[10px] text-muted-foreground uppercase">{label}</span>
      {shown.map(([v, n]) => {
        const on = chosen.includes(v);
        return (
          <button key={v || '(none)'} type="button" onClick={() => onToggle(dim, v)} data-testid="chip" data-value={v}
            className={cn('flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
              on ? 'border-sky-400 bg-sky-500/25' : 'hover:bg-accent', !on && !n && 'opacity-50')}>
            {dim === 'format' && <Dot format={v} />}
            <span className="truncate">{v || `(no ${label})`}</span>
            <span className="text-muted-foreground tabular-nums">{n}</span>
          </button>
        );
      })}
      {entries.length > shown.length || more ? (
        <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => setMore((m) => !m)}>
          {more ? 'less' : `+${entries.length - shown.length} more`}
        </button>
      ) : null}
    </div>
  );
}

const LibraryRow = memo(function LibraryRow({ row, sets, selected, inTree, onClick, onDrag, onAdd }: {
  row: Row;
  sets?: string[];
  selected: boolean;
  inTree: boolean;
  onClick: (e: React.MouseEvent, r: Row) => void;
  onDrag: (e: React.DragEvent, r: Row) => void;
  onAdd: (list: Row[]) => void;
}) {
  return (
    <div
      draggable
      data-testid="library-row"
      data-id={row.id}
      onDragStart={(e) => onDrag(e, row)}
      onDragEnd={endDrag}
      onClick={(e) => onClick(e, row)}
      onDoubleClick={() => onAdd([row])}
      className={cn('flex h-full cursor-grab items-center gap-2 border-b border-border/40 px-2 select-none active:cursor-grabbing',
        selected ? 'bg-sky-500/20' : 'hover:bg-accent/60')}
      title={[row.name, row.url, row.attribution, sets?.length ? `sets: ${sets.join(', ')}` : '', 'Double-click to add'].filter(Boolean).join('\n')}
    >
      <Dot format={row.format} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs">{row.name}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {[row.provider, row.project, row.scene, row.date?.replace('/', ' → '), fmtRadius(row.radius)].filter(Boolean).join(' · ')}
        </div>
      </div>
      {inTree && <span className="text-[10px] text-emerald-400" title="Already in the tree">✓</span>}
    </div>
  );
});

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
  // A new list starts at the top: a scroll offset from a longer list would show an empty window.
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollTop > items.length * ROW_H) { el.scrollTop = 0; setScroll(0); }
  }, [items]);
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
    <div ref={ref} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={(e) => setScroll(e.currentTarget.scrollTop)} data-testid="library-list">
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

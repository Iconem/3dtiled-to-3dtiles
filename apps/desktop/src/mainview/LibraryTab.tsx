/**
 * Library — bookmarks, with a cached structural check (tiles/depth/leaves from /stats), and a
 * history of what was served or exported.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { AppModel } from './App';
import { Card, CardHead, CardHeadActions } from './components/Card';
import { Chip, FieldLabel, Hint } from './components/bits';
import { base, pickerRpc } from './host';
import { newId, parseLibrary, serialize, type DatasetOptions, type HistoryEntry, type LibraryEntry } from './library';
import { buildUrlFrom, iconOf, kindOf, mb, typeOfFormat } from './urls';


const GLYPH_BG: Record<string, string> = {
  pointcloud: 'bg-[hsl(210_70%_55%/0.14)]',
  splat: 'bg-[hsl(280_70%_60%/0.14)]',
  mesh: 'bg-[hsl(150_60%_45%/0.14)]',
};

/** One row of either list: what the dataset is, one line about it, and its actions. */
function Row({ e, meta, metaClass, metaTitle, compact, actions }: {
  e: DatasetOptions & { name: string }; meta: ReactNode; metaClass?: string; metaTitle?: string; compact: boolean; actions: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 items-center', compact
      ? 'gap-2 border-b border-border py-0.5 pr-1 pl-2 hover:bg-muted/50'
      : 'gap-3 rounded-md border border-border bg-muted/25 px-3 py-2.5 hover:bg-muted/50')}>
      {/* A generated format glyph, NOT a thumbnail. Rendering a real preview would mean loading each
          tileset in a hidden Cesium view — far too expensive for a list — so this encodes the one thing
          that is knowable without fetching: which family of data it is. */}
      {!compact && <div className={cn('grid size-[38px] flex-none place-items-center rounded-[5px] border border-border text-[17px]', GLYPH_BG[kindOf(e.format)])}>{iconOf(e.format)}</div>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className={cn(compact ? 'block truncate text-[13px] font-normal' : 'flex items-center gap-[7px] text-[13.5px] font-medium')} title={`${e.name}\n${e.src}`}>
          {e.name}
          {!compact && <><Chip>{e.format || 'auto'}</Chip>{e.lon && e.lat && <Chip>{`${e.lon}, ${e.lat}`}</Chip>}</>}
        </div>
        {!compact && <>
          <div className="truncate font-mono text-[11.5px] leading-[1.4] text-muted-foreground" title={e.src}>{e.src}</div>
          <div className={cn('text-[11.5px] text-muted-foreground', metaClass)} title={metaTitle}>{meta}</div>
        </>}
      </div>
      <div className="flex flex-none gap-1">{actions}</div>
    </div>
  );
}

export function LibraryTab({ app }: { app: AppModel }) {
  const { lib, updateLib, say } = app;
  const compact = app.libCompact;                          // chosen next to the tabs (App.tsx): it applies to both lists
  const [io, setIo] = useState<{ open: boolean; value: string }>({ open: false, value: '' });
  const ioRef = useRef<HTMLTextAreaElement>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);


  const openBtn = (e: DatasetOptions) => <Button size="sm" variant="ghost" onClick={() => { app.loadIntoBuilder(e); app.showTab('build'); }}>Open</Button>;
  const copyBtn = (e: DatasetOptions) => <Button size="sm" variant="ghost" onClick={async () => {
    try { await navigator.clipboard.writeText(buildUrlFrom(e)); say('Copied.', 'ok'); } catch { /* ignore */ }
  }}>Copy</Button>;

  /**
   * Walk every saved tileset through /stats and cache the shape. Sequential on purpose — this fans out
   * to arbitrary third-party hosts, and a library of 30 entries firing at once is exactly the
   * unbounded-concurrency pattern that loses requests (the same lesson /aggregate's child fetches
   * learned the hard way).
   */
  async function refreshStats() {
    if (!base || !lib.bookmarks.length) return;
    for (const e of lib.bookmarks) {
      setRefreshing(`Checking ${e.name}…`);
      let stats: LibraryEntry['stats'];
      try {
        const u = `${base}/stats/tileset.json?url=${encodeURIComponent(buildUrlFrom(e))}&maxNodes=2000`;
        const r = await fetch(u);
        if (!r.ok) throw new Error(String(r.status));
        const s = await r.json();
        stats = { tiles: s.totalNodes, depth: s.maxDepth, leaves: s.leafNodes, truncated: !!s.truncated, checkedAt: Date.now() };
      } catch {
        stats = undefined;                       // a failed check must clear a stale one, not keep it
      }
      updateLib((l) => { l.bookmarks = l.bookmarks.map((b) => (b.id === e.id ? { ...b, stats } : b)); });
    }
    setRefreshing(null);
  }

  function exportJson() {
    setIo({ open: true, value: serialize(lib) });
    requestAnimationFrame(() => ioRef.current?.select());
  }
  function importJson() {
    if (!io.open) { setIo({ open: true, value: '' }); requestAnimationFrame(() => ioRef.current?.focus()); return; }
    try {
      const next = parseLibrary(io.value, lib);
      app.replaceLib(next);
      setIo({ open: false, value: '' });
      say(`Imported ${next.bookmarks.length} bookmarks and ${next.history.length} history entries.`, 'ok');
    } catch (e) { say(`Import failed: ${(e as Error).message}`, 'err'); }
  }

  const bookmarkOf = (e: HistoryEntry) => {
    const { src, format, cache, lon, lat, alt, heading, name } = e;
    updateLib((l) => { l.bookmarks.push({ id: newId(), name, addedAt: Date.now(), src, format, cache, lon, lat, alt, heading }); });
  };

  const listClass = cn('mt-3 flex flex-col', compact ? 'gap-0' : 'gap-2');

  return (
    <section>
      <Card>
        <CardHead>
          <FieldLabel>Bookmarks</FieldLabel>
          <CardHeadActions>
            <Button id="lib-refresh" variant="ghost" disabled={refreshing != null} onClick={refreshStats}>{refreshing ?? 'Refresh stats'}</Button>
            <Button id="lib-export" variant="ghost" title="Export bookmarks and history as JSON" onClick={exportJson}>Export JSON</Button>
            <Button id="lib-import" variant="ghost" title="Import bookmarks and history from JSON" onClick={importJson}>Import JSON</Button>
          </CardHeadActions>
        </CardHead>
        <Hint>
          Datasets you want to keep around. The JSON also carries the history below, and any share
          links or signed URLs in either: treat it as private.
        </Hint>
        <div id="lib-list" className={listClass}>
          {!lib.bookmarks.length && <Hint>Nothing bookmarked yet — enter a dataset and press Bookmark, or start from Samples.</Hint>}
          {lib.bookmarks.map((e) => {
            const s = e.stats;
            const n = s?.tiles.toLocaleString('en-US');
            const meta = !s ? 'not checked yet' : s.truncated
              // "≥" and the explicit note: the walk stopped at the budget, so these are floors, not facts.
              ? `≥${n} tiles · depth ≥${s.depth} · ≥${s.leaves.toLocaleString('en-US')} leaves (node budget reached)`
              : `${n} tiles · depth ${s.depth} · ${s.leaves.toLocaleString('en-US')} leaves`;
            return (
              <Row key={e.id} e={e} compact={compact} meta={meta} metaClass={s?.truncated ? 'text-warning' : undefined} actions={<>
                {openBtn(e)}
                {copyBtn(e)}
                <Button size="sm" variant="ghost" onClick={() => app.previewIn('cesium', buildUrlFrom(e), typeOfFormat(e.format), e.name)}>Preview</Button>
                <Button size="sm" variant="ghost" onClick={() => updateLib((l) => { l.bookmarks = l.bookmarks.filter((x) => x.id !== e.id); })}>Remove</Button>
              </>} />
            );
          })}
        </div>
        <Textarea id="lib-io" ref={ioRef} hidden={!io.open} value={io.value} onChange={(ev) => setIo({ open: true, value: ev.target.value })} spellCheck={false}
          placeholder="Paste exported JSON here, then press Import JSON again."
          className="mt-2.5 min-h-[120px] w-full resize-y rounded-md border-input bg-muted/50 px-[11px] py-[9px] font-mono text-[11.5px] leading-normal text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 dark:bg-muted/50" />
      </Card>
      <Card>
        <CardHead>
          <FieldLabel>History</FieldLabel>
          <CardHeadActions>
            <Button id="hist-clear" variant="ghost" disabled={!lib.history.length} onClick={() => updateLib((l) => { l.history = []; })}>Clear</Button>
          </CardHeadActions>
        </CardHead>
        <Hint>What you served or exported from this app, latest first, up to 200.</Hint>
        <div id="hist-list" className={listClass}>
          {!lib.history.length && <Hint>Nothing yet — a URL you copy, preview or test, and every export, shows up here.</Hint>}
          {lib.history.map((e) => {
            const when = new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const meta = e.kind === 'served'
              ? `Served · ${when}${(e.count ?? 1) > 1 ? ` · ${e.count} times` : ''}`
              : `Exported · ${when} · ${e.state === 'done' ? 'done' : e.state}${e.files ? ` · ${e.files} files` : ''}${e.bytes ? ` · ${mb(e.bytes)}` : ''} · ${e.outDir}`;
            return (
              <Row key={e.id} e={e} compact={compact} meta={meta} metaTitle={e.kind === 'exported' ? e.outDir ?? '' : undefined} actions={<>
                {openBtn(e)}
                {e.kind === 'exported'
                  ? <Button size="sm" variant="ghost" onClick={() => { if (e.outDir) void pickerRpc?.request.openFolder({ path: e.outDir }).catch(() => {}); }}>Folder</Button>
                  : copyBtn(e)}
                <Button size="sm" variant="ghost" onClick={() => bookmarkOf(e)}>Bookmark</Button>
                <Button size="sm" variant="ghost" onClick={() => updateLib((l) => { l.history = l.history.filter((x) => x.id !== e.id); })}>Remove</Button>
              </>} />
            );
          })}
        </div>
      </Card>
    </section>
  );
}

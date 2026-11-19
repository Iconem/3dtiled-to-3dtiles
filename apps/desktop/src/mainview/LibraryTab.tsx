/**
 * Library — the samples, bookmarks with a cached structural check (tiles/depth/leaves from /stats), and a history of
 * what was served or exported: three sections that fold, the samples closed until asked for. One table per list: a row
 * opens its dataset in Stream live, and the rest of what can be done with it is in the row's menu.
 */
import { MoreHorizontalIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type { AppModel } from './App';
import { Card } from './components/Card';
import { Chip, FoldCard, Tip } from './components/bits';
import { base, pickerRpc } from './host';
import { newId, parseLibrary, serialize, type DatasetOptions, type HistoryEntry, type LibraryEntry } from './library';
import { SamplesCard } from './SamplesCard';
import { buildUrlFrom, guessFormat, mb, typeOfFormat } from './urls';

/** One dataset of either list: its name and format, one line about it, Open, and a menu. */
function Row({ e, detail, detailClass, detailTitle, onOpen, menu }: {
  e: DatasetOptions & { name: string }; detail: ReactNode; detailClass?: string; detailTitle?: string; onOpen: () => void; menu: ReactNode;
}) {
  const format = e.format || guessFormat(e.src);
  return (
    <TableRow>
      <TableCell className="w-full max-w-0 py-1.5 pl-0">
        <Tip text={e.src}><div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{e.name}</span>
          {format && <Chip>{format}</Chip>}
        </div></Tip>
        <Tip text={detailTitle} side="bottom"><div className={`truncate text-xs ${detailClass ?? 'text-muted-foreground'}`}>{detail}</div></Tip>
      </TableCell>
      <TableCell className="py-1.5 pr-0 text-right whitespace-nowrap">
        <Button size="sm" onClick={onOpen}>Open</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="ghost" aria-label={`More for ${e.name}`} className="ml-1 px-1.5" />}><MoreHorizontalIcon className="size-4" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">{menu}</DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

export function LibraryTab({ app }: { app: AppModel }) {
  const { lib, updateLib, say } = app;
  const [io, setIo] = useState<{ open: boolean; value: string }>({ open: false, value: '' });
  const ioRef = useRef<HTMLTextAreaElement>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const open = (e: DatasetOptions) => { app.loadIntoBuilder(e); app.showTab('stream'); };
  const copy = async (e: DatasetOptions) => {
    try { await navigator.clipboard.writeText(buildUrlFrom(e)); say('Tileset URL copied.', 'ok'); } catch { /* ignore */ }
  };
  const preview = (e: DatasetOptions & { name: string }) => app.previewIn('cesium', buildUrlFrom(e), typeOfFormat(e.format || guessFormat(e.src)), e.name);

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
    const { src, format, cache, lon, lat, alt, heading, scale, name } = e;
    updateLib((l) => { l.bookmarks.push({ id: newId(), name, addedAt: Date.now(), src, format, cache, lon, lat, alt, heading, scale }); });
    say(`${name} is bookmarked.`, 'ok');
  };

  const empty = (text: string) => <p className="m-0 py-2 text-xs text-muted-foreground">{text}</p>;

  return (
    <section>
      <SamplesCard app={app} />
      <FoldCard id="bookmarks" title="Bookmarks" count={lib.bookmarks.length} actions={<>
        <Tip text="Count tiles, depth and leaves of every bookmark"><Button id="lib-refresh" size="sm" variant="ghost" disabled={refreshing != null || !lib.bookmarks.length} onClick={refreshStats}>{refreshing ?? 'Check all'}</Button></Tip>
        <DropdownMenu>
          <Tip text="Import and export"><DropdownMenuTrigger render={<Button id="lib-menu" size="sm" variant="ghost" aria-label="Import and export" className="px-1.5" />}><MoreHorizontalIcon className="size-4" /></DropdownMenuTrigger></Tip>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem id="lib-export" onClick={exportJson}>Export as JSON</DropdownMenuItem>
            <DropdownMenuItem id="lib-import" onClick={importJson}>Import from JSON…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>}>
        <div id="lib-list">
          {!lib.bookmarks.length && empty('Nothing bookmarked yet: the star next to a dataset adds it here.')}
          <Table><TableBody>
            {lib.bookmarks.map((e) => {
              const s = e.stats;
              const n = s?.tiles.toLocaleString('en-US');
              const detail = !s ? e.src : s.truncated
                // "≥" and the explicit note: the walk stopped at the budget, so these are floors, not facts.
                ? `≥${n} tiles · depth ≥${s.depth} · ≥${s.leaves.toLocaleString('en-US')} leaves (node budget reached)`
                : `${n} tiles · depth ${s.depth} · ${s.leaves.toLocaleString('en-US')} leaves`;
              return (
                <Row key={e.id} e={e} detail={detail} detailClass={s?.truncated ? 'text-warning' : undefined} detailTitle={e.src} onOpen={() => open(e)} menu={<>
                  <DropdownMenuItem onClick={() => copy(e)}>Copy tileset URL</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => preview(e)}>Preview</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => updateLib((l) => { l.bookmarks = l.bookmarks.filter((x) => x.id !== e.id); })}>Remove</DropdownMenuItem>
                </>} />
              );
            })}
          </TableBody></Table>
        </div>
      </FoldCard>
      {io.open && <Card id="lib-io-card">
        <Textarea id="lib-io" ref={ioRef} value={io.value} onChange={(ev) => setIo({ open: true, value: ev.target.value })} spellCheck={false}
          placeholder="Paste exported JSON here, then press Import."
          className="min-h-32 w-full resize-y bg-muted/50 font-mono text-xs dark:bg-muted/50" />
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="default" onClick={importJson}>Import</Button>
          <Button size="sm" variant="ghost" onClick={() => setIo({ open: false, value: '' })}>Close</Button>
          <span className="text-xs text-muted-foreground">The JSON carries any share link or signed URL you used: keep it private.</span>
        </div>
      </Card>}
      <FoldCard id="history" title="History" count={lib.history.length} actions={
        <Button id="hist-clear" size="sm" variant="ghost" disabled={!lib.history.length} onClick={() => updateLib((l) => { l.history = []; })}>Clear</Button>
      }>
        <div id="hist-list">
          {!lib.history.length && empty('Nothing yet: a URL you copy, preview or test, and every export, shows up here.')}
          <Table><TableBody>
            {lib.history.map((e) => {
              const when = new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
              const detail = e.kind === 'served'
                ? `Served · ${when}${(e.count ?? 1) > 1 ? ` · ${e.count} times` : ''}`
                : `Exported · ${when} · ${e.state === 'done' ? 'done' : e.state}${e.files ? ` · ${e.files} files` : ''}${e.bytes ? ` · ${mb(e.bytes)}` : ''} · ${e.outDir}`;
              return (
                <Row key={e.id} e={e} detail={detail} detailTitle={e.kind === 'exported' ? e.outDir ?? '' : e.src} onOpen={() => open(e)} menu={<>
                  {e.kind === 'exported'
                    ? <DropdownMenuItem onClick={() => { if (e.outDir) void pickerRpc?.request.openFolder({ path: e.outDir }).catch(() => {}); }}>Open the folder</DropdownMenuItem>
                    : <DropdownMenuItem onClick={() => copy(e)}>Copy tileset URL</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => bookmarkOf(e)}>Bookmark</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => updateLib((l) => { l.history = l.history.filter((x) => x.id !== e.id); })}>Remove</DropdownMenuItem>
                </>} />
              );
            })}
          </TableBody></Table>
        </div>
      </FoldCard>
    </section>
  );
}

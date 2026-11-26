/**
 * The streams of this window: every tileset URL added (by hand, or by copying or previewing it), one row each, kept
 * on this machine (localStorage) so the list survives a restart of the window.
 *
 * A row keeps the SOURCE and its options, not the built URL: the URL is rebuilt from them on every render, so it
 * follows the port the tile-server got this time. Nothing is stored that the user did not type.
 *
 * PAUSE is a mark on the row, not a switch on the server: the tile-server keeps no per-URL state (the URL carries
 * the whole request), so it answers a paused row's URL to any client that already has it, as long as this app runs.
 * Paused greys the row and takes its URL out of reach here (no copy, no select), so it is not handed out again.
 */
import { ArrowDownIcon, ArrowUpIcon, PauseIcon, PlayIcon, Settings2Icon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardHead, CardTitle } from './components/Card';
import { Chip, CopyButton, Info, Tip, UrlBar } from './components/bits';
import { newId, type DatasetOptions } from './library';
import { buildUrlFrom, nameFor } from './urls';

export interface StreamEntry extends DatasetOptions {
  id: string;
  name: string;
  addedAt: number;
  paused?: boolean;
}

const KEY = '3dtiled-desktop-streams-v1';
const FIELDS = ['src', 'format', 'cache', 'lon', 'lat', 'alt', 'heading', 'scale'] as const;

/** The same source with the same options: the same URL. */
export const sameStream = (a: DatasetOptions, b: DatasetOptions) => FIELDS.every((k) => (a[k] || '') === (b[k] || ''));

function load(): StreamEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e?.src === 'string' && typeof e?.id === 'string') : [];
  } catch { return []; }   // a corrupt blob: an empty list, not a broken window
}
function save(list: StreamEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota or disabled storage: the list lasts this session */ }
}

/** The list and what changes it; every change is saved. */
export function useStreams() {
  const [list, setList] = useState<StreamEntry[]>(load);
  const change = useCallback((f: (l: StreamEntry[]) => StreamEntry[]) => setList((l) => { const next = f(l); save(next); return next; }), []);
  return {
    list,
    add: (o: DatasetOptions) => change((l) => [...l, { ...o, id: newId(), name: nameFor(o.src), addedAt: Date.now() }]),
    patch: (id: string, p: Partial<StreamEntry>) => change((l) => l.map((e) => (e.id === id ? { ...e, ...p } : e))),
    remove: (id: string) => change((l) => l.filter((e) => e.id !== id)),
    insert: (e: StreamEntry, at: number) => change((l) => { const n = [...l]; n.splice(Math.min(at, n.length), 0, e); return n; }),
    move: (id: string, by: -1 | 1) => change((l) => {
      const i = l.findIndex((e) => e.id === id), j = i + by;
      if (i < 0 || j < 0 || j >= l.length) return l;
      const n = [...l]; [n[i], n[j]] = [n[j]!, n[i]!]; return n;
    }),
  };
}
export type Streams = ReturnType<typeof useStreams>;

/** The list under the tileset URL. `editing` is the row whose settings are in the form above; `current` the row that matches the form. */
export function StreamsCard({ streams, editing, current, onEdit }: { streams: Streams; editing: string | null; current?: string; onEdit: (e: StreamEntry) => void }) {
  if (!streams.list.length) return null;
  function remove(e: StreamEntry) {
    const at = streams.list.indexOf(e);
    streams.remove(e.id);
    toast(`${e.name} removed`, { action: { label: 'Undo', onClick: () => streams.insert(e, at) } });
  }
  return (
    <Card id="streams-card">
      <CardHead>
        <CardTitle>Streams</CardTitle>
        <span id="streams-count" className="text-xs text-muted-foreground">{streams.list.length}</span>
        <Info label="About this list">
          <p className="m-0">Every URL you add, copy or preview, kept on this machine. Each is served while this app runs.</p>
          <p className="m-0"><strong>Settings</strong> loads a stream into the form above; Save there writes it back to its row.</p>
          <p className="m-0"><strong>Pause</strong> greys the row and hides its URL from copy here. The tile-server keeps no per-URL state, so a client that already has the URL still gets tiles until the app quits.</p>
        </Info>
      </CardHead>
      <ul id="streams" className="m-0 flex list-none flex-col gap-2 p-0">
        {streams.list.map((e, i) => (
          <StreamRow key={e.id} entry={e} first={i === 0} last={i === streams.list.length - 1} editing={editing === e.id} current={current === e.id}
            streams={streams} onEdit={() => onEdit(e)} onRemove={() => remove(e)} />
        ))}
      </ul>
    </Card>
  );
}

export type Health = { state: 'checking' | 'ok' | 'err' | 'idle'; detail: string };

/**
 * Does the row's URL answer a tileset? One GET of its tileset.json when the row appears or its URL changes (the
 * port moves after a restart), and again on a click of the pill. A `cache=full` row is not checked by itself:
 * its first request starts a whole conversion, so that waits for a click.
 */
function useHealth(url: string, paused: boolean, auto: boolean): [Health, () => void] {
  const [h, setH] = useState<Health>({ state: 'idle', detail: '' });
  const [nonce, setNonce] = useState(auto ? 1 : 0);
  useEffect(() => { if (auto) setNonce((n) => n + 1); }, [url, auto]);
  useEffect(() => {
    if (!nonce || paused || !url) return;
    const ac = new AbortController();
    let timedOut = false, gone = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 30_000);
    setH({ state: 'checking', detail: 'Requesting the tileset…' });
    (async () => {
      try {
        const t0 = performance.now();
        const r = await fetch(url, { signal: ac.signal });
        const ms = Math.round(performance.now() - t0);
        if (gone) return;
        if (!r.ok) return setH({ state: 'err', detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` });
        const j = await r.json();
        if (!j?.root || !j?.asset) return setH({ state: 'err', detail: 'The answer is JSON but not a tileset (no asset or root).' });
        setH({ state: 'ok', detail: `Answers in ${ms} ms: 3D Tiles ${j.asset.version ?? '?'}, ${j.root.children?.length ?? 0} root children. Click to check again.` });
      } catch (e) {
        if (!gone) setH({ state: 'err', detail: timedOut ? 'No answer in 30 s.' : `Request failed: ${e}` });
      } finally { clearTimeout(timer); }
    })();
    return () => { gone = true; clearTimeout(timer); ac.abort(); };
  }, [nonce, url, paused]);
  return [h, () => setNonce((n) => n + 1)];
}

export const HEALTH_LOOK: Record<Health['state'], { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'border-emerald-600/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  err: { label: 'Error', cls: 'border-red-600/40 bg-red-500/15 text-red-600 dark:text-red-400' },
  checking: { label: 'Checking', cls: '' },
  idle: { label: 'Check', cls: '' },
};

const roField = 'h-8 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-2.5 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25';

function StreamRow({ entry: e, first, last, editing, current, streams, onEdit, onRemove }: {
  entry: StreamEntry; first: boolean; last: boolean; editing: boolean; current: boolean; streams: Streams; onEdit: () => void; onRemove: () => void;
}) {
  const url = buildUrlFrom(e);
  const [health, recheck] = useHealth(url, !!e.paused, e.cache !== 'full');
  const look = HEALTH_LOOK[health.state];
  const [name, setName] = useState(e.name);
  const commit = () => { const n = name.trim() || nameFor(e.src); setName(n); if (n !== e.name) streams.patch(e.id, { name: n }); };
  const icon = (label: string, onClick: () => void, child: React.ReactNode, opts: { disabled?: boolean; pressed?: boolean; id?: string } = {}) => (
    <Tip text={label}>
      <Button size="icon" variant="ghost" className="size-7" aria-label={label} aria-pressed={opts.pressed} disabled={opts.disabled} data-action={opts.id} onClick={onClick}>{child}</Button>
    </Tip>
  );
  return (
    <li data-stream-id={e.id} data-paused={e.paused ? 'true' : 'false'} data-editing={editing ? 'true' : undefined} data-current={current ? 'true' : undefined}
      className={cn('rounded-md border border-border p-2', editing && 'border-ring ring-2 ring-ring/20')}>
      <div className="flex items-center gap-1">
        <input aria-label="Stream name" value={name} spellCheck={false} onChange={(ev) => setName(ev.target.value)} onBlur={commit}
          onKeyDown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); if (ev.key === 'Escape') { setName(e.name); ev.currentTarget.blur(); } }}
          className={cn('h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 text-sm font-medium text-foreground outline-none hover:border-input focus-visible:border-ring', e.paused && 'text-muted-foreground')} />
        {!e.paused && url && (
          <Tip text={health.detail || 'Request the tileset once to see that it answers'}>
            <button type="button" data-health={health.state} aria-label={`Status: ${look.label}. Check again`} onClick={recheck} className="cursor-pointer rounded-full">
              <Chip className={look.cls}>{look.label}</Chip>
            </button>
          </Tip>
        )}
        {e.paused && <Chip>Paused</Chip>}
        {editing && <Chip>Editing</Chip>}
        {icon(e.paused ? 'Resume' : 'Pause', () => streams.patch(e.id, { paused: !e.paused }), e.paused ? <PlayIcon /> : <PauseIcon />, { pressed: !!e.paused, id: 'pause' })}
        {icon(editing ? 'Stop editing' : 'Settings: load into the form above', onEdit, <Settings2Icon />, { pressed: editing, id: 'edit' })}
        {icon('Move up', () => streams.move(e.id, -1), <ArrowUpIcon />, { disabled: first, id: 'up' })}
        {icon('Move down', () => streams.move(e.id, 1), <ArrowDownIcon />, { disabled: last, id: 'down' })}
        {icon('Remove', onRemove, <Trash2Icon />, { id: 'remove' })}
      </div>
      <div className={cn('mt-1 flex flex-col gap-1.5', e.paused && 'opacity-50')}>
        <Tip text={e.src}>
          <input aria-label="Input" readOnly value={e.src} spellCheck={false} data-field="src" className={cn(roField, 'border-transparent bg-transparent text-muted-foreground')} />
        </Tip>
        <UrlBar>
          <input aria-label="Tileset URL" readOnly value={e.paused ? '' : url} placeholder={e.paused ? 'Paused' : 'Starting…'} disabled={e.paused} spellCheck={false} data-field="url"
            onFocus={(ev) => ev.target.select()} className={cn(roField, 'placeholder:font-sans placeholder:text-muted-foreground/70')} />
          <CopyButton text={e.paused ? '' : url} title="Copy URL" variant="outline" className="size-8" />
        </UrlBar>
      </div>
    </li>
  );
}

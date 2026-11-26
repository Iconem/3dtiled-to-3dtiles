/**
 * The Terrain tab: a DEM as quantized-mesh terrain and as XYZ tiles of its analyses, served on this machine by Terrain
 * Viewer's tile service (Iconem, MIT, github.com/Iconem/terrain-viewer), which computes every tile on request.
 *
 * Two cards. The service: downloaded once (the pinned release bundle, SHA-256 checked, through the tilers CLI exactly as
 * a tiler is), then started and stopped here (src/bun/terrain-service.ts); a Terrain Viewer service already running on
 * port 3400 to 3403 (its desktop app's) is used as it is. The sources: a tile template, a COG or VRT address, or a
 * library id of the service (mapterhorn), each row giving its layer.json or the tile address of one analysis, with a
 * copy button and a status pill that asks for its layer.json.
 *
 * A row keeps the source and its encoding, never the built URL: the URL follows the port the service got this time.
 * The list lives in localStorage, like the Streams.
 */
import { ExternalLinkIcon, MoreHorizontalIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { TerrainServiceStatus } from '../shared/rpc-schema';
import type { AppModel } from './App';
import { Card, CardHead, CardHeadActions, CardTitle } from './components/Card';
import { Chip, Choice, CopyButton, Hint, Info, TextInput, Tip, UrlBar } from './components/bits';
import { openExternal, pickerAvailable, pickerRpc } from './host';
import { newId } from './library';
import { HEALTH_LOOK, type Health } from './StreamsList';

const KEY = '3dtiled-desktop-terrain-sources-v1';
const TILER_CLI = 'packages/tilers/cli.js';
/** The ports the main process tries (TERRAIN_PORTS in src/bun/terrain-service.ts); in a plain browser, where one may already run. */
const PORTS = [3400, 3401, 3402, 3403];
const TERRAIN_VIEWER = 'https://terrain-viewer.iconem.com/';
const SAMPLE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** How the source is read: the service guesses from the address (a {z} template is Terrarium, a .tif a COG, a .vrt a VRT) unless told. */
const ENCODINGS = [
  { value: '', label: 'Detect' },
  { value: 'terrarium', label: 'Terrarium' },
  { value: 'terrainrgb', label: 'Terrain-RGB' },
  { value: 'cog', label: 'COG' },
  { value: 'vrt', label: 'VRT' },
  { value: 'lerc', label: 'LERC' },
];
/** What a row hands out: the terrain itself, or the tiles of one analysis (the service's `modes`). */
const OUTPUTS = [
  { value: 'qm', label: 'Quantized mesh', title: 'layer.json: Cesium terrain (CesiumJS, Cesium for Unreal and Unity, Blender)' },
  { value: 'hillshade', label: 'Hillshade' },
  { value: 'slope', label: 'Slope' },
  { value: 'aspect', label: 'Aspect' },
  { value: 'svf', label: 'Sky-view factor' },
  { value: 'tpi', label: 'TPI' },
  { value: 'tri', label: 'TRI' },
  { value: 'colorRelief', label: 'Colour relief' },
  { value: 'contours', label: 'Contours (vector)' },
];

export interface TerrainSource { id: string; name: string; src: string; encoding: string; output: string; addedAt: number }

const isId = (src: string) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(src);
const nameOf = (src: string) => {
  if (isId(src)) return src;
  try { const u = new URL(src.replace(/[{}]/g, '_')); return `${u.host}${u.pathname.split('/').filter((p) => p && !/^_[zxy]_/.test(p)).slice(0, 2).map((p) => `/${p}`).join('')}`; }
  catch { return src.slice(0, 40); }
};

/** `{source}` in the service's paths, and the query that names a source given by address. */
function sourceRef(s: Pick<TerrainSource, 'src' | 'encoding'>): { path: string; query: string } {
  const src = s.src.trim();
  if (isId(src)) return { path: encodeURIComponent(src), query: '' };
  const value = s.encoding ? JSON.stringify({ url: src, type: s.encoding }) : src;
  return { path: 'custom', query: `terrainSource=${encodeURIComponent(value)}` };
}
export function layerJsonUrl(base: string, s: Pick<TerrainSource, 'src' | 'encoding'>) {
  const r = sourceRef(s);
  return `${base}/quantized-mesh/${r.path}/layer.json${r.query ? `?${r.query}` : ''}`;
}
export function terrainUrl(base: string, s: Pick<TerrainSource, 'src' | 'encoding' | 'output'>) {
  if (!base || !s.src.trim()) return '';
  if (s.output === 'qm') return layerJsonUrl(base, s);
  const r = sourceRef(s), ext = s.output === 'contours' ? 'pbf' : 'png';
  return `${base}/terrain-tiles/${r.path}/{z}/{x}/{y}.${ext}?modes=${s.output}${r.query ? `&${r.query}` : ''}`;
}
/** The same source in Terrain Viewer's web app (its share link names a source by address, its type for the whole link). */
const viewerLinkOf = (s: TerrainSource) =>
  `${TERRAIN_VIEWER}?terrainSourceA=${encodeURIComponent(s.src.trim())}${s.encoding && !isId(s.src) ? `&terrainType=${s.encoding}` : ''}`;

function load(): TerrainSource[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e?.src === 'string' && typeof e?.id === 'string') : [];
  } catch { return []; }
}
function save(list: TerrainSource[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* the list lasts this session */ }
}

const OFF: TerrainServiceStatus = { state: 'stopped', url: null, port: null, owned: false, pid: null, installed: false, version: null, downloadable: false, bytes: null, hint: null, log: [] };

/**
 * The service's status: from the main process in the app, polled while the tab is open (faster while it starts); in a
 * plain browser, whichever Terrain Viewer service answers on one of the ports.
 */
function useService(active: boolean) {
  const host = pickerAvailable() && !!pickerRpc;
  const [st, setSt] = useState<TerrainServiceStatus | null>(null);
  const ask = useCallback(async (action: 'status' | 'start' | 'stop' | 'refresh' = 'status') => {
    if (host) {
      const s = await pickerRpc!.request.terrainService({ action }).catch(() => null);
      if (s) setSt(s);
      return s;
    }
    for (const p of PORTS) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok && (await r.text()).includes('"direct"')) { const s = { ...OFF, state: 'running' as const, url: `http://127.0.0.1:${p}`, port: p, installed: true }; setSt(s); return s; }
      } catch { /* next port */ }
    }
    setSt({ ...OFF, hint: 'Start and stop it from the desktop app.' });
    return null;
  }, [host]);
  useEffect(() => {
    if (!active) return;
    void ask();
    const t = setInterval(() => void ask(), st?.state === 'starting' ? 700 : 5000);
    return () => clearInterval(t);
  }, [active, ask, st?.state]);
  return { st, ask, host };
}

function ServiceCard({ svc, say }: { svc: ReturnType<typeof useService>; say: AppModel['say'] }) {
  const { st, ask, host } = svc;
  const [install, setInstall] = useState<{ id: string; line: string } | null>(null);
  const installRef = useRef(install);
  installRef.current = install;

  async function download() {
    if (!host) return;
    try {
      const { id } = await pickerRpc!.request.runCli({ args: [TILER_CLI, 'install', 'terrain-service'] });
      setInstall({ id, line: 'Downloading…' });
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const job = await pickerRpc!.request.cliStatus({ id }).catch(() => null);
        if (!job) { setInstall(null); return say('The download job is gone.', 'err'); }
        const last = job.tail.filter((l) => l.trim() && !l.startsWith('[desktop]') && !l.startsWith('$ ')).pop()?.trim() ?? '';
        if (job.state === 'running') { setInstall({ id, line: last }); continue; }
        setInstall(null);
        await ask('refresh');
        if (job.state === 'done') { say('Terrain service downloaded and checked.', 'ok'); void ask('start'); }
        else if (job.state === 'cancelled') say('Download cancelled.');
        else say(`Download failed: ${last.replace(/^error: /, '')}`, 'err');
        return;
      }
    } catch (e) { setInstall(null); say(`Could not download: ${e instanceof Error ? e.message : e}`, 'err'); }
  }

  const state = install ? 'installing' : !st ? 'checking' : st.state === 'stopped' && !st.installed ? 'missing' : st.state;
  const pill: Record<string, { label: string; cls: string }> = {
    running: { label: 'Running', cls: HEALTH_LOOK.ok.cls },
    error: { label: 'Error', cls: HEALTH_LOOK.err.cls },
    starting: { label: 'Starting', cls: '' },
    installing: { label: 'Downloading', cls: '' },
    stopped: { label: 'Stopped', cls: '' },
    missing: { label: 'Not installed', cls: '' },
    checking: { label: '…', cls: '' },
  };
  const look = pill[state]!;
  const mb = st?.bytes ? `${Math.round(st.bytes / 1e6)} MB` : '';
  const detail = st?.state === 'running'
    ? `${st.owned ? `Started by this app${st.pid ? ` (process ${st.pid})` : ''}` : 'Already running, not started by this app: left running on Stop'}. Listens on 127.0.0.1 only.`
    : st?.message || st?.hint || '';

  return (
    <Card id="terrain-service">
      <CardHead>
        <CardTitle>Terrain service</CardTitle>
        <Tip text={detail || undefined}><span data-state={state} id="terrain-state"><Chip className={look.cls}>{look.label}</Chip></span></Tip>
        <Info label="About the terrain service">
          <p className="m-0">Terrain Viewer's tile service (Iconem, MIT): any DEM as <strong>quantized-mesh</strong> terrain and as tiles of its analyses, computed per tile on this machine.</p>
          <p className="m-0">Downloaded once from its GitHub release ({st?.version ?? 'pinned'}), checked against a pinned SHA-256, kept in this app's tools folder. A service already running on port 3400 (Terrain Viewer's desktop app) is used as it is.</p>
        </Info>
        <CardHeadActions>
          {install ? (
            <Button id="terrain-cancel" variant="ghost" onClick={() => void pickerRpc?.request.cancelCli({ id: install.id })}>Cancel</Button>
          ) : state === 'missing' ? (
            <Tip text={st?.downloadable ? st.hint ?? undefined : st?.hint || 'No bundle is published for this platform.'}>
              <Button id="terrain-download" disabled={!host || !st?.downloadable} onClick={download}>{st?.downloadable ? `Download${mb ? `, ${mb}` : ''}` : 'Not available here'}</Button>
            </Tip>
          ) : state === 'running' || state === 'starting' ? (
            <Button id="terrain-stop" variant="outline" disabled={!host} onClick={() => void ask('stop')}>{st?.owned || state === 'starting' ? 'Stop' : 'Disconnect'}</Button>
          ) : (
            <Button id="terrain-start" disabled={!host || state === 'checking'} onClick={() => void ask('start')}>Start</Button>
          )}
          {st?.url && (
            <DropdownMenu>
              <Tip text="More"><DropdownMenuTrigger render={<Button id="terrain-menu" size="icon" variant="ghost" aria-label="More" />}><MoreHorizontalIcon className="size-4" /></DropdownMenuTrigger></Tip>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onClick={() => openExternal(`${st.url}/docs`)}>API and quick start</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openExternal(`${st.url}/terrain-sources`)}>Library sources (JSON)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => { void navigator.clipboard.writeText(st.url!).then(() => toast.success('Address copied')); }}>Copy address</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </CardHeadActions>
      </CardHead>
      {install && <Hint id="terrain-install-line" className="truncate font-mono">{install.line}</Hint>}
      {!install && st?.url && <Hint id="terrain-url" className="font-mono">{st.url}</Hint>}
      {!install && st?.state === 'error' && st.message && <Hint className="text-destructive">{st.message}</Hint>}
    </Card>
  );
}

const roField = 'h-8 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-2.5 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25';

/** Does the source answer through the service? One GET of its layer.json when the row appears or the address moves, and on a click. */
function useLayerHealth(url: string): [Health, () => void] {
  const [h, setH] = useState<Health>({ state: 'idle', detail: '' });
  const [nonce, setNonce] = useState(1);
  useEffect(() => {
    if (!url) { setH({ state: 'idle', detail: '' }); return; }
    const ac = new AbortController();
    let gone = false;
    const timer = setTimeout(() => ac.abort(), 60_000);
    setH({ state: 'checking', detail: 'Requesting the layer.json…' });
    (async () => {
      try {
        const t0 = performance.now();
        const r = await fetch(url, { signal: ac.signal });
        const ms = Math.round(performance.now() - t0);
        if (gone) return;
        if (!r.ok) return setH({ state: 'err', detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` });
        const j = await r.json();
        setH({ state: 'ok', detail: `Answers in ${ms} ms: ${j.format ?? 'terrain'}, zoom ${j.minzoom ?? 0} to ${j.maxzoom ?? '?'}${j.attribution ? `, ${j.attribution}` : ''}. Click to check again.` });
      } catch (e) {
        if (!gone) setH({ state: 'err', detail: ac.signal.aborted ? 'No answer in 60 s.' : `Request failed: ${e}` });
      } finally { clearTimeout(timer); }
    })();
    return () => { gone = true; clearTimeout(timer); ac.abort(); };
  }, [url, nonce]);
  return [h, () => setNonce((n) => n + 1)];
}

function SourceRow({ s, base, onPatch, onRemove }: { s: TerrainSource; base: string; onPatch: (p: Partial<TerrainSource>) => void; onRemove: () => void }) {
  const url = terrainUrl(base, s);
  const [health, recheck] = useLayerHealth(base ? layerJsonUrl(base, s) : '');
  const look = HEALTH_LOOK[health.state];
  const [name, setName] = useState(s.name);
  const commit = () => { const n = name.trim() || nameOf(s.src); setName(n); if (n !== s.name) onPatch({ name: n }); };
  return (
    <li data-terrain-id={s.id} className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1">
        <input aria-label="Source name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(s.name); e.currentTarget.blur(); } }}
          className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 text-sm font-medium text-foreground outline-none hover:border-input focus-visible:border-ring" />
        {s.encoding && <Chip>{ENCODINGS.find((e) => e.value === s.encoding)?.label ?? s.encoding}</Chip>}
        {base && (
          <Tip text={health.detail || 'Request the layer.json once to see that it answers'}>
            <button type="button" data-health={health.state} aria-label={`Status: ${look.label}. Check again`} onClick={recheck} className="cursor-pointer rounded-full">
              <Chip className={look.cls}>{look.label}</Chip>
            </button>
          </Tip>
        )}
        <Tip text="Open the source in Terrain Viewer (web)">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Open in Terrain Viewer" data-action="open" onClick={() => openExternal(viewerLinkOf(s))}><ExternalLinkIcon /></Button>
        </Tip>
        <Tip text="Remove"><Button size="icon" variant="ghost" className="size-7" aria-label="Remove" data-action="remove" onClick={onRemove}><Trash2Icon /></Button></Tip>
      </div>
      <div className="mt-1 flex flex-col gap-1.5">
        <Tip text={s.src}><input aria-label="Source" readOnly value={s.src} spellCheck={false} className={cn(roField, 'border-transparent bg-transparent text-muted-foreground')} /></Tip>
        <UrlBar>
          <Choice value={s.output} onChange={(v) => onPatch({ output: v })} options={OUTPUTS} className="h-8 w-40 flex-none text-xs" />
          <input aria-label="Terrain URL" readOnly value={url} placeholder="Start the service" spellCheck={false} data-field="url"
            onFocus={(e) => e.target.select()} className={cn(roField, 'placeholder:font-sans placeholder:text-muted-foreground/70')} />
          <CopyButton text={url} title={s.output === 'qm' ? 'Copy layer.json URL' : 'Copy tile URL'} variant="outline" className="size-8" />
        </UrlBar>
      </div>
    </li>
  );
}

export function TerrainTab({ app, active }: { app: AppModel; active: boolean }) {
  const svc = useService(active);
  const base = svc.st?.state === 'running' ? svc.st.url ?? '' : '';
  const [list, setList] = useState<TerrainSource[]>(load);
  const change = useCallback((f: (l: TerrainSource[]) => TerrainSource[]) => setList((l) => { const next = f(l); save(next); return next; }), []);
  const [src, setSrc] = useState('');
  const [encoding, setEncoding] = useState('');

  function add(value = src, enc = encoding) {
    const v = value.trim();
    if (!v) return app.say('Enter a tile template, a COG address or a library id.', 'err');
    if (list.some((e) => e.src === v && e.encoding === enc)) return app.say('That source is already in the list.');
    change((l) => [...l, { id: newId(), name: nameOf(v), src: v, encoding: enc, output: 'qm', addedAt: Date.now() }]);
    setSrc('');
  }
  function remove(s: TerrainSource) {
    const at = list.indexOf(s);
    change((l) => l.filter((e) => e.id !== s.id));
    toast(`${s.name} removed`, { action: { label: 'Undo', onClick: () => change((l) => { const n = [...l]; n.splice(Math.min(at, n.length), 0, s); return n; }) } });
  }

  return (
    <>
      <ServiceCard svc={svc} say={app.say} />
      <Card id="terrain-sources">
        <CardHead>
          <CardTitle>Sources</CardTitle>
          {list.length > 0 && <span className="text-xs text-muted-foreground">{list.length}</span>}
          <Info label="About terrain sources">
            <p className="m-0">A <strong>tile template</strong> (Terrarium or Terrain-RGB, with {'{z}/{x}/{y}'}), a <strong>COG</strong> or <strong>VRT</strong> address, or an id of the service's library (<strong>mapterhorn</strong>, see the menu above).</p>
            <p className="m-0">Each row gives the <strong>layer.json</strong> for Cesium clients, or the XYZ tiles of one analysis. Heights are on the WGS84 ellipsoid (the EGM96 geoid added).</p>
          </Info>
        </CardHead>
        <form className="flex items-stretch gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <TextInput id="terrain-src" aria-label="Terrain source" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://…/{z}/{x}/{y}.png, a .tif, or mapterhorn" className="min-w-0 flex-1" />
          <Choice id="terrain-encoding" value={encoding} onChange={setEncoding} options={ENCODINGS} title="How the source is encoded" className="w-32 flex-none" />
          <Button id="terrain-add" type="submit" variant="outline" className="gap-1.5"><PlusIcon className="size-4" />Add</Button>
        </form>
        {list.length === 0 ? (
          <Hint className="mt-2">Nothing yet. <button type="button" id="terrain-sample" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-foreground underline-offset-2 hover:underline" onClick={() => add(SAMPLE, 'terrarium')}>Add AWS Terrain Tiles</button></Hint>
        ) : (
          <ul id="terrain-list" className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {list.map((s) => (
              <SourceRow key={s.id} s={s} base={base} onPatch={(p) => change((l) => l.map((e) => (e.id === s.id ? { ...e, ...p } : e)))} onRemove={() => remove(s)} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

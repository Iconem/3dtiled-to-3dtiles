/**
 * Launcher view — builds a tileset URL, exercises it against the locally-spawned tile-server, and
 * keeps a small library of datasets you care about.
 *
 * Five tabs, one job each:
 *   Stream live — a tiled dataset as a paste-ready URL, converted on demand.
 *   Export      — the same dataset (one card, shown above both tabs) written to a folder.
 *   Tile raw input — a third-party tiler run on input that is not tiled yet; it has its own input field.
 *   Terrain     — a DEM as quantized-mesh terrain and analysis tiles, through Terrain Viewer's tile service (TerrainTab).
 *   Library     — the samples (folded), bookmarks with a cached structural check (tiles/depth/leaves from
 *                 /stats), and a history of what was served or exported.
 *
 * This file is the shell: header (status, help, settings), tabs, the preview overlay, and the state the tabs share
 * (the dataset form, the library). The tabs are in their own files. A passing message is a toast; what a run says
 * stays in its card.
 */
import { CircleHelpIcon, SettingsIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Choice, Field, Segmented, Tip } from './components/bits';
import { ExportCard } from './ExportCard';
import { LINKS } from './catalog';
import { RELEASE_URL, setServerWorkers, base, buildLabel, docsUrl, fitWindowForPreview, openExternal, pickerAvailable, pickerRpc, restoreWindow, staticPort, tilePort, viewerUrl } from './host';
import { LibraryTab } from './LibraryTab';
import { TerrainTab } from './TerrainTab';
import { TilerCard } from './TilerCard';
import { loadLibrary, noteServed, parseLibrary, saveLocal, serialize, type DatasetOptions, type Library } from './library';
import { DatasetCard, StreamTab, WORKERS, WORKERS_TITLE } from './StreamTab';
import { THEMES, useTheme, type Theme } from './theme';
import { buildUrlFrom, EMPTY_FORM, nameFor, previewUrl, typeOfFormat, viewerLink } from './urls';
import type { Kind } from './components/bits';

export type Renderer = 'cesium' | '3dtrjs';

/** What the tabs share. */
export interface AppModel {
  form: Required<DatasetOptions>;
  patchForm: (p: Partial<Required<DatasetOptions>>) => void;
  /** The current form, as a dataset to bookmark or record. */
  dataset: () => DatasetOptions;
  url: string;
  lib: Library;
  /** Change the library in place and persist it (localStorage, and the file through the host). */
  updateLib: (mutate: (l: Library) => void) => void;
  replaceLib: (l: Library) => void;
  say: (msg: string, kind?: Kind) => void;
  showTab: (name: string) => void;
  previewIn: (renderer: Renderer, tileset: string, type: string, title: string) => void;
  openTool: (url: string, title: string) => void;
  loadIntoBuilder: (e: DatasetOptions) => void;
  /** The current dataset was served (copied, previewed, tested): note it in the history. */
  noteServedNow: () => void;
  /** Tile worker threads of the app's server ('' = one, 'auto', or a count): one setting for streaming and exports. */
  workers: string;
  setWorkers: (v: string) => void;
}

// The choice this machine keeps: how many threads the server builds tiles on.
const WORKERS_KEY = '3dtiled-desktop-tile-workers';
const footLink = 'rounded text-muted-foreground no-underline hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none';

interface Overlay {
  url: string;
  title: string;
  /** The tileset shown, for the renderer switch; empty for a tool page. */
  target: { tileset: string; type: string; external: string };
  renderer: Renderer | null;
}

const TAB_TITLES = {
  stream: 'A tiled dataset (COPC, Potree, SOG, RAD, LCC, I3S…) as a 3D Tiles URL, converted on demand',
  export: 'The same dataset written to a folder as 3D Tiles',
  tile: 'A raw point cloud, mesh or splat file that is not tiled yet: run a tiler on it',
  terrain: 'A DEM (Terrarium, Terrain-RGB, COG…) as quantized-mesh terrain and hillshade, slope… tiles, served on this machine',
  library: 'Samples, bookmarks, and what you served or exported',
} as const;
const TAB_LABELS = { stream: 'Stream live', export: 'Export', tile: 'Tile raw input', terrain: 'Terrain', library: 'Library' } as const;

export function App() {
  const [theme, , setTheme] = useTheme();
  const [tab, setTab] = useState('stream');
  // Auto unless this machine chose otherwise: the server is told at start and on every change.
  const [workers, setWorkersState] = useState(() => localStorage.getItem(WORKERS_KEY) ?? 'auto');
  const setWorkers = (v: string) => { setWorkersState(v); localStorage.setItem(WORKERS_KEY, v); };
  useEffect(() => { void setServerWorkers(workers); }, [workers]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [version, setVersion] = useState<{ label: string; title: string } | null>(null);
  const [update, setUpdate] = useState<{ title: string; applying: boolean } | null>(null);
  const [lib, setLibState] = useState<Library>(loadLibrary);
  const libRef = useRef(lib);
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  const say = useCallback((msg: string, kind: Kind = 'info') => { if (kind === 'ok') toast.success(msg); else if (kind === 'err') toast.error(msg, { duration: 8000 }); else toast(msg); }, []);
  const patchForm = useCallback((p: Partial<Required<DatasetOptions>>) => setForm((f) => ({ ...f, ...p })), []);
  const url = buildUrlFrom(form);

  // ── library ───────────────────────────────────────────────────────────────────────────────────
  const replaceLib = useCallback((next: Library) => {
    libRef.current = next;
    setLibState(next);
    saveLocal(next);
    if (pickerAvailable()) pickerRpc!.request.writeLibrary({ json: serialize(next) }).catch(() => { /* localStorage still has it */ });
  }, []);
  const updateLib = useCallback((mutate: (l: Library) => void) => {
    const next: Library = { bookmarks: [...libRef.current.bookmarks], history: [...libRef.current.history] };
    mutate(next);
    replaceLib(next);
  }, [replaceLib]);

  const dataset = useCallback((): DatasetOptions => ({
    src: form.src.trim(), format: form.format, cache: form.cache,
    lon: form.lon.trim(), lat: form.lat.trim(), alt: form.alt.trim(), heading: form.heading.trim(), scale: form.scale.trim(),
  }), [form]);
  const noteServedNow = useCallback(() => {
    const f = dataset();
    updateLib((l) => noteServed(l, nameFor(f.src), f));
  }, [dataset, updateLib]);

  const loadIntoBuilder = useCallback((e: DatasetOptions) => {
    setForm({ src: e.src, format: e.format ?? '', cache: e.cache ?? 'none', lon: e.lon ?? '', lat: e.lat ?? '', alt: e.alt ?? '', heading: e.heading ?? '', scale: e.scale ?? '' });
  }, []);

  // The window keeps the size it has, whatever the tab or the tool shows: a taller page scrolls. Only a preview asks
  // for more room, and gives it back when it closes.

  // ── preview over the launcher ─────────────────────────────────────────────────────────────────
  //
  // Cesium is the stock harness, with zero viewer-side fix-ups: whatever it shows is what any 3D Tiles
  // client gets from the tileset alone. 3DTRjs is the demo viewer, told to load the tileset.
  const showInOverlay = useCallback((next: Overlay) => {
    if (overlayRef.current == null) fitWindowForPreview();
    setOverlay(next);
  }, []);
  const previewIn = useCallback((renderer: Renderer, tileset: string, type: string, title: string) => {
    const u = renderer === 'cesium' ? previewUrl(tileset) : viewerLink(tileset, type);
    if (!u) return say(renderer === 'cesium' ? 'Preview unavailable: the static server for cesium-harness.html did not start.' : 'Preview unavailable: no demo viewer address.', 'err');
    showInOverlay({ url: u, title, target: { tileset, type, external: u }, renderer });
  }, [say, showInOverlay]);
  const openTool = useCallback((u: string, title: string) => {
    showInOverlay({ url: u, title, target: { tileset: '', type: '', external: u }, renderer: null });
  }, [showInOverlay]);
  const closeOverlay = () => {
    setOverlay(null);          // the iframe unmounts, which frees the renderer's GPU memory
    restoreWindow();
  };

  // ── boot ──────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pickerAvailable()) return;
    void (async () => {
      const info = await pickerRpc!.request.appInfo({}).catch(() => null);
      if (info?.version) {
        setVersion({ label: `v${buildLabel(info.version, info.hash)}`, title: `Version ${info.version} (the build day), build ${info.hash ?? 'unknown'}` });
      }
      // The file wins; a first run with this version starts it from what localStorage holds.
      const stored = await pickerRpc!.request.readLibrary({}).catch(() => null);
      try {
        if (stored) { const l = parseLibrary(stored); libRef.current = l; setLibState(l); saveLocal(l); }
        else if (libRef.current.bookmarks.length) replaceLib(libRef.current);
      } catch { /* a corrupt file: keep what localStorage has */ }
    })();
  }, [replaceLib]);

  // A downloaded update waits for this button: restarting by itself could end a running conversion.
  useEffect(() => {
    const poll = setInterval(async () => {
      const status = await pickerRpc?.request.updateStatus({}).catch(() => null);
      if (status?.version == null) return;
      setUpdate({ title: `Restart into ${buildLabel(status.version, status.hash)}`, applying: false });
      clearInterval(poll);
    }, 30_000);
    return () => clearInterval(poll);
  }, []);
  const applyUpdate = () => {
    setUpdate((u) => (u ? { ...u, applying: true } : u));
    void pickerRpc?.request.applyUpdate({});
  };

  const app: AppModel = { form, patchForm, dataset, url, lib, updateLib, replaceLib, say, showTab: setTab, previewIn, openTool, loadIntoBuilder, noteServedNow, workers, setWorkers };

  // The pill says what the server does now, not what the ports said at start: it is probed every 10 s.
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  useEffect(() => {
    if (!base) return;
    let stop = false;
    const probe = async () => {
      try { const r = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(3000) }); if (!stop) setServerUp(r.ok); }
      catch { if (!stop) setServerUp(false); }
    };
    void probe();
    const t = setInterval(probe, 10_000);
    return () => { stop = true; clearInterval(t); };
  }, []);
  const status = !tilePort
    ? { text: 'Starting…', title: 'The tile-server is starting', dot: 'bg-warning' }
    : serverUp === false
      ? { text: 'Server not answering', title: `The tile-server does not answer on port ${tilePort}`, dot: 'bg-destructive' }
      : { text: 'Running', title: `The tile-server is ${serverUp ? 'running' : 'ready'} on port ${tilePort}: nothing is uploaded, the conversion happens on this machine`, dot: 'bg-success' };
  const links: [string, string, string][] = [
    ['link-viewer', viewerUrl, 'Web viewer'],
    ['link-explorer', viewerUrl ? `${viewerUrl}/hierarchy` : (base ? `${base}/hierarchy` : ''), 'Hierarchy explorer'],
    ['link-plugins', LINKS.cesiumUnreal, 'Cesium for Unreal'],
    ['link-repo', LINKS.repo, 'Source'],
  ];

  return (
    <TooltipProvider delay={400}>
      <Toaster theme={theme} position="bottom-center" />
      {/* Centred, in a window that opens at about this width (WIN in bun/index.ts). Measured on Windows at 150%:
          a 1680 px window, a 1106 CSS px viewport at devicePixelRatio 1.5, so the page sees the real window. Older
          Electrobun builds reported a viewport wider than the frame, which clipped centred content: check any
          change here in the real app, as a plain browser cannot show that.
          A column at least as tall as the window, so the footer sits at the bottom of a short tab. */}
      <div className="mx-auto flex min-h-screen max-w-[720px] flex-col px-6 pt-5 pb-3">
        <header className="mb-4 flex items-center gap-2">
          <h1 className="m-0 text-lg font-semibold tracking-tight">3D Tiled</h1>
          <Tip text={status.title} side="bottom"><div id="status" className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn('size-2 rounded-full', status.dot)} />{status.text}</div></Tip>
          <span className="flex-1" />
          <Tip text={update?.title} side="bottom"><Button id="update" variant="default" hidden={!update} disabled={update?.applying} onClick={applyUpdate}>Update ready: restart</Button></Tip>

          <DropdownMenu>
            <Tip text="Help and links" side="bottom"><DropdownMenuTrigger render={<Button id="help" size="icon" variant="ghost" aria-label="Help and links" />}><CircleHelpIcon /></DropdownMenuTrigger></Tip>
            <DropdownMenuContent align="end" className="min-w-52">
              {docsUrl && <DropdownMenuItem id="link-docs" onClick={() => openExternal(docsUrl)}>Documentation</DropdownMenuItem>}
              {links.map(([id, href, label]) => href && <DropdownMenuItem key={id} id={id} onClick={() => openExternal(href)}>{label}</DropdownMenuItem>)}
              <DropdownMenuSeparator />
              {tilePort && <DropdownMenuItem id="port-tiles" onClick={() => openExternal(`${base}/`)}>{`Tile-server home (port ${tilePort})`}</DropdownMenuItem>}
              {staticPort && <DropdownMenuItem id="port-preview" onClick={() => openExternal(`http://127.0.0.1:${staticPort}/`)}>{`Preview server (port ${staticPort})`}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog>
            <Tip text="Settings" side="bottom"><DialogTrigger render={<Button id="settings" size="icon" variant="ghost" aria-label="Settings" />}><SettingsIcon /></DialogTrigger></Tip>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Settings</DialogTitle>
                <DialogDescription>Kept on this machine.</DialogDescription>
              </DialogHeader>
              <Field label="Theme">
                <Segmented id="theme" value={theme} onChange={(v) => setTheme(v as Theme)} options={THEMES.map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) }))} />
              </Field>
              <Field label="Tile threads" info={<p className="m-0">{WORKERS_TITLE}</p>}>
                <Choice id="stream-workers" value={workers} onChange={setWorkers} options={WORKERS} />
              </Field>
            </DialogContent>
          </Dialog>
        </header>

        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-0">
          {/* Tabs as a browser draws them: a rule across the window, the open tab underlined on it. */}
          <TabsList id="tabs" variant="line" className="mb-4 w-full items-end justify-start gap-1 rounded-none border-b border-border p-0 group-data-horizontal/tabs:h-auto">
            {(['stream', 'export', 'tile', 'terrain', 'library'] as const).map((name) => (
              <Tip key={name} text={TAB_TITLES[name]} side="bottom">
                <TabsTrigger value={name} data-tab={name}
                  className="h-10 flex-none gap-2 rounded-none border-0 px-4 text-sm font-medium text-muted-foreground hover:text-foreground data-active:text-foreground group-data-horizontal/tabs:after:-bottom-px">
                  {TAB_LABELS[name]}
                  {name === 'library' && lib.bookmarks.length > 0 && <span id="lib-count" className="text-xs text-muted-foreground">{lib.bookmarks.length}</span>}
                </TabsTrigger>
              </Tip>
            ))}
          </TabsList>
          {/* One dataset for the two tabs that take a tiled source: it stays what it was when you go from one to the other. */}
          <div id="dataset" hidden={tab !== 'stream' && tab !== 'export'}><DatasetCard app={app} /></div>
          {/* Kept mounted: an export carries on while you switch tabs. */}
          <TabsContent value="stream" id="panel-stream" keepMounted><StreamTab app={app} /></TabsContent>
          <TabsContent value="export" id="panel-export" keepMounted><ExportCard app={app} /></TabsContent>
          <TabsContent value="tile" id="panel-tile" keepMounted><TilerCard app={app} onStream={() => setTab('stream')} /></TabsContent>
          <TabsContent value="terrain" id="panel-terrain" keepMounted><TerrainTab app={app} active={tab === 'terrain'} /></TabsContent>
          <TabsContent value="library" id="panel-library" keepMounted><LibraryTab app={app} /></TabsContent>
        </Tabs>

        <footer className="mt-auto pt-3 text-xs text-muted-foreground">
          {version && <Tip text={`${version.title}. Opens the release on GitHub.`}><a id="version" href={RELEASE_URL} target="_blank" rel="noreferrer" className={footLink}>{version.label}</a></Tip>}
        </footer>
      </div>

      {/* Previews and tools open over the launcher, which keeps running (an export carries on) and is one click back. */}
      {overlay && (
        <div id="overlay" className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
            <Button id="overlay-back" onClick={closeOverlay}>&larr; Back to menu</Button>
            {overlay.renderer && (
              <div id="overlay-renderers" className="flex gap-1">
                {(['cesium', '3dtrjs'] as const).map((r) => (
                  <Button key={r} id={`overlay-${r}`} className={cn(overlay.renderer === r && 'border-primary bg-primary text-primary-foreground hover:bg-primary')}
                    onClick={() => previewIn(r, overlay.target.tileset, overlay.target.type, overlay.title)}>
                    {r === 'cesium' ? 'Cesium' : '3DTRjs'}
                  </Button>
                ))}
              </div>
            )}
            <span id="overlay-title" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{overlay.title}</span>
            <Button id="overlay-external" variant="ghost" onClick={() => openExternal(overlay.target.external)}>Open in browser</Button>
          </div>
          <iframe id="overlay-frame" title="Preview" allow="fullscreen; clipboard-write" src={overlay.url} className="w-full flex-1 border-0 bg-black" />
        </div>
      )}
    </TooltipProvider>
  );
}

export { THEMES, typeOfFormat };

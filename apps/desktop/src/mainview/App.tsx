/**
 * Launcher view — builds a tileset URL, exercises it against the locally-spawned tile-server, and
 * keeps a small library of datasets you care about.
 *
 * Three tabs, one job each:
 *   Build    — a dataset, then two flows: live-stream (a paste-ready URL) or export to disk. Everything
 *              else is folded under Advanced.
 *   Library  — bookmarks, with a cached structural check (tiles/depth/leaves from /stats), and a
 *              history of what was served or exported.
 *   Samples  — a real dataset for every format the middleware reads, one click into Build.
 *
 * This file is the shell: header, tabs, footer, the preview overlay, and the state the tabs share
 * (the dataset form, the library, the status line). The tabs are in their own files.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { BuildTab } from './BuildTab';
import { LINKS } from './catalog';
import { RELEASE_URL, setServerWorkers, base, buildLabel, docsUrl, fitWindowForPreview, fitWindowToContent, openExternal, pickerAvailable, pickerRpc, resetFit, staticPort, tilePort, viewerUrl } from './host';
import { LibraryTab } from './LibraryTab';
import { loadLibrary, noteServed, parseLibrary, saveLocal, serialize, type DatasetOptions, type Library } from './library';
import { SamplesTab } from './SamplesTab';
import { THEMES, nextTheme, useTheme, type Theme } from './theme';
import { buildUrlFrom, EMPTY_FORM, nameFor, previewUrl, typeOfFormat, viewerLink } from './urls';
import type { Kind, Message } from './components/bits';

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
  /** The library's lists as one-line rows (true) or cards. */
  libCompact: boolean;
}

// The choices this machine keeps: the library's view, and how many threads the server builds tiles on.
const LIB_VIEW_KEY = '3dtiled-desktop-library-view';
const WORKERS_KEY = '3dtiled-desktop-tile-workers';
const segTab = 'h-6 flex-none rounded-sm border-0 px-[9px] text-xs font-medium text-muted-foreground shadow-none hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-xs dark:data-active:border-0 dark:data-active:bg-background';

const footLink = 'rounded text-muted-foreground no-underline hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none';
const THEME_ICONS: Record<Theme, React.ReactNode> = {
  system: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  dark: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
};

interface Overlay {
  url: string;
  title: string;
  /** The tileset shown, for the renderer switch; empty for a tool page. */
  target: { tileset: string; type: string; external: string };
  renderer: Renderer | null;
}

export function App() {
  const [theme, cycleTheme] = useTheme();
  const [tab, setTab] = useState('build');
  const [libCompact, setLibCompact] = useState(() => localStorage.getItem(LIB_VIEW_KEY) !== 'detailed');
  const setLibView = (c: boolean) => { setLibCompact(c); localStorage.setItem(LIB_VIEW_KEY, c ? 'compact' : 'detailed'); };
  // Auto unless this machine chose otherwise: the server is told at start and on every change.
  const [workers, setWorkersState] = useState(() => localStorage.getItem(WORKERS_KEY) ?? 'auto');
  const setWorkers = (v: string) => { setWorkersState(v); localStorage.setItem(WORKERS_KEY, v); };
  useEffect(() => { void setServerWorkers(workers); }, [workers]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [message, setMessage] = useState<Message | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [version, setVersion] = useState<{ label: string; title: string } | null>(null);
  const [update, setUpdate] = useState<{ title: string; applying: boolean } | null>(null);
  const [lib, setLibState] = useState<Library>(loadLibrary);
  const libRef = useRef(lib);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  const say = useCallback((msg: string, kind: Kind = 'info') => setMessage({ msg, kind }), []);
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
    lon: form.lon.trim(), lat: form.lat.trim(), alt: form.alt.trim(), heading: form.heading.trim(),
  }), [form]);
  const noteServedNow = useCallback(() => {
    const f = dataset();
    updateLib((l) => noteServed(l, nameFor(f.src), f));
  }, [dataset, updateLib]);

  const loadIntoBuilder = useCallback((e: DatasetOptions) => {
    setForm({ src: e.src, format: e.format ?? '', cache: e.cache ?? 'none', lon: e.lon ?? '', lat: e.lat ?? '', alt: e.alt ?? '', heading: e.heading ?? '' });
  }, []);

  // ── window sizing ─────────────────────────────────────────────────────────────────────────────
  // Panels differ hugely in height (Build is short, Samples is a 20-row catalogue), and the Advanced
  // folds open and close: re-measure after every commit, and when the column's size changes on its
  // own (fonts, the log tail). The host is only asked when the measurement changed.
  useEffect(() => {
    const id = requestAnimationFrame(() => fitWindowToContent(containerRef.current, overlayRef.current != null));
    return () => cancelAnimationFrame(id);
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(() => fitWindowToContent(el, overlayRef.current != null)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    resetFit();
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

  const app: AppModel = { form, patchForm, dataset, url, lib, updateLib, replaceLib, say, showTab: setTab, previewIn, openTool, loadIntoBuilder, noteServedNow, workers, setWorkers, libCompact };

  const themeTitle = `Theme: ${theme}. Click for ${nextTheme(theme)}.`;
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
    ? { text: 'starting the tile-server…', cls: 'border-warning/35 bg-warning/10 text-warning' }
    : serverUp === false
      ? { text: `tile-server not answering on :${tilePort}`, cls: 'border-destructive/40 bg-destructive/10 text-destructive' }
      : { text: `tile-server ${serverUp ? 'running' : 'ready'} on :${tilePort}`, cls: 'border-success/35 bg-success/10 text-success' };
  const links: [string, string, string][] = [
    ['link-viewer', viewerUrl, 'Web viewer'],
    ['link-explorer', viewerUrl ? `${viewerUrl}/hierarchy` : (base ? `${base}/hierarchy` : ''), 'Hierarchy explorer'],
    ['link-plugins', LINKS.cesiumUnreal, 'Cesium for Unreal'],
    ['link-repo', LINKS.repo, 'Source'],
  ];

  return (
    <>
      {/* Centred, in a window that opens at about this width (WIN in bun/index.ts). Measured on Windows at 150%:
          a 1680 px window, a 1106 CSS px viewport at devicePixelRatio 1.5, so the page sees the real window. Older
          Electrobun builds reported a viewport wider than the frame, which clipped centred content: check any
          change here in the real app, as a plain browser cannot show that.
          A column at least as tall as the window, so the footer sits at the bottom of a short tab. */}
      <div ref={containerRef} className="mx-auto flex min-h-screen max-w-[720px] flex-col px-[26px] pt-6 pb-3.5">
        <header className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-lg font-semibold tracking-[-0.02em]">3D&nbsp;Tiled <span className="ml-2 text-[13px] font-normal text-muted-foreground">local middleware</span></h1>
          <div id="status" className={cn('ml-auto rounded-full border px-2.5 py-[5px] text-[11.5px] leading-none font-medium whitespace-nowrap', status.cls)}>{status.text}</div>
          <Button id="update" variant="default" hidden={!update} disabled={update?.applying} title={update?.title} onClick={applyUpdate}>Update ready: restart</Button>
          {docsUrl && (
            <Button id="link-docs" size="icon" type="button" title="Documentation" aria-label="Documentation" onClick={() => openExternal(docsUrl)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></svg>
            </Button>
          )}
          <Button id="theme" size="icon" type="button" title={themeTitle} aria-label={themeTitle} onClick={cycleTheme}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{THEME_ICONS[theme]}</svg>
          </Button>
        </header>

        <p className="mt-2.5 mb-5 text-[13.5px] text-muted-foreground">
          Turn a tiled dataset, on this machine or at a URL, into <strong className="font-medium text-foreground">OGC 3D Tiles</strong>.
          Nothing is uploaded: the conversion happens here.
        </p>

        <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-0">
          <div className="mb-3.5 flex items-center gap-3">
          <TabsList id="tabs" className="h-auto gap-0.5 self-start rounded-md p-[3px]">
            {(['build', 'library', 'samples'] as const).map((name) => (
              <TabsTrigger key={name} value={name} data-tab={name}
                className="h-[30px] flex-none gap-[7px] rounded-sm border-0 px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-xs dark:data-active:border-0 dark:data-active:bg-background">
                {name === 'build' ? 'Build' : name === 'library' ? 'Library' : 'Samples'}
                {name === 'library' && <span id="lib-count" className="rounded-full bg-background px-1.5 py-[3px] text-[11px] leading-none text-muted-foreground">{lib.bookmarks.length}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Rows or cards: for both of the library's lists, so it sits with the tabs, not in one of the lists. */}
          {tab === 'library' && (
            <Tabs value={libCompact ? 'rows' : 'cards'} onValueChange={(v) => setLibView(v === 'rows')} className="ml-auto gap-0">
              <TabsList aria-label="Library view" className="h-auto gap-0.5 rounded-md p-0.5">
                <TabsTrigger id="lib-view-rows" value="rows" title="One line per entry: its title and buttons" className={segTab}>Rows</TabsTrigger>
                <TabsTrigger id="lib-view-cards" value="cards" title="Cards with the source, options and stats" className={segTab}>Cards</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          </div>
          {/* Kept mounted: an export carries on while you switch tabs. */}
          <TabsContent value="build" id="panel-build" keepMounted><BuildTab app={app} message={message} /></TabsContent>
          <TabsContent value="library" id="panel-library" keepMounted><LibraryTab app={app} /></TabsContent>
          <TabsContent value="samples" id="panel-samples" keepMounted><SamplesTab app={app} /></TabsContent>
        </Tabs>

        <footer className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
          {version && <a id="version" href={RELEASE_URL} target="_blank" rel="noreferrer" title={`${version.title}. Opens the release on GitHub.`} className={footLink}>{version.label}</a>}
          <span id="ports">
            {tilePort ? <a id="port-tiles" href={`${base}/`} target="_blank" rel="noreferrer" title="The tile-server's home page, in your browser" className={footLink}>{`tile-server :${tilePort}`}</a> : 'tile-server :—'}
            {' · '}
            {staticPort ? <a id="port-preview" href={`http://127.0.0.1:${staticPort}/`} target="_blank" rel="noreferrer" title="The preview server, in your browser" className={footLink}>{`preview :${staticPort}`}</a> : 'preview :—'}
          </span>
          <span className="flex-1" />
          {links.map(([id, href, label]) => href && (
            <a key={id} id={id} href={href} target="_blank" rel="noreferrer" className={footLink}>{label}</a>
          ))}
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
    </>
  );
}

export { THEMES, typeOfFormat };

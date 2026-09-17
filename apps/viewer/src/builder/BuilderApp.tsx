/**
 * Aggregate Builder — assemble a mosaic of 3D Tiles datasets by hand (the kind /aggregate builds
 * automatically), then export it as a tileset.json or an aggregate-set manifest, or preview it in the
 * viewer through a server-side draft.
 *
 * Query params: `?import=<index.json or /aggregate tileset URL>` preloads the library with that
 * selection; `?tileset=<tileset.json URL>` imports an existing aggregate/builder tileset as the tree.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Boxes, ClipboardCopy, Download, FileJson, FilePlus, Link, Loader2, Play, Redo2, Undo2, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import * as tree from './tree';
import { counts, createTree, leaves, updateNode, type Row } from './tree';
import { fromProject, fromTileset, toManifest, toProject, toTileset } from './export';
import { download, postDraft, slug } from './api';
import { useBuilder } from './store';
import { Menu } from './Menu';
import Library from './Library';
import TreePanel, { actions } from './TreePanel';
import Inspector from './Inspector';

const params = new URLSearchParams(location.search);
const IMPORT_URL = params.get('import');
const TILESET_URL = params.get('tileset');

type Renderer = 'cesium' | '3dtrjs';

async function importTilesetUrl(url: string) {
  const st = useBuilder.getState();
  st.setStatus(`Importing ${url} …`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const t = fromTileset(await r.json(), url);
  st.loadDocument(t);
  const c = counts(t);
  st.setStatus(`Imported ${c.datasets} datasets in ${c.groups - 1} groups from ${url}.`);
}

/** The viewer URL that loads a tileset on start (see TopBar's `?load=` handling). */
function viewerUrl(tilesetUrl: string, renderer: Renderer): string {
  const t = useBuilder.getState().tree;
  // Point size only reaches point clouds when the asset is typed as one; meshes ignore it.
  const type = leaves(t).some((l) => l.format === 'potree' || l.format === 'copc') ? 'pointcloud' : 'mesh';
  // Fly to the first dataset, close enough for it to load: the auto-frame of a whole mosaic is
  // typically too high for any site-sized child to pass its geometric-error gate.
  const first = leaves(t)[0];
  const fly = first ? `&fly=${first.lon.toFixed(5)},${first.lat.toFixed(5)},${Math.round(Math.min(20_000, Math.max(800, first.radius * 8)))}` : '';
  return `/?mode=stream&format=aggregate&renderer=${renderer}&type=${type}${fly}&load=${encodeURIComponent(tilesetUrl)}`;
}

async function makePreview(renderer: Renderer): Promise<string> {
  const ts = toTileset(useBuilder.getState().tree);
  const { url } = await postDraft(ts);
  return viewerUrl(url, renderer);
}

function readFile(file: File) {
  const st = useBuilder.getState();
  file.text().then((text) => {
    const j = JSON.parse(text);
    if (j?.kind === 'aggregate-builder-project') {
      const p = fromProject(j);
      st.loadDocument(p.tree, (p.customRows ?? []) as Row[]);
      st.setStatus(`Opened project “${p.tree.nodes[p.tree.rootId].name}”.`);
    } else if (j?.root) {
      const t = fromTileset(j);
      st.loadDocument(t);
      st.setStatus(`Imported ${counts(t).datasets} datasets from ${file.name} (relative URIs could not be resolved without its URL).`);
    } else throw new Error('neither a builder project nor a tileset.json');
  }).catch((e) => st.setStatus(`Could not open ${file.name}: ${e.message}`));
}

export default function BuilderApp() {
  const t = useBuilder((s) => s.tree);
  const canUndo = useBuilder((s) => s.past.length > 0);
  const canRedo = useBuilder((s) => s.future.length > 0);
  const status = useBuilder((s) => s.status);
  const [renderer, setRenderer] = useState<Renderer>('cesium');
  const [busy, setBusy] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const c = counts(t);
  const root = t.nodes[t.rootId];

  useEffect(() => {
    document.title = `${root.name} — Aggregate Builder`;
  }, [root.name]);

  // `?tileset=` once on load.
  useEffect(() => {
    if (TILESET_URL) importTilesetUrl(TILESET_URL).catch((e) => useBuilder.getState().setStatus(`Import failed: ${e.message}`));
  }, []);

  // Undo/redo everywhere except inside text fields, which keep their own native undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); useBuilder.getState().undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); useBuilder.getState().redo(); }
      else if (k === 's') { e.preventDefault(); exportAs('project'); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // A test/automation handle: the same code paths the buttons use.
  useEffect(() => {
    (window as any).__builder = {
      store: useBuilder, tree, actions,
      toTileset: () => toTileset(useBuilder.getState().tree),
      toManifest: () => toManifest(useBuilder.getState().tree),
      preview: makePreview,
      importTilesetUrl,
    };
  }, []);

  function safely<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) { useBuilder.getState().setStatus(String((e as Error).message || e)); return undefined; }
  }

  function exportAs(what: 'tileset' | 'manifest' | 'project', to: 'file' | 'clipboard' = 'file') {
    const st = useBuilder.getState();
    const name = slug(st.tree.nodes[st.tree.rootId].name);
    const data = safely(() => what === 'tileset' ? toTileset(st.tree) : what === 'manifest' ? toManifest(st.tree) : toProject(st.tree, st.customRows));
    if (!data) return;
    const text = JSON.stringify(data, null, what === 'tileset' ? 0 : 2);
    const file = what === 'tileset' ? `${name}.tileset.json` : what === 'manifest' ? `${name}.set.json` : `${name}.builder.json`;
    const summary = what === 'tileset' ? `${(data as any).asset.extras.builder.exported.datasets} datasets` : what === 'manifest' ? `${(data as any).entries.length} entries` : `${counts(st.tree).datasets} datasets`;
    if (to === 'file') { download(file, text); st.setStatus(`Saved ${file} — ${summary}, ${(text.length / 1024).toFixed(1)} KB.`); }
    else navigator.clipboard.writeText(text).then(
      () => st.setStatus(`Copied ${what} to the clipboard — ${summary}.`),
      (e) => st.setStatus(`Clipboard refused: ${e.message}`),
    );
  }

  async function preview() {
    // Opened before the await: a tab opened after a network round-trip is treated as a popup.
    const w = window.open('', '_blank');
    setBusy(true);
    try {
      const url = await makePreview(renderer);
      if (w) w.location.href = url; else location.assign(url);
      useBuilder.getState().setStatus(`Draft posted — opened in the viewer (${renderer}). Drafts live 24 h in the tile-server's memory.`);
    } catch (e) {
      w?.close();
      useBuilder.getState().setStatus(`Preview failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-screen grid-rows-[auto_1fr_auto] bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <a href="/" className="flex items-center gap-1.5 text-sm font-semibold" title="Back to the viewer">
          <img src="/logo.svg" alt="" className="h-4 w-4" />3D Tiled
        </a>
        <span className="flex items-center gap-1 text-sm text-muted-foreground"><Boxes className="size-4" />Aggregate Builder</span>
        <Input
          value={root.name}
          onChange={(e) => { const st = useBuilder.getState(); st.commit(updateNode(st.tree, st.tree.rootId, { name: e.target.value }), { coalesce: 'project-name' }); }}
          className="h-8 w-64 font-medium"
          title="Project name (the root tile's name)"
          data-testid="project-name"
        />
        <div className="flex gap-0.5">
          <Button size="icon" variant="ghost" className="size-8" disabled={!canUndo} onClick={() => useBuilder.getState().undo()} title="Undo (Ctrl+Z)" data-testid="undo"><Undo2 /></Button>
          <Button size="icon" variant="ghost" className="size-8" disabled={!canRedo} onClick={() => useBuilder.getState().redo()} title="Redo (Ctrl+Shift+Z)" data-testid="redo"><Redo2 /></Button>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="counts">{c.datasets} datasets · {c.groups - 1} groups</span>

        <div className="ml-auto flex items-center gap-2">
          <Menu
            className="h-8 border px-3 text-sm hover:bg-accent"
            trigger={<><Upload className="size-4" />Import</>}
            testId="import-menu"
            items={[
              { label: 'New project', icon: <FilePlus />, onSelect: () => { useBuilder.getState().loadDocument(createTree()); useBuilder.getState().setStatus('New project — Ctrl+Z brings the previous one back.'); } },
              { separator: true },
              { label: 'Open project or tileset file…', icon: <FileJson />, onSelect: () => fileRef.current?.click() },
              { label: 'Import tileset.json from URL…', icon: <Link />, onSelect: () => setUrlDialog(true) },
            ]}
          />
          <Menu
            className="h-8 border px-3 text-sm hover:bg-accent"
            trigger={<><Download className="size-4" />Export</>}
            testId="export-menu"
            items={[
              { heading: 'tileset.json (3D Tiles 1.1)' },
              { label: 'Download', icon: <Download />, onSelect: () => exportAs('tileset'), disabled: !c.datasets, testId: 'export-tileset' },
              { label: 'Copy to clipboard', icon: <ClipboardCopy />, onSelect: () => exportAs('tileset', 'clipboard'), disabled: !c.datasets },
              { heading: 'Aggregate set manifest (server)' },
              { label: 'Download', icon: <Download />, onSelect: () => exportAs('manifest'), disabled: !c.datasets },
              { label: 'Copy to clipboard', icon: <ClipboardCopy />, onSelect: () => exportAs('manifest', 'clipboard'), disabled: !c.datasets },
              { separator: true },
              { label: 'Save project JSON', hint: 'Ctrl+S', icon: <FileJson />, onSelect: () => exportAs('project') },
            ]}
          />
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            <ToggleGroup type="single" size="sm" value={renderer} onValueChange={(v) => v && setRenderer(v as Renderer)}>
              <ToggleGroupItem value="cesium" className="h-7 px-2 text-xs">Cesium</ToggleGroupItem>
              <ToggleGroupItem value="3dtrjs" className="h-7 px-2 text-xs">3DTRjs</ToggleGroupItem>
            </ToggleGroup>
            <Button size="sm" className="h-7" disabled={!c.datasets || busy} onClick={preview} data-testid="preview"
              title="Post the tileset as a draft to the tile-server and open it in the viewer">
              {busy ? <Loader2 className="animate-spin" /> : <Play />}Preview in viewer
            </Button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
      </header>

      <main className="grid min-h-0 grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(280px,340px)]">
        <Library importUrl={IMPORT_URL} />
        <TreePanel />
        <Inspector />
      </main>

      <footer className="flex items-center gap-2 border-t px-3 py-1 text-xs text-muted-foreground" data-testid="status">
        <span className="min-w-0 flex-1 truncate">{status || 'Autosaved in this browser.'}</span>
      </footer>

      <UrlDialog open={urlDialog} onOpenChange={setUrlDialog} />
    </div>
  );
}

function UrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setError('');
    try { await importTilesetUrl(url.trim()); onOpenChange(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a tileset.json</DialogTitle>
          <DialogDescription>
            An /aggregate mosaic, a builder export or a draft. Tiles with content become datasets; groups keep their
            metadata; the server's unnamed quadtree cells are flattened. Replaces the current tree (Ctrl+Z to undo).
          </DialogDescription>
        </DialogHeader>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          placeholder="http://localhost:3001/aggregate/tileset.json?set=angkor" className="font-mono text-xs" autoFocus />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={go} disabled={!url.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Import</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

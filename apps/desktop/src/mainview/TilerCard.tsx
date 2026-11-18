/**
 * Tile raw input — a top-level tab, next to Stream live and Export (which take sources that are tiled already).
 *
 * Its own input field holds RAW input, a file or a folder (or a PostgreSQL address): a point cloud (LAS, LAZ, E57,
 * PTX, a point PLY), a mesh (OBJ, FBX, glTF, an OSGB folder…) or Gaussian splats (PLY, SPZ, SOG, .splat, .ksplat),
 * not a tiled source. The dataset of the Stream live and Export tabs is another field: only "Stream it" writes to it. This
 * card picks a third-party tiler for the input, shows that tool's own options, runs it in a subprocess with its output and
 * Cancel, and opens what it wrote: a COPC, a Potree folder, a streamed SOG, a RAD, a Nexus file or a .3tz archive goes
 * to the Stream live tab; a 3D Tiles tileset folder is finished already and is previewed as is, served by the tile-server.
 *
 * Which tools take the input is the server's answer (`GET /tilers?input=`): it looks at the path, so a folder is
 * matched by what it holds and a PLY by its header (points, a mesh or splats).
 *
 * The tools, their options and where each is on this machine come from the tile-server (`GET /tilers`, which reads
 * packages/tilers). The run goes through the main process's CLI runner (runCli RPC, src/bun/cli-runner.ts), exactly
 * the command shown under "Equivalent CLI": `node packages/tilers/cli.js run <tool> <input> <outDir> …`. A tool that
 * publishes a binary and is not installed is downloaded first, from its authors' release page, and checked against a
 * pinned SHA-256; that only happens after the button says so.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox, ComboboxCollection, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSearch, ComboboxTrigger } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import type { AppModel } from './App';
import { Card, CardTitle } from './components/Card';
import { Actions, Advanced, Check, Chip, Choice, Code, CopyButton, Field, FieldLabel, Info, LogFold, MultiCombo, Result, TextInput, Tip, UrlBar, type Kind, type Message } from './components/bits';
import { PreviewControl } from './StreamTab';
import { base, openExternal, pickDataset, pickerAvailable, pickerRpc } from './host';

interface ToolOption {
  key: string; label: string; type: 'int' | 'number' | 'bool' | 'enum' | 'text';
  values?: string[]; default: string | number | boolean; min?: number; max?: number; advanced?: boolean; help: string; placeholder?: string;
  /** A text option that is a list of names (attributes to keep): the known ones, and what joins them. */
  choices?: string[]; sep?: string;
}
interface Tool {
  id: string; name: string; kind: 'pointcloud' | 'mesh' | 'splat'; summary: string; homepage: string; licence: string;
  inputs: string[]; dir: boolean | 'only'; ply: string | null;
  output: { format: string; label: string };
  delivery: 'bundled' | 'download' | 'uv' | 'cargo' | 'detect'; version: string | null; downloadable: boolean; downloadBytes: number | null;
  options: ToolOption[];
  /** `missing`: what a download would fetch (the tool, the runtime it needs); `downloadBytes`: their size. */
  found: { status: 'ready' | 'missing'; source: string | null; hint: string | null; path: string | null; missing: string[]; downloadable: boolean; downloadBytes: number };
}
interface InputInfo { exists: boolean; dir: boolean; ext: string; exts: string[]; ply: 'points' | 'splats' | 'mesh' | null; db?: boolean }
interface TilerResult { tool: string; kind?: string; format: string; output: string; outDir: string; seconds: number }
const KINDS: Record<Tool['kind'], string> = { pointcloud: 'Point cloud', mesh: 'Mesh', splat: 'Splats' };
const TILER_GROUPS: Record<Tool['kind'], string> = { pointcloud: 'Point cloud tilers', mesh: 'Mesh tilers', splat: 'Splat tilers' };
const PLY: Record<string, string> = { points: 'a point cloud', splats: 'Gaussian splats', mesh: 'a mesh' };
/** The folder's key in /tilers/files/<key>/…: its path, UTF-8, base64url (tilers-live.js `outputKey`). */
const outputKey = (dir: string) => btoa(String.fromCharCode(...new TextEncoder().encode(dir))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const TILER_CLI = 'packages/tilers/cli.js';
const extOf = (src: string) => (/\.copc\.laz$/i.test(src) ? 'copc.laz' : (src.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '');
const nameOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
const quote = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);
/** Where a run writes unless told otherwise: a folder next to the input, named after it and the tool. */
function defaultOutDir(src: string, toolId: string): string {
  if (!src || /^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return '';
  const clean = src.replace(/[\\/]+$/, ''), cut = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (cut < 0) return '';
  const stem = clean.slice(cut + 1).replace(/\.(copc\.laz|compressed\.ply|[a-z0-9]+)$/i, '');
  return `${clean.slice(0, cut + 1)}${stem}-${toolId}`;
}
const SOURCES: Record<string, string> = { bundled: 'ships with this app', downloaded: 'downloaded by this app', built: 'built from source by this app', path: 'found on PATH', qgis: 'found in a QGIS install', pixi: 'found in pixi', env: 'set by an environment variable' };

/** The arguments of a run: only the options that differ from the tool's defaults, so the command stays short. */
export function tilerArgs(tool: Tool, input: string, outDir: string, values: Record<string, string | boolean>, install: boolean): string[] {
  const args = [TILER_CLI, 'run', tool.id, input, outDir];
  for (const o of tool.options) {
    const v = values[o.key];
    if (v === undefined || v === '' || String(v) === String(o.default)) continue;
    args.push(`--${o.key}`, String(v));
  }
  if (install) args.push('--install');
  return args;
}

// What the tools read (packages/tilers/tools.js), grouped for the Windows dialog's type list (`label=ext,ext;…`).
const RAW_FILE_TYPES = [
  'Raw input=las,laz,e57,ply,ptx,pts,pcd,bpf,xyz,csv,txt,obj,fbx,3ds,gltf,glb,stl,dae,ifc,3mf,x3d,gml,kml,shp,geojson,gpkg,spz,sog,splat,ksplat,lcc',
  'Point clouds=las,laz,e57,ply,ptx,pts,pcd,bpf,xyz,csv,txt',
  'Meshes and vectors=obj,fbx,3ds,gltf,glb,ply,stl,dae,ifc,3mf,x3d,gml,kml,shp,geojson,gpkg',
  'Gaussian splats=ply,spz,sog,splat,ksplat,lcc',
].join(';');

export function TilerCard({ app, onStream }: { app: AppModel; onStream: () => void }) {
  const { patchForm } = app;
  const [input, setInput] = useState('');
  const src = input.trim();
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [toolId, setToolId] = useState('');
  const [values, setValues] = useState<Record<string, Record<string, string | boolean>>>({});
  const [outDir, setOutDir] = useState('');
  const [status, setStatus] = useState<Message | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [result, setResult] = useState<TilerResult | null>(null);
  const [info, setInfo] = useState<{ src: string; input: InputInfo; ids: string[] } | null>(null);
  const say = (msg: string, kind: Kind = 'info') => setStatus({ msg, kind });

  const jobId = useRef<string | null>(null);
  const logEl = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const host = pickerAvailable();

  async function loadTools() {
    if (!base) return setUnavailable('The tile-server is not running.');
    try {
      const r = await fetch(`${base}/tilers`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setUnavailable(j.error || `HTTP ${r.status}`);
      setTools(j.tools); setUnavailable('');
    } catch (e) { setUnavailable(`Could not read the tools: ${e}`); }
  }
  useEffect(() => { void loadTools(); }, []);

  // Another input starts afresh: the options typed for the last one (its CRS, where it goes on the globe) are not
  // this one's, and the result shown is not its result. A run in progress keeps its output.
  const lastSrc = useRef(src);
  useEffect(() => {
    if (lastSrc.current === src) return;
    lastSrc.current = src;
    setValues({});
    if (!jobId.current) { setResult(null); setStatus(null); setLog(null); }
  }, [src]);

  // What the path is, asked of the server a moment after the field stops changing: it can look at the disk.
  useEffect(() => {
    if (!base || !src) return setInfo(null);
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const j = await (await fetch(`${base}/tilers?input=${encodeURIComponent(src)}`)).json();
        if (!stale && j.input) setInfo({ src, input: j.input, ids: j.for ?? [] });
      } catch { /* the extension decides, below */ }
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [src]);

  // The tools that take this input: the server's answer once it is in, the extension meanwhile. Offered first: one
  // that is on this machine already, so that nothing is downloaded unless the user picks a tool that needs it.
  const ext = extOf(src);
  const known = info?.src === src ? info : null;
  const fitting = useMemo(() => (tools ?? []).filter((t) => (known ? known.ids.includes(t.id) : t.dir !== 'only' && t.inputs.includes(ext))), [tools, ext, known]);
  // With an input: the tools that take it, one chosen for you. Without: every tool, to look at, none chosen.
  const offered = src ? fitting : (tools ?? []);
  const tool = offered.find((t) => t.id === toolId) ?? (src ? fitting.find((t) => t.found.status === 'ready') ?? fitting[0] : null) ?? null;
  const groups = useMemo(() => (Object.keys(TILER_GROUPS) as Tool['kind'][])
    .map((k) => ({ value: TILER_GROUPS[k], items: offered.filter((t) => t.kind === k) })).filter((g) => g.items.length), [offered]);
  useEffect(() => { if (tool && tool.id !== toolId) setToolId(tool.id); }, [tool, toolId]);
  const vals = (tool && values[tool.id]) || {};
  const setVal = (key: string, v: string | boolean) => tool && setValues((all) => ({ ...all, [tool.id]: { ...(all[tool.id] ?? {}), [key]: v } }));

  useLayoutEffect(() => { const el = logEl.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [log]);

  const missing = tool?.found.status === 'missing';
  const willDownload = !!tool && missing && tool.found.downloadable;
  const blocked = !!tool && missing && !tool.found.downloadable;
  const isTileset = result?.format === '3dtiles';
  const tilesetUrl = result && isTileset && base ? `${base}/tilers/files/${outputKey(result.outDir)}/tileset.json` : '';
  const what = known?.input.db ? (known.input.exists ? 'a PostgreSQL database' : 'a PostgreSQL address that is not complete (postgresql://user@host:5432/database)')
    : known?.input.dir ? `a folder holding ${known.input.exts.slice(0, 6).map((e) => `.${e}`).join(', ') || 'no file'}` : `a .${ext || '?'} file${known?.input.ply ? ` holding ${PLY[known.input.ply]}` : ''}`;
  // the folder typed, or one next to the input
  const out = outDir.trim() || (tool ? defaultOutDir(src, tool.id) : '');
  const args = tool && src && out ? tilerArgs(tool, src, out, vals, willDownload) : null;
  const cliText = args ? `node ${args.map(quote).join(' ')}` : '';

  async function browseIn(directory: boolean) {
    const picked = await pickDataset({ directory, allowedFileTypes: directory ? '*' : RAW_FILE_TYPES }).catch((e) => { say(`File picker failed: ${e}`, 'err'); return []; });
    if (picked?.[0]) setInput(picked[0]);
  }

  async function browseOut() {
    if (!host) return say('The native picker needs the desktop app: type a folder path instead.', 'err');
    const picked = await pickDataset({ directory: true, allowedFileTypes: '*' }).catch(() => []);
    if (picked?.[0]) setOutDir(picked[0]);
  }

  async function start() {
    if (!src) return say('Enter the raw file above first.', 'err');
    if (!tool) return say(`No tool takes ${what}. Tiled sources (COPC, Potree, SOG…) go to the Stream live or Export tab.`, 'err');
    if (blocked) return say(`${tool.name} is not on this machine: ${tool.found.hint}`, 'err');
    if (!out) return say('Pick an empty output folder.', 'err');
    if (!host || !pickerRpc) return say('Running a tiler needs the desktop app. The command below does the same from a terminal.', 'err');
    try {
      const { id } = await pickerRpc.request.runCli({ args: args! });
      jobId.current = id;
    } catch (e) { return say(`Could not start: ${e instanceof Error ? e.message : e}`, 'err'); }
    follow.current = true;
    setResult(null); setLog([]); setLogOpen(true); setRunning(true);
    say(willDownload ? `Downloading ${tool.found.missing.join(' and ') || tool.name}…` : `Starting ${tool.name}…`);
    void poll();
  }

  /**
   * Tiny synthetic inputs to try the tools on (packages/tilers/samples.js): a LAS, a splat PLY and a textured OBJ,
   * written into a `3dtiled-samples` folder of the picked one. The LAS becomes the input.
   */
  async function makeSamples() {
    if (!host || !pickerRpc) return say('Writing the samples needs the desktop app: node packages/tilers/cli.js samples <folder> does the same.', 'err');
    const picked = await pickDataset({ directory: true, allowedFileTypes: '*' }).catch(() => []);
    if (!picked?.[0]) return;
    const dir = `${picked[0].replace(/[\\/]+$/, '')}${picked[0].includes('\\') ? '\\' : '/'}3dtiled-samples`;
    try {
      const { id } = await pickerRpc.request.runCli({ args: [TILER_CLI, 'samples', dir] });
      for (;;) {
        const st = await pickerRpc.request.cliStatus({ id });
        if (!st) return say('The job is gone.', 'err');
        if (st.state === 'running') { await new Promise((r) => setTimeout(r, 200)); continue; }
        const line = st.tail.find((l) => l.startsWith('TILER_SAMPLES '));
        if (st.state !== 'done' || !line) return say(`Could not write the samples: ${st.tail[st.tail.length - 1] ?? ''}`, 'err');
        const { files } = JSON.parse(line.slice('TILER_SAMPLES '.length)) as { files: string[] };
        lastSrc.current = files[0]!;                    // this change of input is ours: keep the message below
        setInput(files[0]!);
        return say(`Samples written to ${dir}: points.las (set as the input; its CRS is EPSG:32631), splats.ply, and the same terrain as mesh/mesh.obj, mesh.glb and mesh.ply.`, 'ok');
      }
    } catch (e) { say(`Could not write the samples: ${e instanceof Error ? e.message : e}`, 'err'); }
  }

  async function cancel() {
    if (jobId.current) await pickerRpc?.request.cancelCli({ id: jobId.current }).catch(() => false);
  }

  async function poll() {
    const id = jobId.current;
    if (!id || !pickerRpc) return;
    let st: Awaited<ReturnType<typeof pickerRpc.request.cliStatus>>;
    try { st = await pickerRpc.request.cliStatus({ id }); }
    catch { setTimeout(poll, 1000); return; }
    if (!st) { jobId.current = null; setRunning(false); return say('The job is gone (was the app restarted?).', 'err'); }
    const el = logEl.current;
    follow.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    // without the colour codes some tools write even when their output is not a terminal
    const shown = st.tail.filter((l) => !l.startsWith('TILER_RESULT ')).map((l) => l.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''));
    setLog(shown);
    const out = shown.filter((l) => !l.startsWith('[desktop]') && !l.startsWith('$ '));
    const last = out[out.length - 1]?.trim() ?? '';
    const secs = (((st.endedAt ?? Date.now()) - st.startedAt) / 1000).toFixed(st.endedAt ? 1 : 0);
    if (st.state === 'running') { say(`${secs} s: ${last.slice(0, 160) || 'running…'}`); setTimeout(poll, 500); return; }
    jobId.current = null;
    setRunning(false);
    void loadTools();                                   // a downloaded tool is installed now
    if (st.state === 'done') {
      const line = st.tail.find((l) => l.startsWith('TILER_RESULT '));
      let r: TilerResult | null = null;
      try { r = line ? JSON.parse(line.slice('TILER_RESULT '.length)) : null; } catch { /* reported below */ }
      if (!r) return say(`Finished in ${secs} s, but the result line is missing: see the output.`, 'err');
      setResult(r);
      say(`Done in ${secs} s: ${r.output}`, 'ok');
    } else if (st.state === 'cancelled') {
      say(`Cancelled after ${secs} s. The folder may hold partial files.`, 'err');
    } else {
      say(`${tool?.name ?? 'The tool'} failed (exit code ${st.exitCode ?? '?'})${last ? `: ${last.slice(0, 200)}` : ''}. See the output below.`, 'err');
      setLogOpen(true);
    }
  }

  /** What the tiler wrote becomes the dataset, and the Stream live tab opens. */
  function streamIt() {
    if (!result) return;
    // A file on disk streams as a URL does: the server reads it by ranges, and nothing is converted ahead (cache=none).
    // A .3tz archive has no live adapter: it goes through the converter-backed route, unpacked once to the local cache.
    // the formats the dataset form lists by name; the others (a .3tz archive, a Nexus file) are found by their extension
    const live = ['copc', 'potree', 'sog', 'rad', 'nexus'].includes(result.format);
    patchForm({ src: result.output, format: ['copc', 'potree', 'sog', 'rad'].includes(result.format) ? result.format : '', cache: live ? 'none' : 'full' });
    onStream();
    app.say(live ? `Now streaming ${result.output}: tiles are built from the file as they are asked for.` : `Now streaming ${result.output}. The first load converts it to the local cache.`, 'ok');
  }
  /** A 3D Tiles tileset is finished: nothing to convert, it is served from its folder and shown. */
  function preview(renderer: 'cesium' | '3dtrjs') {
    if (!result || !tilesetUrl) return;
    app.previewIn(renderer, tilesetUrl, result.kind ?? tool?.kind ?? 'mesh', nameOf(result.outDir));
  }
  async function openFolder() {
    if (!result) return;
    if (host) await pickerRpc!.request.openFolder({ path: result.outDir }).catch(() => {});
    else say(result.outDir, 'info');
  }

  // A field shows the value a run will use, the tool's default included: an empty box reads as "nothing set".
  const field = (o: ToolOption) => {
    const v = vals[o.key];
    if (o.type === 'bool') return <Check key={o.key} id={`tiler-${o.key}`} checked={v === undefined ? Boolean(o.default) : Boolean(v)} onChange={(c) => setVal(o.key, c)} title={o.help}>{o.label}</Check>;
    if (o.type === 'enum') return (
      <Field key={o.key} label={o.label} info={o.help}>
        <Choice id={`tiler-${o.key}`} value={String(v ?? o.default)} onChange={(c) => setVal(o.key, c)} options={(o.values ?? []).map((x) => ({ value: x, label: x }))} />
      </Field>
    );
    // a list of names: chips to pick, and a pasted or typed list is taken as it is
    if (o.type === 'text' && o.choices) return (
      <Field key={o.key} label={o.label} info={o.help}>
        <MultiCombo id={`tiler-${o.key}`} value={String(v ?? '')} onChange={(c) => setVal(o.key, c)} choices={o.choices} sep={o.sep} placeholder={o.placeholder} />
      </Field>
    );
    return (
      <Field key={o.key} label={o.label} info={o.help}>
        <TextInput id={`tiler-${o.key}`} value={String(v ?? (o.type === 'text' ? '' : o.default))} onChange={(e) => setVal(o.key, e.target.value)} placeholder={o.placeholder ?? String(o.default)} />
      </Field>
    );
  };
  const basic = tool?.options.filter((o) => !o.advanced) ?? [], advanced = tool?.options.filter((o) => o.advanced) ?? [];
  const grid = (list: ToolOption[]) => (
    <>
      <div className="mt-3 grid grid-cols-2 items-start gap-3 max-sm:grid-cols-1">{list.filter((o) => o.type !== 'bool').map(field)}</div>
      {list.some((o) => o.type === 'bool') && <div className="mt-1 flex flex-wrap items-center gap-x-4">{list.filter((o) => o.type === 'bool').map(field)}</div>}
    </>
  );
  const state = (t: Tool) => (t.found.status === 'ready' ? 'Ready' : t.found.downloadable ? `Download, ${(t.found.downloadBytes / 1e6).toFixed(0)} MB` : 'Not installed');
  const stateClass = (t: Tool) => (t.found.status === 'ready' ? 'text-muted-foreground' : t.found.downloadable ? 'text-foreground' : 'text-warning');
  const accepted = (k: Tool['kind']) => [...new Set((tools ?? []).filter((t) => t.kind === k).flatMap((t) => t.inputs))].filter((e) => e !== 'postgres').map((e) => `.${e}`).join(' ');

  return (
    <Card id="tiler-card">
      <div className="mb-3 flex items-center gap-1.5">
        <CardTitle>Tile raw input</CardTitle>
        <Info label="About tiling">
          <p className="m-0">For a point cloud, a mesh or Gaussian splats that are <strong>not tiled yet</strong>. A third-party tiler runs on this machine, then the result opens here. A source that is tiled already goes to <em>Stream live</em> or <em>Export</em>.</p>
          <p className="m-0">This app writes no tiler: it finds, fetches and runs the official ones. A tool that is not installed is downloaded from its authors' release page and checked against a pinned SHA-256, only after the button says so.</p>
        </Info>
      </div>
      <UrlBar>
        <TextInput id="tiler-src" aria-label="Raw input: a file, a folder, or a PostgreSQL address" value={input} onChange={(e) => setInput(e.target.value)} disabled={running} placeholder="Raw file or folder: C:\data\scan.laz, C:\data\model.obj, postgresql://user@host/db" className="flex-1" />
        {host && <>
          <Tip text="Pick a raw file: a point cloud, a mesh, vectors or splats"><Button id="tiler-browse-file" disabled={running} onClick={() => browseIn(false)}>File…</Button></Tip>
          <Tip text="Pick a folder of raw files: LAS or LAZ files, an OSGB tree, meshes"><Button id="tiler-browse-dir" disabled={running} onClick={() => browseIn(true)}>Folder…</Button></Tip>
        </>}
      </UrlBar>
      {unavailable && <Result id="tiler-unavailable" message={{ msg: unavailable, kind: 'err' }} />}

      {/* The tool: one searchable list, grouped by what the tool tiles. With an input it holds the tools that take it. */}
      {tools && (
        <>
          <div className="mt-3 flex items-center gap-2">
            <FieldLabel>Tool</FieldLabel>
            {src && tool && <Chip id="tiler-input" data-dir={known?.input.dir ? 'true' : 'false'} data-ply={known?.input.ply ?? ''}>Input: {what}</Chip>}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <Combobox items={groups} value={tool} onValueChange={(t) => { if (t) setToolId((t as Tool).id); }}
              itemToStringLabel={(t: Tool) => `${t.name} ${t.output.label} ${KINDS[t.kind]}`} isItemEqualToValue={(x: Tool, y: Tool) => x?.id === y?.id} disabled={running || !offered.length}>
              <ComboboxTrigger id="tiler-tool" data-value={tool?.id ?? ''} aria-label="Tool" className="min-w-0 flex-1">
                {tool
                  ? <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate font-medium">{tool.name}</span>
                      <span className="truncate text-xs text-muted-foreground">→ {tool.output.label}</span>
                      <span className={cn('ml-auto flex-none text-xs', stateClass(tool))}>{state(tool)}</span>
                    </span>
                  : <span className="text-muted-foreground">{offered.length ? `Choose one of ${offered.length} tools` : 'No tool takes this input'}</span>}
              </ComboboxTrigger>
              <ComboboxContent>
                <ComboboxSearch id="tiler-tool-search" placeholder="Search: a tool, an output format…" />
                <ComboboxEmpty>No tool matches.</ComboboxEmpty>
                <ComboboxList className="max-h-[min(27rem,calc(var(--available-height)-2.5rem))]">
                  {(group: { value: string; items: Tool[] }) => (
                    <ComboboxGroup key={group.value} items={group.items}>
                      <ComboboxLabel>{group.value}</ComboboxLabel>
                      <ComboboxCollection>
                        {(t: Tool) => (
                          <ComboboxItem key={t.id} value={t} data-tool={t.id}>
                            <span className="truncate font-medium">{t.name}</span>
                            <span className="truncate text-xs text-muted-foreground">→ {t.output.label}</span>
                            <span className={cn('ml-auto flex-none text-xs', stateClass(t))}>{state(t)}</span>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            {tool && (
                <Info label={`About ${tool.name}`}>
                <p className="m-0">{tool.summary}</p>
                <p className="m-0">Takes {tool.inputs.filter((e) => e !== 'postgres').map((e) => `.${e}`).join(' ') || 'a PostgreSQL address'}{tool.dir ? (tool.dir === 'only' ? ' in a folder' : ', or a folder of them') : ''}.</p>
                <p className="m-0"><a href={tool.homepage} onClick={(e) => { e.preventDefault(); openExternal(tool.homepage); }} className="underline">Project page</a>, {tool.licence} licence{tool.version ? `, version ${tool.version}` : ''}.</p>
                <p className="m-0">
                  {tool.found.status === 'ready'
                    ? <>On this machine: {SOURCES[tool.found.source ?? ''] ?? tool.found.source}{tool.found.hint ? ` (${tool.found.hint})` : ''}.</>
                    : tool.found.downloadable
                      ? <><strong>Not installed.</strong> Running it first downloads {tool.found.missing.join(' and ')} ({(tool.found.downloadBytes / 1e6).toFixed(0)} MB){tool.delivery === 'uv'
                          ? <>: uv installs that pinned version from PyPI into a private environment in this app's tools folder, nothing system-wide.</>
                          : tool.delivery === 'cargo'
                          ? <>: its authors publish source only, so the archive is checked against a pinned SHA-256 and compiled once (a few minutes), with this machine's Rust toolchain or one this app fetches for the build and removes afterwards.</>
                          : <> from the authors' release page, checked against a pinned SHA-256 and kept in this app's tools folder.</>}</>
                      : <><strong>Not on this machine:</strong> {tool.found.hint}.</>}
                </p>
              </Info>
            )}
          </div>
        </>
      )}

      {/* Nothing to run yet: what this tab takes. */}
      {tools && !tool && (
        <div id="tiler-none" className="mt-3">
          <Result id="tiler-status-none" message={status} className="mt-0 mb-3" />
          {src && <p className="m-0 mb-3 text-sm">No tool here takes <strong className="font-medium">{what}</strong>.</p>}
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {(Object.keys(KINDS) as Tool['kind'][]).map((k) => <div key={k} id={`tiler-inputs-${k}`} className="contents"><dt className="font-medium text-foreground">{KINDS[k]}</dt><dd className="m-0">{accepted(k)}</dd></div>)}
            {tools.some((t) => t.inputs.includes('postgres')) && <div id="tiler-inputs-db" className="contents"><dt className="font-medium text-foreground">PostGIS table</dt><dd className="m-0">postgresql://user@host:5432/database</dd></div>}
          </dl>
          {!src && host && <Tip text="A LAS, a splat PLY and a textured OBJ, 1.3 MB, written into a folder you pick"><Button id="tiler-samples" size="sm" className="mt-3" onClick={makeSamples}>Write sample files to try</Button></Tip>}
        </div>
      )}

      {tool && (
        <>
          <span id="tiler-found" data-status={tool.found.status} hidden>{state(tool)}</span>

          {basic.length > 0 && grid(basic)}

          <Field label="Output folder" className="mt-3">
            <UrlBar>
              <TextInput id="tiler-out" value={outDir} onChange={(e) => setOutDir(e.target.value)} placeholder={defaultOutDir(src, tool.id) || 'An empty folder: C:\\tiled\\my-scan'} className="flex-1" />
              {host && <Button id="tiler-browse" onClick={browseOut}>Folder…</Button>}
              {running
                ? <Button id="tiler-cancel" variant="outline" onClick={cancel} className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive">Cancel</Button>
                : <Button id="tiler-start" variant="default" disabled={blocked} onClick={start}>{willDownload ? 'Download and run' : 'Run'}</Button>}
            </UrlBar>
          </Field>

          <Result id="tiler-status" message={status} />
          <LogFold wrapId="tiler-log-wrap" id="tiler-log" label="Output of the tool, last 200 lines" lines={log} open={logOpen} onOpenChange={setLogOpen} logRef={logEl} />
          <Actions id="tiler-done" hidden={!result}>
            {isTileset ? <>
              <PreviewControl id="tiler-preview" primary onPreview={preview} />
              <CopyButton id="tiler-copy-url" text={tilesetUrl} label="Copy URL" variant="outline" onCopied={() => app.say('Tileset URL copied: it works while this app runs.', 'ok')} />
            </> : <Button id="tiler-stream" variant="default" onClick={streamIt}>Stream it</Button>}
            <Button id="tiler-open" onClick={openFolder}>Open folder</Button>
          </Actions>

          <Advanced>
            {advanced.length > 0 && grid(advanced)}
            <FieldLabel className="mt-3 mb-1.5">Same thing from a terminal, at the repo root</FieldLabel>
            <UrlBar>
              <Code id="tiler-cli" empty={!cliText}>{cliText || 'Enter an input first'}</Code>
              <CopyButton id="tiler-cli-copy" text={cliText} title="Copy the command" />
            </UrlBar>
            {!host && <p className="m-0 mt-3 text-xs text-muted-foreground">Running a tiler needs the desktop app; in a plain browser this card only shows the tools and the command.</p>}
          </Advanced>
        </>
      )}
    </Card>
  );
}

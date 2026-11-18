/**
 * Export to a folder.
 *
 * Two ways to fill a folder:
 *   crawl   — download the tileset URL above as served: any source (raw via /stream or /convert,
 *             remote 3D Tiles, mosaics), implicit tilings expanded or kept.
 *   convert — the per-format offline converter (packages/convert) on the raw source: faster for the
 *             formats it covers, with their own options.
 * And two places to run it ("Run in"):
 *   server  — POST /export on the tile-server (packages/tile-server/export-live.js), the default: it is
 *             already running with every adapter loaded, reports structured progress, the job survives
 *             switching tabs, and it serves the result back for the preview buttons.
 *   cli     — the main process spawns exactly the command shown under "Equivalent CLI" (runCli RPC,
 *             src/bun/cli-runner.ts): an isolated process whose crash or OOM can't take the server
 *             down; progress is parsed from its output. A convert does not need the server at all (a crawl
 *             still reads the tileset URL, which the server serves).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { AppModel } from './App';
import { Card, CardTitle } from './components/Card';
import { Actions, Advanced, Check, Choice, Code, CopyButton, Field, FieldLabel, Info, LogFold, Result, Segmented, StepProgress, TextInput, UrlBar, type Kind, type Message } from './components/bits';
import { base, pickDataset, pickerAvailable, pickerRpc } from './host';
import { noteExported, type DatasetOptions, type HistoryEntry } from './library';
import { DEFAULT_EXPORT, DOC_LINKS, exportCli, exportCliArgs, exportRequest, mb, nameFor, stepsFromCliOutput, typeOfFormat, viewerLink, type ExportRequest, type ExportSettings, type Steps } from './urls';

const METHODS = [
  { value: 'crawl', label: 'Copy the stream', title: 'Downloads the tileset URL as this app serves it: works for every source' },
  { value: 'convert', label: 'Offline converter', title: 'Runs the per-format converter on the source itself: faster for the formats it covers, with their own options' },
];
const RUNNERS = (noCli: boolean) => [
  { value: 'server', label: 'In the tile-server' },
  { value: 'cli', label: 'As a separate process', disabled: noCli, title: noCli ? 'Needs the desktop app' : undefined },
];
const VERIFY = [
  { value: 'sample', label: 'Counts, and a sample of tiles' },
  { value: 'counts', label: 'Counts only' },
  { value: 'full', label: 'Every tile read in full' },
  { value: 'off', label: 'Off' },
];
const HIERARCHY_ERRORS = [
  { value: 'error', label: 'Stop the export' },
  { value: 'warn', label: 'Warn, and export the rest' },
];
const TILINGS = [{ value: '', label: 'default' }, { value: 'implicit', label: 'implicit' }, { value: 'explicit', label: 'explicit' }];

interface Job {
  running: boolean;
  cancellable: boolean;
  /** The bar; null while hidden. */
  steps: Steps | null;
  /** Open folder / preview / copy path, after a run that finished. */
  done: boolean;
  /** The server's job URL for the exported files, '' for a CLI export (a plain folder on disk). */
  preview: string;
  /** The CLI's output tail; null while hidden. */
  log: string[] | null;
  logOpen: boolean;
}
const IDLE: Job = { running: false, cancellable: false, steps: null, done: false, preview: '', log: null, logOpen: false };

export function ExportCard({ app }: { app: AppModel }) {
  const { form, url } = app;
  const [s, setS] = useState<ExportSettings>(DEFAULT_EXPORT);
  const [status, setStatus] = useState<Message | null>(null);
  const [job, setJob] = useState<Job>(IDLE);
  const [disabled, setDisabled] = useState(false);
  const patch = (p: Partial<ExportSettings>) => setS((x) => ({ ...x, ...p }));
  const exportSay = (msg: string, kind: Kind = 'info') => setStatus({ msg, kind });

  // The polls read these rather than the render they were started in.
  const appRef = useRef(app); appRef.current = app;
  const jobRef = useRef(job); jobRef.current = job;
  const exportJob = useRef<string | null>(null);
  const cliJob = useRef<string | null>(null);
  const exportStarted = useRef<{ form: DatasetOptions; outDir: string; method: string } | null>(null);
  const logEl = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  const cli = !pickerAvailable();
  const convert = s.method === 'convert';
  // The CLI runner lives in the main process; a plain browser (verification bundle) has no host.
  const runner = cli && s.runner === 'cli' ? 'server' : s.runner;
  // A crawl in a CLI subprocess reads tiles the server builds, so the subprocess has no say on their threads.
  const workersNa = runner === 'cli' && s.method === 'crawl';
  const req = exportRequest(app.dataset(), { ...s, runner, workers: workersNa ? '' : app.workers });
  const live = viewerLink(url, typeOfFormat(form.format));

  // A server started without TILED_ALLOW_EXPORT (e.g. an adopted `pnpm dev` one) can't export; say so
  // up front rather than on the first click.
  useEffect(() => {
    if (!base) return;
    fetch(`${base}/export`).then(async (r) => {
      if (r.status === 403) {
        const j = await r.json().catch(() => ({}));
        exportSay(j.error || 'Export is disabled on this tile-server.', 'err');
        setDisabled(true);
      }
    }).catch(() => {});
  }, []);

  // Show the tail; keep following it only if the user hasn't scrolled up.
  useLayoutEffect(() => {
    const el = logEl.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [job.log]);

  /** An export that ended goes in the history, however it ended. */
  function recordExport(state: NonNullable<HistoryEntry['state']>, files?: number, bytes?: number) {
    if (!exportStarted.current) return;
    const { form, outDir, method } = exportStarted.current;
    exportStarted.current = null;
    appRef.current.updateLib((l) => noteExported(l, nameFor(form.src), form, { outDir, method, state, files, bytes }));
  }

  const setRunning = (running: boolean, cancellable: boolean) => setJob((j) => ({ ...j, running, cancellable: running && cancellable }));

  async function start() {
    const r = req;
    if (r.method === 'crawl' && !r.url) return exportSay('Enter a dataset path or URL first.', 'err');
    if (r.method === 'convert' && !r.src) return exportSay('Enter a dataset path or URL first.', 'err');
    if (!r.outDir) return exportSay('Pick an empty output folder.', 'err');
    if (r.maxDepth != null && !(r.maxDepth >= 0)) return exportSay('Max depth must be a number of levels.', 'err');
    exportStarted.current = { form: app.dataset(), outDir: r.outDir, method: r.method };
    if (runner === 'cli') return startCli(r);
    setJob((j) => ({ ...j, done: false, log: null }));
    try {
      const resp = await fetch(`${base}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) return exportSay(j.error || `HTTP ${resp.status}`, 'err');
      exportJob.current = j.id;
      // the offline converters run in-process and can't be interrupted part-way
      setJob((x) => ({ ...x, steps: { step: 1, steps: 1 }, running: true, cancellable: r.method !== 'convert' }));
      exportSay(r.method === 'convert' ? 'Converting…' : 'Reading the tileset tree…');
      pollExport();
    } catch (e) { exportSay(`Export request failed: ${e}`, 'err'); }
  }

  async function cancel() {
    if (cliJob.current) { await pickerRpc?.request.cancelCli({ id: cliJob.current }).catch(() => false); return; }
    if (exportJob.current) await fetch(`${base}/export/${exportJob.current}`, { method: 'DELETE' }).catch(() => {});
  }

  // ── Run in: CLI subprocess ──────────────────────────────────────────────────────────────────────
  async function startCli(r: ExportRequest) {
    if (!pickerAvailable()) return exportSay('CLI subprocess needs the desktop app — use Run in: tile-server here.', 'err');
    const { args, then } = exportCliArgs(r);
    try {
      const { id } = await pickerRpc!.request.runCli(then ? { args, then } : { args });
      cliJob.current = id;
    } catch (e) { return exportSay(`Could not start the CLI: ${e instanceof Error ? e.message : e}`, 'err'); }
    // The preview buttons need the server's job URL; a CLI export is a plain folder on disk.
    follow.current = true;
    // a subprocess can always be killed, convert included
    setJob({ running: true, cancellable: true, steps: { step: 1, steps: 1 }, done: false, preview: '', log: [], logOpen: false });
    exportSay('Starting node…');
    pollCli();
  }

  async function pollCli() {
    const id = cliJob.current;
    if (!id || !pickerRpc) return;
    let st: Awaited<ReturnType<typeof pickerRpc.request.cliStatus>>;
    try { st = await pickerRpc.request.cliStatus({ id }); }
    catch { setTimeout(pollCli, 1000); return; }
    if (!st) { cliJob.current = null; setRunning(false, false); return exportSay('The CLI job is gone (was the app restarted?).', 'err'); }
    const el = logEl.current;
    follow.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const out = st.tail.filter((l) => !l.startsWith('[desktop]') && !l.startsWith('$ '));
    const last = out[out.length - 1]?.trim() ?? '';
    const stepLine = stepsFromCliOutput(out);
    setJob((j) => ({ ...j, log: st.tail, steps: stepLine ?? j.steps }));
    const secs = (((st.endedAt ?? Date.now()) - st.startedAt) / 1000).toFixed(st.endedAt ? 1 : 0);
    if (st.state === 'running') {
      exportSay(`${secs} s — ${last || 'running…'}`);
      setTimeout(pollCli, 500);
      return;
    }
    cliJob.current = null;
    setRunning(false, false);
    recordExport(st.state);
    if (st.state === 'done') {
      setJob((j) => ({ ...j, steps: { step: null, steps: j.steps?.steps || 1 }, done: true }));
      exportSay(`Done in ${secs} s — ${last}`, 'ok');
    } else if (st.state === 'cancelled') {
      exportSay(`Cancelled after ${secs} s — the folder holds a partial copy.`, 'err');
    } else {
      exportSay(`CLI failed (exit code ${st.exitCode ?? '?'})${last ? ` — ${last}` : ''}. See the output below.`, 'err');
      setJob((j) => ({ ...j, logOpen: true }));
    }
  }

  async function pollExport() {
    const id = exportJob.current;
    if (!id) return;
    let j: any;
    try { j = await (await fetch(`${base}/export/${id}`)).json(); }
    catch { setTimeout(pollExport, 1000); return; }
    const pr = j.progress ?? {};
    const discovered = pr.tilesDiscovered ?? 0, written = pr.tilesWritten ?? 0;
    // The total is unknown while external tilesets are still being crawled, hence an indeterminate block.
    if (pr.steps && j.state === 'running') setJob((x) => ({ ...x, steps: { step: pr.step, steps: pr.steps, done: pr.stepDone, total: pr.stepTotal } }));
    else if (j.state === 'done') setJob((x) => ({ ...x, steps: { step: null, steps: x.steps?.steps || 1 } }));
    const convert = (exportStarted.current?.method ?? j.result?.method) === 'convert';
    const line = convert
      ? (j.state === 'running' ? `${pr.stepTotal != null ? `${pr.stepDone}/${pr.stepTotal} · ` : ''}${((pr.elapsedMs ?? 0) / 1000).toFixed(0)} s` : `${written} files · ${mb(pr.bytes ?? 0)}`)
      : `${pr.tilesets ?? 0} tilesets · ${written}/${discovered} files · ${mb(pr.bytes ?? 0)}`
        + (pr.implicitExpanded ? ` · ${pr.implicitExpanded} implicit expanded` : '')
        + (pr.implicitKept ? ` · ${pr.implicitKept} implicit kept` : '')
        + (pr.failed ? ` · ${pr.failed} failed` : '');
    if (j.state === 'running') {
      const phase = pr.stepLabel ? `Step ${pr.step} of ${pr.steps}: ${pr.stepLabel}` : 'Working';
      exportSay(`${phase} — ${line}`);
      setTimeout(pollExport, 500);
      return;
    }
    exportJob.current = null;
    setRunning(false, false);
    recordExport(j.state === 'done' ? 'done' : j.state === 'cancelled' ? 'cancelled' : 'failed', written, pr.bytes);
    if (j.state === 'done') {
      setJob((x) => ({ ...x, done: true, preview: j.preview ? `${base}${j.preview}` : '' }));
      const packs = j.result?.packages?.length ? ` Packed: ${j.result.packages.join(', ')}.` : '';
      const v = j.result?.verify;
      const incomplete = !!pr.failed || (v && !v.ok);
      exportSay(`Done in ${((j.result?.elapsedMs ?? pr.elapsedMs ?? 0) / 1000).toFixed(1)} s — ${line}.${packs}${v?.summary ? ` ${v.summary}` : ''}`
        + (incomplete ? ' The details are in export-report.json; re-run into a new folder to retry.' : ''), incomplete ? 'err' : 'ok');
    } else {
      exportSay(j.state === 'cancelled' ? `Cancelled — ${line}. The folder holds a partial copy.` : `Export failed: ${j.error}`, 'err');
    }
  }

  async function browseOut() {
    if (!pickerAvailable()) return exportSay('The native picker needs the desktop app — type a folder path instead.', 'err');
    const picked = await pickDataset({ directory: true, allowedFileTypes: '*' }).catch(() => []);
    if (picked?.[0]) patch({ outDir: picked[0] });
  }
  async function openFolder() {
    const dir = s.outDir.trim();
    if (pickerAvailable()) await pickerRpc!.request.openFolder({ path: dir }).catch(() => {});
    else exportSay(dir, 'info');
  }
  async function copyPath() {
    try { await navigator.clipboard.writeText(s.outDir.trim()); app.say('Folder path copied.', 'ok'); } catch { /* shown already */ }
  }
  /** The exported tileset as Cesium for Unreal's "URL" source wants it: file:///C:/exports/site/tileset.json, spaces escaped. */
  const unrealUrl = () => {
    const dir = s.outDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return encodeURI(`file://${dir.startsWith('/') ? '' : '/'}${dir}/tileset.json`);
  };
  async function copyUnreal() {
    try { await navigator.clipboard.writeText(unrealUrl()); app.say('Copied. Paste it as the tileset URL in Cesium for Unreal (source: URL).', 'ok'); }
    catch { exportSay(unrealUrl(), 'info'); }
  }
  // The exported files, served back by the tile-server exactly as a static host would serve them.
  const previewExported = () => { if (job.preview) app.previewIn('cesium', job.preview, typeOfFormat(form.format), 'Exported copy'); };

  return (
    <Card id="export-card">
      <div className="mb-3 flex items-center gap-1.5">
        <CardTitle>Export to a folder</CardTitle>
        <Info label="About exports">
          <p className="m-0">Writes a finished, static 3D Tiles folder that any web server, S3 bucket or Cesium for Unreal can host <strong>without this app</strong>.</p>
          <p className="m-0 flex flex-wrap gap-x-3 [&_a]:underline">
            <a id="export-doc" href={DOC_LINKS.exportDoc} target="_blank" rel="noreferrer">Export docs</a>
            <a id="export-cli-doc" href={DOC_LINKS.cliDoc} target="_blank" rel="noreferrer">CLI docs</a>
            <a id="export-mw" href={DOC_LINKS.middleware} target="_blank" rel="noreferrer">Middleware home</a>
            <a id="export-live" href={live || '#'} hidden={!live} target="_blank" rel="noreferrer">Live tileset in the demo viewer</a>
          </p>
        </Info>
      </div>
      <UrlBar>
        <TextInput id="export-dir" aria-label="Output folder" value={s.outDir} onChange={(e) => patch({ outDir: e.target.value })} placeholder="Output folder, empty: C:\exports\my-site" className="flex-1" />
        <Button id="export-browse" onClick={browseOut}>Folder…</Button>
        {/* One slot: the Export call to action becomes Cancel while a run is on. */}
        {job.running
          ? <Button id="export-cancel" variant="outline" disabled={!job.cancellable} onClick={cancel} title={job.cancellable ? 'Stop this export; the folder keeps a partial copy' : 'The offline converter runs in-process and cannot be interrupted'}
              className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive/30">Cancel</Button>
          : <Button id="export-start" variant="default" disabled={disabled} onClick={start}>Export</Button>}
      </UrlBar>

      {/* The method, then only the options that method has. */}
      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2">
        <Field label="Method" className="flex-none">
          <Segmented id="export-method" value={s.method} onChange={(v) => patch({ method: v as ExportSettings['method'] })} options={METHODS} disabled={job.running} />
        </Field>
        {!convert && <>
          <Field compact label="Max depth" title="How many levels of the tree to copy. Empty: all of them">
            <TextInput id="export-depth" value={s.depth} onChange={(e) => patch({ depth: e.target.value })} placeholder="all" />
          </Field>
          <span id="export-crawl-opts">
            <Check id="export-keep-implicit" checked={s.keepImplicit} onChange={(v) => patch({ keepImplicit: v })}
              title="Copy the subtree files and templated tiles as they are, instead of expanding the tree into explicit children. Smaller JSON; needs a client with implicit tiling (CesiumJS, 3DTRjs, Cesium for Unreal).">
              Keep implicit tiling
            </Check>
          </span>
        </>}
        {convert && <div id="export-convert-opts" className="flex flex-1 flex-wrap items-end gap-x-3 gap-y-2">
          <Field compact label="Tiling"><Choice id="conv-tiling" value={s.convTiling} onChange={(v) => patch({ convTiling: v })} options={TILINGS} /></Field>
          <Field compact label="Scale"><TextInput id="conv-scale" value={s.convScale} onChange={(e) => patch({ convScale: e.target.value })} placeholder="1" /></Field>
          <Field compact label="Error scale" title="Multiplies every geometric error"><TextInput id="conv-ge-scale" value={s.convGeScale} onChange={(e) => patch({ convGeScale: e.target.value })} placeholder="1" /></Field>
          <Field compact label="Error layer" title="GE layer"><TextInput id="conv-ge-layer" value={s.convGeLayer} onChange={(e) => patch({ convGeLayer: e.target.value })} placeholder="none" /></Field>
          <Check id="conv-centroids" checked={s.convCentroids} onChange={(v) => patch({ convCentroids: v })} title="Splat formats only: write the splat centres as a point cloud">Splat centres only</Check>
        </div>}
      </div>

      {job.steps ? <StepProgress id="export-progress" steps={job.steps} /> : <div id="export-progress" hidden />}
      <Result id="export-status" message={status} />
      <LogFold wrapId="export-log-wrap" id="export-log" label="Output of the command, last 200 lines" lines={job.log} open={job.logOpen} onOpenChange={(o) => setJob((j) => ({ ...j, logOpen: o }))} logRef={logEl} />
      <Actions id="export-done" hidden={!job.done}>
        <Button id="export-open" variant="default" onClick={openFolder}>Open folder</Button>
        <Button id="export-preview" hidden={!job.preview} onClick={previewExported}>Preview the copy</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button id="export-copy-menu" className="gap-1.5" />}>Copy<ChevronDownIcon className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuItem id="export-copy-unreal" onClick={copyUnreal}>file:// URL, for Cesium for Unreal</DropdownMenuItem>
            <DropdownMenuItem id="export-copy" onClick={copyPath}>Folder path</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Actions>

      <Advanced>
        <div className="mt-3 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <Field label="Check the result" info={<p className="m-0"><strong>Counts</strong> reads every tile's header and compares the total with the source's. <strong>A sample</strong> also reads some tiles in full; <strong>every tile</strong> reads them all.</p>}>
            <Choice id="export-verify" value={s.verify} onChange={(v) => patch({ verify: v })} options={VERIFY} />
          </Field>
          <Field label="If part of the tree cannot be read" title="A subtree, external tileset or Potree .hrc still unread after three tries. The tree below it goes missing.">
            <Choice id="export-hierarchy-errors" value={s.hierarchyErrors} onChange={(v) => patch({ hierarchyErrors: v })} options={HIERARCHY_ERRORS} />
          </Field>
          <Field label="Run" className="col-span-2 max-sm:col-span-1" info={<>
            <p className="m-0"><strong>In the tile-server</strong>: already running, reports structured progress, and serves the result back for the preview.</p>
            <p id="export-runner-hint" className="m-0"><strong>As a separate process</strong>: the command below on its own, so a crash or a memory blow-up cannot take the server down. Prefer it for very large conversions. With the offline converter it does not need the server at all.</p>
          </>}>
            <Segmented id="export-runner" value={runner} onChange={(v) => patch({ runner: v as ExportSettings['runner'] })} disabled={job.running} options={RUNNERS(cli)} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4">
          <FieldLabel>Also pack as</FieldLabel>
          <Check id="pack-3tz" checked={s.pack3tz} onChange={(v) => patch({ pack3tz: v })}>.3tz</Check>
          <Check id="pack-3dtiles" checked={s.pack3dtiles} onChange={(v) => patch({ pack3dtiles: v })}>.3dtiles</Check>
        </div>
        <FieldLabel className="mt-3 mb-1.5">Same thing from a terminal, at the repo root</FieldLabel>
        <UrlBar>
          <Code id="export-cli">{exportCli(req)}</Code>
          <CopyButton id="export-cli-copy" text={exportCli(req)} title="Copy the command" />
        </UrlBar>
      </Advanced>
    </Card>
  );
}

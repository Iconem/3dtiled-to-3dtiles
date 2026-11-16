/**
 * Tile raw input — the third flow, next to "Stream live" and "Export to a folder".
 *
 * The dataset above is a RAW file here (a LAS, an E57, a splat PLY), not a tiled source. This card picks a third-party
 * tiler for it, shows that tool's own options, runs it in a subprocess with its output and Cancel, and hands what it
 * wrote (a COPC, a Potree folder, a streamed SOG) to the stream flow.
 *
 * The tools, their options and where each is on this machine come from the tile-server (`GET /tilers`, which reads
 * packages/tilers). The run goes through the main process's CLI runner (runCli RPC, src/bun/cli-runner.ts), exactly
 * the command shown under "Equivalent CLI": `node packages/tilers/cli.js run <tool> <input> <outDir> …`. A tool that
 * publishes a binary and is not installed is downloaded first, from its authors' release page, and checked against a
 * pinned SHA-256; that only happens after the button says so.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AppModel } from './App';
import { Card } from './components/Card';
import { Actions, Advanced, Check, Choice, Code, Field, FieldLabel, Hint, Result, TextInput, UrlBar, type Kind, type Message } from './components/bits';
import { base, openExternal, pickDataset, pickerAvailable, pickerRpc } from './host';

interface ToolOption {
  key: string; label: string; type: 'int' | 'number' | 'bool' | 'enum' | 'text';
  values?: string[]; default: string | number | boolean; min?: number; max?: number; advanced?: boolean; help: string; placeholder?: string;
}
interface Tool {
  id: string; name: string; summary: string; homepage: string; licence: string; inputs: string[];
  output: { format: string; label: string };
  delivery: 'bundled' | 'download' | 'detect'; version: string | null; downloadable: boolean; downloadBytes: number | null;
  options: ToolOption[];
  found: { status: 'ready' | 'missing'; source: string | null; hint: string | null; path: string | null };
}
interface TilerResult { tool: string; format: string; output: string; outDir: string; seconds: number }

const TILER_CLI = 'packages/tilers/cli.js';
const extOf = (src: string) => (/\.copc\.laz$/i.test(src) ? 'copc.laz' : (src.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '');
const quote = (a: string) => (/[\s"]/.test(a) ? `"${a}"` : a);
const SOURCES: Record<string, string> = { bundled: 'ships with this app', downloaded: 'downloaded by this app', path: 'found on PATH', qgis: 'found in a QGIS install', pixi: 'found in pixi', env: 'set by an environment variable' };

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

export function TilerCard({ app, onStream }: { app: AppModel; onStream: () => void }) {
  const { form, patchForm } = app;
  const src = form.src.trim();
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

  // The tools that take this file, by its extension. Offered first: one that is on this machine already, so that
  // nothing is downloaded unless the user picks a tool that needs it.
  const ext = extOf(src);
  const fitting = useMemo(() => (tools ?? []).filter((t) => t.inputs.includes(ext)), [tools, ext]);
  const tool = fitting.find((t) => t.id === toolId) ?? fitting.find((t) => t.found.status === 'ready') ?? fitting[0] ?? null;
  useEffect(() => { if (tool && tool.id !== toolId) setToolId(tool.id); }, [tool, toolId]);
  const vals = (tool && values[tool.id]) || {};
  const setVal = (key: string, v: string | boolean) => tool && setValues((all) => ({ ...all, [tool.id]: { ...(all[tool.id] ?? {}), [key]: v } }));

  useLayoutEffect(() => { const el = logEl.current; if (el && follow.current) el.scrollTop = el.scrollHeight; }, [log]);

  const missing = tool?.found.status === 'missing';
  const willDownload = !!tool && missing && tool.downloadable;
  const blocked = !!tool && missing && !tool.downloadable;
  const args = tool && src && outDir.trim() ? tilerArgs(tool, src, outDir.trim(), vals, willDownload) : null;
  const cliText = args ? `node ${args.map(quote).join(' ')}` : '';

  async function browseOut() {
    if (!host) return say('The native picker needs the desktop app: type a folder path instead.', 'err');
    const picked = await pickDataset({ directory: true, allowedFileTypes: '*' }).catch(() => []);
    if (picked?.[0]) setOutDir(picked[0]);
  }

  async function start() {
    if (!src) return say('Enter the raw file above first.', 'err');
    if (!tool) return say(`No tool takes a .${ext || '?'} file. Tiled sources (COPC, Potree, SOG…) go to Stream live.`, 'err');
    if (blocked) return say(`${tool.name} is not on this machine: ${tool.found.hint}`, 'err');
    if (!outDir.trim()) return say('Pick an empty output folder.', 'err');
    if (!host || !pickerRpc) return say('Running a tiler needs the desktop app. The command below does the same from a terminal.', 'err');
    try {
      const { id } = await pickerRpc.request.runCli({ args: args! });
      jobId.current = id;
    } catch (e) { return say(`Could not start: ${e instanceof Error ? e.message : e}`, 'err'); }
    follow.current = true;
    setResult(null); setLog([]); setLogOpen(true); setRunning(true);
    say(willDownload ? `Downloading ${tool.name}…` : `Starting ${tool.name}…`);
    void poll();
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
    const shown = st.tail.filter((l) => !l.startsWith('TILER_RESULT '));
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

  /** What the tiler wrote becomes the dataset, and the stream flow opens on it. */
  function streamIt() {
    if (!result) return;
    // A file on disk is read by the converter-backed route (cache=full: converted once to the local cache).
    patchForm({ src: result.output, format: result.format, cache: 'full' });
    onStream();
    app.say(`Now streaming ${result.output}. The first load converts it to the local cache.`, 'ok');
  }
  async function openFolder() {
    if (!result) return;
    if (host) await pickerRpc!.request.openFolder({ path: result.outDir }).catch(() => {});
    else say(result.outDir, 'info');
  }
  async function copyCli() {
    try { await navigator.clipboard.writeText(cliText); say('Command copied.', 'ok'); } catch { /* visible anyway */ }
  }

  const field = (o: ToolOption) => {
    const v = vals[o.key];
    if (o.type === 'bool') return <Check key={o.key} id={`tiler-${o.key}`} checked={v === undefined ? Boolean(o.default) : Boolean(v)} onChange={(c) => setVal(o.key, c)} title={o.help}>{o.label}</Check>;
    if (o.type === 'enum') return (
      <Field key={o.key} label={o.label} title={o.help}>
        <Choice id={`tiler-${o.key}`} value={String(v ?? o.default)} onChange={(c) => setVal(o.key, c)} options={(o.values ?? []).map((x) => ({ value: x, label: x === o.default ? `${x} (default)` : x }))} />
      </Field>
    );
    return (
      <Field key={o.key} label={o.label} title={o.help}>
        <TextInput id={`tiler-${o.key}`} value={String(v ?? '')} onChange={(e) => setVal(o.key, e.target.value)} placeholder={o.placeholder ?? String(o.default)} />
      </Field>
    );
  };
  const basic = tool?.options.filter((o) => !o.advanced) ?? [], advanced = tool?.options.filter((o) => o.advanced) ?? [];
  const grid = (list: ToolOption[]) => (
    <>
      <div className="mt-3.5 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">{list.filter((o) => o.type !== 'bool').map(field)}</div>
      {list.some((o) => o.type === 'bool') && <div className="my-2 flex flex-wrap items-end gap-x-4 gap-y-1.5">{list.filter((o) => o.type === 'bool').map(field)}</div>}
    </>
  );

  return (
    <Card id="tiler-card">
      <FieldLabel className="mb-[9px] text-[13.5px] leading-normal text-foreground">Tile raw input <span className="text-xs font-normal text-muted-foreground">— a LAS, LAZ, E57 or splat PLY that is not tiled yet: run the right tiler on it, then stream the result</span></FieldLabel>
      {unavailable && <Result id="tiler-unavailable" message={{ msg: unavailable, kind: 'err' }} />}
      {tools && !tool && (
        <Hint id="tiler-none">
          {src ? <>No tool here takes a <strong>.{ext || '?'}</strong> file. </> : <>Enter a raw file in the dataset field above. </>}
          Inputs: {[...new Set(tools.flatMap((t) => t.inputs))].map((e) => `.${e}`).join(', ')}. A source that is already tiled (COPC, Potree, streamed SOG, 3D Tiles…) goes straight to <em>Stream live</em>.
        </Hint>
      )}
      {tool && (
        <>
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Field label="Tool">
              <Choice id="tiler-tool" value={tool.id} onChange={setToolId} disabled={running}
                options={fitting.map((t) => ({ value: t.id, label: `${t.name} → ${t.output.label}` }))} />
            </Field>
            <Field label="Output folder">
              <UrlBar>
                <TextInput id="tiler-out" value={outDir} onChange={(e) => setOutDir(e.target.value)} placeholder="C:\tiled\my-scan   (an empty folder)" className="flex-1" />
                {host && <Button id="tiler-browse" onClick={browseOut}>Folder…</Button>}
              </UrlBar>
            </Field>
          </div>
          <Hint id="tiler-about" className="mt-2.5">
            {tool.summary}{' '}
            <a href={tool.homepage} onClick={(e) => { e.preventDefault(); openExternal(tool.homepage); }} className="underline">{tool.licence} licence, project page</a>.{' '}
            <span id="tiler-found" data-status={tool.found.status}>
              {tool.found.status === 'ready'
                ? <>On this machine: {SOURCES[tool.found.source ?? ''] ?? tool.found.source}{tool.found.hint ? ` (${tool.found.hint})` : ''}.</>
                : willDownload
                  ? <><strong>Not installed.</strong> Running it first downloads {tool.name} {tool.version} ({((tool.downloadBytes ?? 0) / 1e6).toFixed(0)} MB) from its authors' release page, checks it against a pinned SHA-256 and keeps it in this app's tools folder.</>
                  : <><strong>Not on this machine:</strong> {tool.found.hint}.</>}
            </span>
          </Hint>
          {basic.length > 0 && grid(basic)}
          <Actions>
            {running
              ? <Button id="tiler-cancel" variant="outline" onClick={cancel} className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive">Cancel</Button>
              : <Button id="tiler-start" variant="default" disabled={blocked} onClick={start}>{willDownload ? 'Download and run' : 'Run'}</Button>}
          </Actions>
          <Result id="tiler-status" message={status} />
          <details id="tiler-log-wrap" hidden={log == null} open={logOpen} onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)} className="mt-2.5">
            <summary className="cursor-pointer text-[12.5px] text-foreground select-none">Tool output <span className="text-xs font-normal text-muted-foreground">(last 200 lines)</span></summary>
            <pre id="tiler-log" ref={logEl} className="mt-2 mb-0 max-h-[220px] overflow-auto rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] break-all whitespace-pre-wrap">{log?.join('\n')}</pre>
          </details>
          <Actions id="tiler-done" hidden={!result}>
            <Button id="tiler-stream" variant="default" onClick={streamIt}>Stream it</Button>
            <Button id="tiler-open" onClick={openFolder}>Open folder</Button>
          </Actions>
          <Advanced summary="Advanced" hint="more options of the tool, CLI">
            {advanced.length > 0 && grid(advanced)}
            <FieldLabel className="mt-3.5 mb-[9px]">Equivalent CLI <span className="text-xs font-normal">(from the repo root)</span></FieldLabel>
            <UrlBar>
              <Code id="tiler-cli" wrap empty={!cliText}>{cliText || 'pick an output folder'}</Code>
              <Button id="tiler-cli-copy" disabled={!cliText} onClick={copyCli}>Copy</Button>
            </UrlBar>
            {!host && <Hint className="mt-3">Running a tiler needs the desktop app; in a plain browser this card only shows the tools and the command.</Hint>}
          </Advanced>
        </>
      )}
    </Card>
  );
}

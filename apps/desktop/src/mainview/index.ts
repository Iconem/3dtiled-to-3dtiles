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
 * The ports and the docs/viewer URLs arrive in the query string (see src/bun/index.ts): the main
 * process may adopt an already-running server rather than starting one, and it resolves whether a
 * local viewer/docs is up — neither is knowable at build time.
 */
import { Electroview } from 'electrobun/view';
import { CATALOG, LINKS, type Sample } from './catalog';
import { loadLibrary, saveLocal, newId, noteExported, noteServed, parseLibrary, serialize, type DatasetOptions, type HistoryEntry, type Library } from './library';
import type { DesktopRPC } from '../shared/rpc-schema';

/**
 * RPC to the main process, for the one thing a webview genuinely cannot do: open a native file
 * dialog and learn a real filesystem path.
 *
 * Construction is guarded because this same bundle is rendered in a plain browser during
 * verification (esbuild + a static server), where there is no Electrobun host to talk to. In that
 * case `picker` stays null and the Browse buttons hide themselves rather than throwing on click.
 */
type PickerRPC = ReturnType<typeof Electroview.defineRPC<DesktopRPC>>;

let pickerRpc: PickerRPC | null = null;
try {
  const rpc = Electroview.defineRPC<DesktopRPC>({ handlers: { requests: {} } });
  // Constructing the view is what wires the transport; we keep the rpc handle, not the view.
  new Electroview({ rpc });
  pickerRpc = rpc;
} catch {
  pickerRpc = null;
}
const pickerAvailable = () => Boolean(pickerRpc && (globalThis as { __electrobun?: unknown }).__electrobun);

const params = new URLSearchParams(location.search);
const tilePort = params.get('tilePort');
const staticPort = params.get('staticPort');
const base = tilePort ? `http://127.0.0.1:${tilePort}` : '';
const viewerUrl = params.get('viewerUrl') || '';
const docsUrl = params.get('docsUrl') || '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const srcEl = $<HTMLInputElement>('src');
const formatEl = $<HTMLSelectElement>('format');
const cacheEl = $<HTMLSelectElement>('cache');
const urlEl = $<HTMLElement>('url');
const resultEl = $<HTMLElement>('result');

const placement = ['lon', 'lat', 'alt', 'heading'] as const;

/**
 * `/tiles` is the front door: it dispatches to /stream for cache=none|hierarchy and /convert for
 * cache=full, so the UI does not have to encode that routing rule a second time.
 */
function buildUrlFrom(o: { src: string; format: string; cache: string; lon?: string; lat?: string; alt?: string; heading?: string }): string {
  if (!base || !o.src) return '';
  const q = new URLSearchParams();
  q.set('url', o.src);
  if (o.format) q.set('format', o.format);
  q.set('cache', o.cache);
  for (const k of placement) {
    const v = (o as Record<string, string | undefined>)[k];
    if (v != null && v !== '') q.set(k, v);
  }
  return `${base}/tiles/tileset.json?${q.toString()}`;
}

const currentForm = () => ({
  src: srcEl.value.trim(),
  format: formatEl.value,
  cache: cacheEl.value,
  lon: $<HTMLInputElement>('lon').value.trim(),
  lat: $<HTMLInputElement>('lat').value.trim(),
  alt: $<HTMLInputElement>('alt').value.trim(),
  heading: $<HTMLInputElement>('heading').value.trim(),
});

const buildUrl = () => buildUrlFrom(currentForm());

function refresh() {
  const u = buildUrl();
  urlEl.textContent = u || '—';
  urlEl.classList.toggle('empty', !u);
  const entered = srcEl.value.trim() !== '';
  $('flows').hidden = !entered;
  $('flows-empty').hidden = entered;
  requestAnimationFrame(fitWindowToContent);
}

function say(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  resultEl.textContent = msg;
  resultEl.className = `result result-${kind}`;
}

// A downloaded update waits for this button: restarting by itself could end a running conversion.
const updateBtn = $<HTMLButtonElement>('update');
updateBtn.addEventListener('click', () => {
  updateBtn.disabled = true;
  void pickerRpc?.request.applyUpdate({});
});
const updatePoll = setInterval(async () => {
  const version = (await pickerRpc?.request.updateStatus({}).catch(() => null))?.version;
  if (version == null) return;
  updateBtn.title = `Restart into version ${version}`;
  updateBtn.hidden = false;
  clearInterval(updatePoll);
}, 30_000);

for (const el of [srcEl, formatEl, cacheEl, ...placement.map((k) => $<HTMLInputElement>(k))]) {
  el.addEventListener('input', refresh);
  el.addEventListener('change', refresh);
}

// ── native file picker ──────────────────────────────────────────────────────────────────────────
//
// Tree formats are a FOLDER (Potree's cloud.js directory, a streamed-SOG LOD folder, an unpacked
// 3D Tiles tree); single-file formats are a FILE (.copc.laz, .rad, .lcc, .3tz). Hence two buttons
// rather than one dialog that has to guess — on Windows a single dialog cannot offer both.
const DATASET_FILE_TYPES = 'laz,las,copc,rad,lcc,json,js,zip,3tz,slpk,glb,b3dm';

async function browse(directory: boolean) {
  if (!pickerAvailable()) return say('The native picker needs the desktop app — paste a path instead.', 'err');
  try {
    const picked = await pickerRpc!.request.pickDataset({
      directory,
      allowedFileTypes: directory ? '*' : DATASET_FILE_TYPES,
    });
    const path = picked?.[0];
    if (!path) return;                                   // user cancelled — not an error
    srcEl.value = path;
    refresh();
    say(`Selected ${path}`, 'ok');
  } catch (e) {
    say(`File picker failed: ${e}`, 'err');
  }
}

$('browse-file').addEventListener('click', () => browse(false));
$('browse-dir').addEventListener('click', () => browse(true));

// ── window sizing ───────────────────────────────────────────────────────────────────────────────
//
// Only the view can measure the content; only the host can resize the window. The conversion between
// them is the subtle part on Windows, so the measurements are logged — `hutch electrobun dev` prints
// them, which is how the CSS-px-vs-frame-px mismatch was pinned down in the first place.
let lastFit = '';

function fitWindowToContent() {
  if (!pickerAvailable()) return;                 // no host to resize (plain-browser preview)
  if (!$('overlay').hidden) return;               // a preview asked for its own size
  const el = document.querySelector<HTMLElement>('.container');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const cssWidth = Math.ceil(rect.width + 24);    // the content, centred, + breathing room
  const cssHeight = Math.ceil(document.documentElement.scrollHeight + 8);
  const key = `${cssWidth}x${cssHeight}`;
  if (key === lastFit) return;                    // don't spam the host on every tab switch
  lastFit = key;
  console.log(`[fit] css=${cssWidth}x${cssHeight} innerWidth=${window.innerWidth} `
    + `innerHeight=${window.innerHeight} dpr=${window.devicePixelRatio} scrollW=${document.documentElement.scrollWidth}`);
  pickerRpc!.request.fitWindow({
    cssWidth, cssHeight,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  }).catch(() => { /* host declined — the layout still works, it just may need scrolling */ });
}

// ── tabs ────────────────────────────────────────────────────────────────────────────────────────
function showTab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    b.classList.toggle('tab-active', b.dataset['tab'] === name);
  }
  for (const p of document.querySelectorAll<HTMLElement>('.panel')) {
    p.classList.toggle('panel-hidden', p.id !== `panel-${name}`);
  }
  // Panels differ hugely in height (Build is short, Samples is a 20-row catalogue), so re-fit.
  requestAnimationFrame(fitWindowToContent);
}
document.addEventListener('toggle', () => requestAnimationFrame(fitWindowToContent), true);   // the Advanced folds
$('tabs').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('.tab');
  // `dataset` is an index signature, so bracket access is required under
  // noPropertyAccessFromIndexSignature (this tsconfig enables it).
  const tab = t?.dataset['tab'];
  if (tab) showTab(tab);
});

// ── build actions ───────────────────────────────────────────────────────────────────────────────
$('copy').addEventListener('click', async () => {
  const u = buildUrl();
  if (!u) return say('Enter a dataset path or URL first.', 'err');
  const f = currentForm();
  noteServed(lib, nameFor(f.src), f); persist();
  try { await navigator.clipboard.writeText(u); say('Copied — paste it into Cesium for Unreal/Unity, QGIS or CesiumJS.', 'ok'); }
  catch { say(u, 'info'); }
});

$('check').addEventListener('click', async () => {
  const u = buildUrl();
  if (!u) return say('Enter a dataset path or URL first.', 'err');
  say('requesting…');
  try {
    const t0 = performance.now();
    const r = await fetch(u);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return say(`HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`, 'err');
    const j = await r.json();
    const f = currentForm();
    noteServed(lib, nameFor(f.src), f); persist();
    const root = j.root ?? {};
    const bv = root.boundingVolume ?? {};
    const kind = bv.region ? 'region' : bv.box ? 'box' : bv.sphere ? 'sphere' : 'none';
    say(`OK in ${ms} ms — asset ${j.asset?.version ?? '?'}, geometricError ${Math.round(root.geometricError ?? 0)}, `
      + `boundingVolume ${kind}, ${root.children?.length ?? 0} root children`
      + (root.transform ? ', placed via root transform' : ''), 'ok');
  } catch (e) { say(`Request failed: ${e}`, 'err'); }
});

const previewUrl = (u: string) =>
  staticPort ? `http://127.0.0.1:${staticPort}/cesium-harness.html?url=${encodeURIComponent(u)}` : '';

// ── preview over the launcher ───────────────────────────────────────────────────────────────────
//
// Cesium is the stock harness, with zero viewer-side fix-ups: whatever it shows is what any 3D Tiles
// client gets from the tileset alone. 3DTRjs is the demo viewer, told to load the tileset.
let overlayTarget: { tileset: string; type: string; external: string } | null = null;

function showInOverlay(url: string, title: string) {
  $<HTMLIFrameElement>('overlay-frame').src = url;
  $('overlay-title').textContent = title;
  // 3D needs more room than the launcher's form; closing the preview gives it back.
  if ($('overlay').hidden) pickerRpc?.request.fitWindow({ cssWidth: 1280, cssHeight: 800, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }).catch(() => {});
  $('overlay').hidden = false;
}

function previewIn(renderer: 'cesium' | '3dtrjs', tileset: string, type: string, title: string) {
  const url = renderer === 'cesium' ? previewUrl(tileset) : viewerLink(tileset, type);
  if (!url) return say(renderer === 'cesium' ? 'Preview unavailable: the static server for cesium-harness.html did not start.' : 'Preview unavailable: no demo viewer address.', 'err');
  overlayTarget = { tileset, type, external: url };
  $('overlay-renderers').hidden = false;
  $('overlay-cesium').classList.toggle('active', renderer === 'cesium');
  $('overlay-3dtrjs').classList.toggle('active', renderer === '3dtrjs');
  showInOverlay(url, title);
}

function openTool(url: string, title: string) {
  overlayTarget = { tileset: '', type: '', external: url };
  $('overlay-renderers').hidden = true;
  showInOverlay(url, title);
}

function closeOverlay() {
  $('overlay').hidden = true;
  $<HTMLIFrameElement>('overlay-frame').src = 'about:blank';   // frees the renderer's GPU memory
  overlayTarget = null;
  lastFit = '';
  requestAnimationFrame(fitWindowToContent);
}
$('overlay-back').addEventListener('click', closeOverlay);
$('overlay-cesium').addEventListener('click', () => { if (overlayTarget) previewIn('cesium', overlayTarget.tileset, overlayTarget.type, $('overlay-title').textContent ?? ''); });
$('overlay-3dtrjs').addEventListener('click', () => { if (overlayTarget) previewIn('3dtrjs', overlayTarget.tileset, overlayTarget.type, $('overlay-title').textContent ?? ''); });
$('overlay-external').addEventListener('click', () => {
  if (!overlayTarget) return;
  if (pickerRpc) void pickerRpc.request.openExternal({ url: overlayTarget.external }).catch(() => {});
  else window.open(overlayTarget.external, '_blank');
});

function previewCurrent(renderer: 'cesium' | '3dtrjs') {
  const u = buildUrl();
  if (!u) return say('Enter a dataset path or URL first.', 'err');
  const f = currentForm();
  noteServed(lib, nameFor(f.src), f); persist();
  previewIn(renderer, u, assetType(), nameFor(f.src));
}
$('preview').addEventListener('click', () => previewCurrent('cesium'));
$('preview-3dtrjs').addEventListener('click', () => previewCurrent('3dtrjs'));

$('playground').addEventListener('click', () => { if (base) openTool(`${base}/playground`, 'API playground'); });
$('hierarchy').addEventListener('click', () => {
  const u = buildUrl();
  if (!base) return;
  // Prefer the viewer app's multi-tileset explorer when one is reachable; the server's own page is
  // the always-available single-tileset fallback.
  const target = viewerUrl ? `${viewerUrl}/hierarchy` : `${base}/hierarchy`;
  openTool(u ? `${target}?url=${encodeURIComponent(u)}` : target, 'Hierarchy graph');
});

$('save').addEventListener('click', () => {
  const f = currentForm();
  if (!f.src) return say('Enter a dataset path or URL first.', 'err');
  lib.bookmarks.push({ id: newId(), name: nameFor(f.src), addedAt: Date.now(), ...f });
  persist();
  say('Bookmarked.', 'ok');
  showTab('library');
});

// ── export to a folder ──────────────────────────────────────────────────────────────────────────
//
// Two ways to fill a folder:
//   crawl   — download the tileset URL above as served: any source (raw via /stream or /convert,
//             remote 3D Tiles, mosaics), implicit tilings expanded or kept.
//   convert — the per-format offline converter (packages/convert) on the raw source: faster for the
//             formats it covers, with their own options.
// And two places to run it ("Run in"):
//   server  — POST /export on the tile-server (packages/tile-server/export-live.js), the default: it is
//             already running with every adapter loaded, reports structured progress, the job survives
//             switching tabs, and it serves the result back for the preview buttons.
//   cli     — the main process spawns exactly the command shown under "Equivalent CLI" (runCli RPC,
//             src/bun/cli-runner.ts): an isolated process whose crash or OOM can't take the server
//             down; progress is parsed from its output. A convert does not need the server at all (a crawl
//             still reads the tileset URL, which the server serves).
const exportDirEl = $<HTMLInputElement>('export-dir');
const exportBar = $<HTMLElement>('export-bar');
const methodEl = $<HTMLSelectElement>('export-method');
const runnerEl = $<HTMLSelectElement>('export-runner');
let exportJob: string | null = null;
let cliJob: string | null = null;
let exportPreview = '';
let exportStarted: { form: DatasetOptions; outDir: string; method: string } | null = null;

/** An export that ended goes in the history, however it ended. */
function recordExport(state: NonNullable<HistoryEntry['state']>, files?: number, bytes?: number) {
  if (!exportStarted) return;
  const { form, outDir, method } = exportStarted;
  exportStarted = null;
  noteExported(lib, nameFor(form.src), form, { outDir, method, state, files, bytes });
  persist();
}

function exportSay(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const el = $('export-status');
  el.textContent = msg;
  el.className = `result result-${kind}`;
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

function exportRequest() {
  const f = currentForm();
  const depth = val('export-depth');
  const pack = [checked('pack-3tz') && '3tz', checked('pack-3dtiles') && '3dtiles'].filter(Boolean) as string[];
  const options: Record<string, unknown> = {};
  if ($<HTMLSelectElement>('conv-tiling').value) options['tiling'] = $<HTMLSelectElement>('conv-tiling').value;
  for (const [id, key] of [['conv-scale', 'scale'], ['conv-ge-scale', 'geScale'], ['conv-ge-layer', 'geLayer']] as const) {
    if (val(id) !== '') options[key] = Number(val(id));
  }
  if (checked('conv-centroids')) options['centroidsOnly'] = true;
  return {
    method: methodEl.value as 'crawl' | 'convert',
    url: buildUrl(), src: f.src, format: f.format, outDir: exportDirEl.value.trim(),
    maxDepth: depth === '' ? null : Number(depth), keepImplicit: checked('export-keep-implicit'), pack, options,
  };
}

type ExportRequest = ReturnType<typeof exportRequest>;

/**
 * The CLI doing the same thing, as argv arrays (after `node`, from the repo root): what the card
 * displays AND what "Run in: CLI subprocess" executes, so the two cannot drift. `then` is the pack
 * step for the offline converter, whose default path has no `--pack`.
 */
function exportCliArgs(r: ExportRequest = exportRequest()): { args: string[]; then?: string[] } {
  const out = r.outDir || '<empty folder>';
  if (r.method === 'crawl') {
    const args = ['packages/convert/cli.js', 'export', r.url || '<tileset url>', out];
    if (r.maxDepth != null) args.push('--max-depth', String(r.maxDepth));
    if (r.keepImplicit) args.push('--keep-implicit');
    if (r.pack.length) args.push('--pack', r.pack.join(','));
    return { args };
  }
  const o = r.options as Record<string, unknown>;
  const args = ['packages/convert/cli.js', r.src || '<source>', out];
  if (r.format) args.push('--format', r.format);
  if (o['tiling']) args.push('--tiling', String(o['tiling']));
  for (const [key, fl] of [['scale', '--scale'], ['geScale', '--ge-scale'], ['geLayer', '--ge-layer']] as const) {
    if (o[key] != null) args.push(fl, String(o[key]));
  }
  if (o['centroidsOnly']) args.push('--centroids-only');
  if (!r.pack.length) return { args };
  const name = out.split(/[\\/]/).filter(Boolean).pop() || 'tileset';
  return { args, then: ['scripts/pack-3dtiles.mjs', out, `${out}/${name}`] };
}

/** Shell-ish rendering for display/copy: plain tokens bare, anything else (paths, URLs) quoted. */
const shellLine = (args: string[]) => ['node', ...args].map((a) => (/^[\w.,/=-]+$/.test(a) ? a : q(a))).join(' ');

/** The CLI command doing the same thing (from the repo root; `3dtiled` once the package is linked). */
function exportCli(r: ExportRequest = exportRequest()): string {
  const { args, then } = exportCliArgs(r);
  return then ? `${shellLine(args)}\n# then (writes both .3tz and .3dtiles):\n${shellLine(then)}` : shellLine(args);
}

/** The demo viewer, told to load a tileset on start (its `?load=` parameter). */
function viewerLink(tilesetUrl: string, type = 'mesh'): string {
  if (!viewerUrl || !tilesetUrl) return '';
  return `${viewerUrl}/?mode=stream&format=3dtiles&renderer=3dtrjs&type=${type}&load=${encodeURIComponent(tilesetUrl)}`;
}
const typeOfFormat = (format: string) => (['copc', 'potree'].includes(format) ? 'pointcloud' : ['sog', 'lcc', 'rad', 'geosplats'].includes(format) ? 'splat' : 'mesh');
const assetType = () => typeOfFormat(formatEl.value);

function refreshExport() {
  const convert = methodEl.value === 'convert';
  $('export-crawl-opts').hidden = convert;
  $('export-convert-opts').hidden = !convert;
  $<HTMLInputElement>('export-depth').disabled = convert;
  $('export-cli').textContent = exportCli();
  if (runnerEl.value === 'cli' && !pickerAvailable()) runnerEl.value = 'server';
  const live = viewerLink(buildUrl(), assetType());
  const a = $<HTMLAnchorElement>('export-live');
  a.href = live || '#';
  a.hidden = !live;
}
for (const el of document.querySelectorAll('#export-card input, #export-card select')) {
  el.addEventListener('input', refreshExport);
  el.addEventListener('change', refreshExport);
}
for (const el of [srcEl, formatEl, cacheEl, ...placement.map((k) => $<HTMLInputElement>(k))]) { el.addEventListener('input', refreshExport); el.addEventListener('change', refreshExport); }
const docsBase = docsUrl.replace(/\/$/, '');
$<HTMLAnchorElement>('export-doc').href = docsBase ? `${docsBase}/guide/desktop-app#export-to-a-folder` : '#';
$<HTMLAnchorElement>('export-cli-doc').href = docsBase ? `${docsBase}/guide/cli-usage#export-a-tileset-to-a-folder` : '#';
$<HTMLAnchorElement>('export-mw').href = base ? `${base}/` : '#';
// The CLI runner lives in the main process; a plain browser (verification bundle) has no host.
if (!pickerAvailable()) {
  (runnerEl.querySelector('option[value="cli"]') as HTMLOptionElement).disabled = true;
  runnerEl.title = 'CLI subprocess needs the desktop app';
  $('export-runner-na').hidden = false;
}
refreshExport();

$('export-cli-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(exportCli()); exportSay('Command copied.', 'ok'); } catch { /* visible anyway */ }
});

$('export-browse').addEventListener('click', async () => {
  if (!pickerAvailable()) return exportSay('The native picker needs the desktop app — type a folder path instead.', 'err');
  const picked = await pickerRpc!.request.pickDataset({ directory: true, allowedFileTypes: '*' }).catch(() => []);
  if (picked?.[0]) { exportDirEl.value = picked[0]; refreshExport(); }
});

$('export-start').addEventListener('click', async () => {
  const r = exportRequest();
  if (r.method === 'crawl' && !r.url) return exportSay('Enter a dataset path or URL first.', 'err');
  if (r.method === 'convert' && !r.src) return exportSay('Enter a dataset path or URL first.', 'err');
  if (!r.outDir) return exportSay('Pick an empty output folder.', 'err');
  if (r.maxDepth != null && !(r.maxDepth >= 0)) return exportSay('Max depth must be a number of levels.', 'err');
  $('export-done').hidden = true;
  exportStarted = { form: currentForm(), outDir: r.outDir, method: r.method };
  if (runnerEl.value === 'cli') return startCliExport(r);
  $('export-log-wrap').hidden = true;
  $('export-preview').hidden = false;
  try {
    const resp = await fetch(`${base}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) return exportSay(j.error || `HTTP ${resp.status}`, 'err');
    exportJob = j.id;
    $('export-progress').hidden = false;
    exportBar.classList.add('indeterminate');
    // the offline converters run in-process and can't be interrupted part-way
    setExportRunning(true, r.method !== 'convert');
    exportSay(r.method === 'convert' ? 'Converting…' : 'Reading the tileset tree…');
    pollExport();
  } catch (e) { exportSay(`Export request failed: ${e}`, 'err'); }
});

$('export-cancel').addEventListener('click', async () => {
  if (cliJob) { await pickerRpc?.request.cancelCli({ id: cliJob }).catch(() => false); return; }
  if (exportJob) await fetch(`${base}/export/${exportJob}`, { method: 'DELETE' }).catch(() => {});
});

// ── Run in: CLI subprocess ────────────────────────────────────────────────────────────────────────
const exportLog = $<HTMLElement>('export-log');

function setExportRunning(running: boolean, cancellable: boolean) {
  ($('export-start') as HTMLButtonElement).disabled = running;
  ($('export-cancel') as HTMLButtonElement).disabled = !(running && cancellable);
  runnerEl.disabled = running;
}

async function startCliExport(r: ExportRequest) {
  if (!pickerAvailable()) return exportSay('CLI subprocess needs the desktop app — use Run in: tile-server here.', 'err');
  const { args, then } = exportCliArgs(r);
  try {
    const { id } = await pickerRpc!.request.runCli(then ? { args, then } : { args });
    cliJob = id;
  } catch (e) { return exportSay(`Could not start the CLI: ${e instanceof Error ? e.message : e}`, 'err'); }
  // The preview buttons need the server's job URL; a CLI export is a plain folder on disk.
  exportPreview = '';
  $('export-preview').hidden = true;
  exportLog.textContent = '';
  $('export-log-wrap').hidden = false;
  $('export-progress').hidden = false;
  exportBar.style.width = '0%';
  exportBar.classList.add('indeterminate');
  setExportRunning(true, true);   // a subprocess can always be killed, convert included
  exportSay('Starting node…');
  pollCli();
}

async function pollCli() {
  const id = cliJob;
  if (!id || !pickerRpc) return;
  let s: Awaited<ReturnType<typeof pickerRpc.request.cliStatus>>;
  try { s = await pickerRpc.request.cliStatus({ id }); }
  catch { setTimeout(pollCli, 1000); return; }
  if (!s) { cliJob = null; setExportRunning(false, false); return exportSay('The CLI job is gone (was the app restarted?).', 'err'); }
  // Show the tail; keep following it only if the user hasn't scrolled up.
  const follow = exportLog.scrollHeight - exportLog.scrollTop - exportLog.clientHeight < 24;
  exportLog.textContent = s.tail.join('\n');
  if (follow) exportLog.scrollTop = exportLog.scrollHeight;
  const out = s.tail.filter((l) => !l.startsWith('[desktop]') && !l.startsWith('$ '));
  const last = out[out.length - 1]?.trim() ?? '';
  // "downloading: 3 tilesets · 14/315 files · 1.8 MB" → a real bar once the total is known
  const m = /^(\w[\w ]*): .*?(\d+)\/(\d+) files/.exec(last);
  if (m && m[1] === 'downloading') {
    exportBar.classList.remove('indeterminate');
    exportBar.style.width = `${Math.round((100 * Number(m[2])) / Math.max(1, Number(m[3])))}%`;
  }
  const secs = (((s.endedAt ?? Date.now()) - s.startedAt) / 1000).toFixed(s.endedAt ? 1 : 0);
  if (s.state === 'running') {
    exportSay(`${secs} s — ${last || 'running…'}`);
    setTimeout(pollCli, 500);
    return;
  }
  cliJob = null;
  setExportRunning(false, false);
  recordExport(s.state);
  exportBar.classList.remove('indeterminate');
  exportBar.style.width = '100%';
  if (s.state === 'done') {
    $('export-done').hidden = false;
    exportSay(`Done in ${secs} s — ${last}`, 'ok');
  } else if (s.state === 'cancelled') {
    exportSay(`Cancelled after ${secs} s — the folder holds a partial copy.`, 'err');
  } else {
    exportSay(`CLI failed (exit code ${s.exitCode ?? '?'})${last ? ` — ${last}` : ''}. See the output below.`, 'err');
    ($('export-log-wrap') as HTMLDetailsElement).open = true;
  }
}

const PHASES: Record<string, string> = {
  crawling: 'Crawling', downloading: 'Downloading', converting: 'Converting',
  'expanding implicit tiling': 'Expanding implicit tiling', 'reading implicit availability': 'Reading implicit availability',
};

async function pollExport() {
  const id = exportJob;
  if (!id) return;
  let j: any;
  try { j = await (await fetch(`${base}/export/${id}`)).json(); }
  catch { setTimeout(pollExport, 1000); return; }
  const pr = j.progress ?? {};
  const discovered = pr.tilesDiscovered ?? 0, written = pr.tilesWritten ?? 0;
  // The total is unknown while external tilesets are still being crawled, hence the indeterminate bar.
  if (pr.phase === 'downloading' || j.state !== 'running') {
    exportBar.classList.remove('indeterminate');
    exportBar.style.width = `${discovered ? Math.round((100 * written) / discovered) : 100}%`;
  }
  const line = pr.phase === 'converting' || j.result?.method === 'convert'
    ? (j.state === 'running' ? `${((pr.elapsedMs ?? 0) / 1000).toFixed(0)} s` : `${written} files · ${mb(pr.bytes ?? 0)}`)
    : `${pr.tilesets ?? 0} tilesets · ${written}/${discovered} files · ${mb(pr.bytes ?? 0)}`
      + (pr.implicitExpanded ? ` · ${pr.implicitExpanded} implicit expanded` : '')
      + (pr.implicitKept ? ` · ${pr.implicitKept} implicit kept` : '')
      + (pr.failed ? ` · ${pr.failed} failed` : '');
  if (j.state === 'running') {
    const phase = PHASES[pr.phase] ?? (pr.phase ? pr.phase[0].toUpperCase() + pr.phase.slice(1) : 'Working');
    exportSay(`${phase} — ${line}`);
    setTimeout(pollExport, 500);
    return;
  }
  exportJob = null;
  setExportRunning(false, false);
  recordExport(j.state === 'done' ? 'done' : j.state === 'cancelled' ? 'cancelled' : 'failed', written, pr.bytes);
  if (j.state === 'done') {
    exportPreview = j.preview ? `${base}${j.preview}` : '';
    $('export-done').hidden = false;
    const packs = j.result?.packages?.length ? ` Packed: ${j.result.packages.join(', ')}.` : '';
    exportSay(`Done in ${((j.result?.elapsedMs ?? pr.elapsedMs ?? 0) / 1000).toFixed(1)} s — ${line}.${packs}`
      + (pr.failed ? ' Failed files are listed in export-report.json; re-run into a new folder to retry.' : ''), pr.failed ? 'info' : 'ok');
  } else {
    exportSay(j.state === 'cancelled' ? `Cancelled — ${line}. The folder holds a partial copy.` : `Export failed: ${j.error}`, 'err');
  }
}

$('export-open').addEventListener('click', async () => {
  const dir = exportDirEl.value.trim();
  if (pickerAvailable()) await pickerRpc!.request.openFolder({ path: dir }).catch(() => {});
  else exportSay(dir, 'info');
});
$('export-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(exportDirEl.value.trim()); exportSay('Folder path copied.', 'ok'); } catch { /* shown already */ }
});
$('export-preview').addEventListener('click', () => {
  // The exported files, served back by the tile-server exactly as a static host would serve them.
  if (exportPreview) previewIn('cesium', exportPreview, assetType(), 'Exported copy');
});

// A server started without TILED_ALLOW_EXPORT (e.g. an adopted `pnpm dev` one) can't export; say so
// up front rather than on the first click.
if (base) {
  fetch(`${base}/export`).then(async (r) => {
    if (r.status === 403) {
      const j = await r.json().catch(() => ({}));
      exportSay(j.error || 'Export is disabled on this tile-server.', 'err');
      ($('export-start') as HTMLButtonElement).disabled = true;
    }
  }).catch(() => {});
}

/** Short display name from a path or URL — the entry file name is the same for every dataset. */
function nameFor(src: string): string {
  const clean = src.split('?')[0].replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const last = parts.pop() ?? src;
  if (/^(tileset\.json|cloud\.js|metadata\.json|lod-meta\.json|meta\.lcc)$/i.test(last)) {
    return parts.pop() ?? last;
  }
  return last;
}

// ── library ─────────────────────────────────────────────────────────────────────────────────────
let lib: Library = loadLibrary();

function persist() {
  saveLocal(lib);
  if (pickerAvailable()) pickerRpc!.request.writeLibrary({ json: serialize(lib) }).catch(() => { /* localStorage still has it */ });
  renderLibrary();
}

const hostOf = (id: string) => { const host = $(id); host.textContent = ''; return host; };
const emptyHint = (host: HTMLElement, text: string) => {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  host.appendChild(p);
};

/** One row of either list: what the dataset is, one line about it, and its actions. */
function libraryRow(e: DatasetOptions & { name: string }, meta: HTMLElement, acts: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'item';

  const glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.dataset['kind'] = kindOf(e.format);
  glyph.textContent = iconOf(e.format);

  const body = document.createElement('div');
  body.className = 'item-body';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = e.name;
  const tag = document.createElement('span');
  tag.className = 'chip';
  tag.textContent = e.format || 'auto';
  title.appendChild(tag);
  if (e.lon && e.lat) {
    const geo = document.createElement('span');
    geo.className = 'chip';
    geo.textContent = `${e.lon}, ${e.lat}`;
    title.appendChild(geo);
  }
  const sub = document.createElement('div');
  sub.className = 'item-sub';
  sub.textContent = e.src;
  sub.title = e.src;
  meta.classList.add('item-meta');
  body.append(title, sub, meta);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.append(...acts);

  row.append(glyph, body, actions);
  return row;
}

const openBtn = (e: DatasetOptions) => mkBtn('Open', 'btn-ghost', () => { loadIntoBuilder(e); showTab('build'); });
const copyBtn = (e: DatasetOptions) => mkBtn('Copy', 'btn-ghost', async () => {
  try { await navigator.clipboard.writeText(buildUrlFrom(e)); say('Copied.', 'ok'); } catch { /* ignore */ }
});

function renderLibrary() {
  $('lib-count').textContent = String(lib.bookmarks.length);
  const host = hostOf('lib-list');
  if (!lib.bookmarks.length) emptyHint(host, 'Nothing bookmarked yet — enter a dataset and press Bookmark, or start from Samples.');
  for (const e of lib.bookmarks) {
    const meta = document.createElement('div');
    if (e.stats) {
      const n = e.stats.tiles.toLocaleString('en-US');
      meta.textContent = e.stats.truncated
        // "≥" and the explicit note: the walk stopped at the budget, so these are floors, not facts.
        ? `≥${n} tiles · depth ≥${e.stats.depth} · ≥${e.stats.leaves.toLocaleString('en-US')} leaves (node budget reached)`
        : `${n} tiles · depth ${e.stats.depth} · ${e.stats.leaves.toLocaleString('en-US')} leaves`;
      if (e.stats.truncated) meta.classList.add('item-meta-partial');
    } else {
      meta.textContent = 'not checked yet';
    }
    host.appendChild(libraryRow(e, meta, [
      openBtn(e),
      copyBtn(e),
      mkBtn('Preview', 'btn-ghost', () => previewIn('cesium', buildUrlFrom(e), typeOfFormat(e.format), e.name)),
      mkBtn('Remove', 'btn-ghost', () => { lib.bookmarks = lib.bookmarks.filter((x) => x.id !== e.id); persist(); }),
    ]));
  }

  const hist = hostOf('hist-list');
  $<HTMLButtonElement>('hist-clear').disabled = !lib.history.length;
  if (!lib.history.length) emptyHint(hist, 'Nothing yet — a URL you copy, preview or test, and every export, shows up here.');
  for (const e of lib.history) {
    const meta = document.createElement('div');
    const when = new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    meta.textContent = e.kind === 'served'
      ? `Served · ${when}${(e.count ?? 1) > 1 ? ` · ${e.count} times` : ''}`
      : `Exported · ${when} · ${e.state === 'done' ? 'done' : e.state}${e.files ? ` · ${e.files} files` : ''}${e.bytes ? ` · ${mb(e.bytes)}` : ''} · ${e.outDir}`;
    if (e.kind === 'exported') meta.title = e.outDir ?? '';
    hist.appendChild(libraryRow(e, meta, [
      openBtn(e),
      ...(e.kind === 'exported'
        ? [mkBtn('Folder', 'btn-ghost', () => { if (e.outDir) void pickerRpc?.request.openFolder({ path: e.outDir }).catch(() => {}); })]
        : [copyBtn(e)]),
      mkBtn('Bookmark', 'btn-ghost', () => {
        const { src, format, cache, lon, lat, alt, heading, name } = e;
        lib.bookmarks.push({ id: newId(), name, addedAt: Date.now(), src, format, cache, lon, lat, alt, heading });
        persist();
      }),
      mkBtn('Remove', 'btn-ghost', () => { lib.history = lib.history.filter((x) => x.id !== e.id); persist(); }),
    ]));
  }
}

$('hist-clear').addEventListener('click', () => { lib.history = []; persist(); });

function mkBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `btn btn-sm ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function loadIntoBuilder(e: { src: string; format: string; cache: string; lon?: string; lat?: string; alt?: string; heading?: string }) {
  srcEl.value = e.src;
  formatEl.value = e.format ?? '';
  cacheEl.value = e.cache ?? 'none';
  for (const k of placement) $<HTMLInputElement>(k).value = (e as Record<string, string | undefined>)[k] ?? '';
  refresh();
}

const kindOf = (fmt: string) => CATALOG.find((g) => g.format === fmt)?.kind ?? 'mesh';
const iconOf = (fmt: string) => CATALOG.find((g) => g.format === fmt)?.icon ?? '◱';

/**
 * Walk every saved tileset through /stats and cache the shape. Sequential on purpose — this fans out
 * to arbitrary third-party hosts, and a library of 30 entries firing at once is exactly the
 * unbounded-concurrency pattern that loses requests (the same lesson /aggregate's child fetches
 * learned the hard way).
 */
$('lib-refresh').addEventListener('click', async () => {
  if (!base || !lib.bookmarks.length) return;
  const btn = $<HTMLButtonElement>('lib-refresh');
  btn.disabled = true;
  for (const e of lib.bookmarks) {
    btn.textContent = `Checking ${e.name}…`;
    try {
      const u = `${base}/stats/tileset.json?url=${encodeURIComponent(buildUrlFrom(e))}&maxNodes=2000`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      e.stats = { tiles: s.totalNodes, depth: s.maxDepth, leaves: s.leafNodes, truncated: !!s.truncated, checkedAt: Date.now() };
    } catch {
      e.stats = undefined;                       // a failed check must clear a stale one, not keep it
    }
    persist();
  }
  btn.disabled = false;
  btn.textContent = 'Refresh stats';
});

$('lib-export').addEventListener('click', () => {
  const io = $<HTMLTextAreaElement>('lib-io');
  io.style.display = 'block';
  io.value = serialize(lib);
  io.select();
});

$('lib-import').addEventListener('click', () => {
  const io = $<HTMLTextAreaElement>('lib-io');
  if (io.style.display !== 'block') { io.style.display = 'block'; io.value = ''; io.focus(); return; }
  try {
    lib = parseLibrary(io.value, lib);
    persist();
    io.style.display = 'none';
    say(`Imported ${lib.bookmarks.length} bookmarks and ${lib.history.length} history entries.`, 'ok');
  } catch (e) { say(`Import failed: ${(e as Error).message}`, 'err'); }
});

// ── samples ─────────────────────────────────────────────────────────────────────────────────────
function renderSamples() {
  const host = $('sample-list');
  host.textContent = '';
  for (const group of CATALOG) {
    const g = document.createElement('div');
    g.className = 'group';
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = `${group.icon}  ${group.label}`;
    const kind = document.createElement('span');
    kind.className = 'chip';
    kind.textContent = group.kind;
    h.appendChild(kind);
    g.appendChild(h);

    for (const s of group.samples) {
      const row = document.createElement('div');
      row.className = 'item item-compact';
      const body = document.createElement('div');
      body.className = 'item-body';
      const t = document.createElement('div');
      t.className = 'item-title';
      t.textContent = s.label;
      const o = document.createElement('span');
      o.className = 'chip';
      o.textContent = s.origin;
      t.appendChild(o);
      const sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = s.src;
      sub.title = s.src;
      body.append(t, sub);

      const acts = document.createElement('div');
      acts.className = 'item-actions';
      acts.append(
        mkBtn('Load', 'btn-ghost', () => { useSample(s); showTab('build'); }),
        mkBtn('Save', 'btn-ghost', () => {
          lib.bookmarks.push({ id: newId(), name: s.label, src: s.src, format: s.format, cache: 'none', addedAt: Date.now() });
          persist();
        }),
      );
      row.append(body, acts);
      g.appendChild(row);
    }
    host.appendChild(g);
  }
}

function useSample(s: Sample) {
  loadIntoBuilder({ src: s.src, format: s.format, cache: 'none' });
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────
refresh();
(async () => {
  const statusEl = $('status');
  const portsEl = $('ports');
  portsEl.textContent = `tile-server :${tilePort ?? '—'} · preview :${staticPort ?? '—'}`;

  const setLink = (id: string, href: string, label?: string) => {
    const a = $<HTMLAnchorElement>(id);
    if (!href) { a.style.display = 'none'; return; }
    a.href = href;
    if (label) a.textContent = label;
  };
  setLink('link-viewer', viewerUrl);
  setLink('link-explorer', viewerUrl ? `${viewerUrl}/hierarchy` : (base ? `${base}/hierarchy` : ''));
  setLink('link-docs', docsUrl);
  setLink('link-plugins', LINKS.cesiumUnreal);
  setLink('link-repo', LINKS.repo);

  // Outside the Electrobun host (e.g. the bundle rendered in a plain browser for verification) the
  // native dialog cannot exist — hide the buttons rather than offering an action that always fails.
  if (!pickerAvailable()) for (const id of ['browse-file', 'browse-dir']) $(id).style.display = 'none';

  // The file wins; a first run with this version starts it from what localStorage holds.
  if (pickerAvailable()) {
    const stored = await pickerRpc!.request.readLibrary({}).catch(() => null);
    try {
      if (stored) { lib = parseLibrary(stored); saveLocal(lib); }
      else if (lib.bookmarks.length) persist();
    } catch { /* a corrupt file: keep what localStorage has */ }
  }
  renderLibrary();
  renderSamples();

  if (!tilePort) {
    statusEl.textContent = 'tile-server failed to start';
    statusEl.className = 'status status-err';
    return;
  }
  statusEl.textContent = `tile-server ready on :${tilePort}`;
  statusEl.className = 'status status-ok';
  requestAnimationFrame(fitWindowToContent);
})();

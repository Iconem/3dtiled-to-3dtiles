/**
 * Launcher view — builds a tileset URL, exercises it against the locally-spawned tile-server, and
 * keeps a small library of datasets you care about.
 *
 * Three tabs, one job each:
 *   Build    — dataset + format + materialization + optional globe placement → paste-ready URL.
 *   Library  — datasets you've saved, with a cached structural check (tiles/depth/leaves from /stats).
 *   Samples  — a real dataset for every format the middleware reads, one click into Build.
 *
 * The ports and the docs/viewer URLs arrive in the query string (see src/bun/index.ts): the main
 * process may adopt an already-running server rather than starting one, and it resolves whether a
 * local viewer/docs is up — neither is knowable at build time.
 */
import { Electroview } from 'electrobun/view';
import { CATALOG, LINKS, type Sample } from './catalog';
import { loadLibrary, saveLibrary, newId, serialize, replaceAll, type LibraryEntry } from './library';
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
}

function say(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  resultEl.textContent = msg;
  resultEl.className = `result result-${kind}`;
}

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
  const el = document.querySelector<HTMLElement>('.container');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const cssWidth = Math.ceil(rect.right + 24);    // content's right edge + breathing room
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

$('preview').addEventListener('click', () => {
  const u = buildUrl();
  if (!u) return say('Enter a dataset path or URL first.', 'err');
  const p = previewUrl(u);
  // The harness is stock CesiumJS with zero viewer-side fix-ups, so whatever it shows is what any
  // 3D Tiles client gets from the tileset alone.
  if (!p) return say('Preview unavailable — the static server for cesium-harness.html did not start.', 'err');
  location.href = p;
});

$('playground').addEventListener('click', () => { if (base) location.href = `${base}/playground`; });
$('hierarchy').addEventListener('click', () => {
  const u = buildUrl();
  if (!base) return;
  // Prefer the viewer app's multi-tileset explorer when one is reachable; the server's own page is
  // the always-available single-tileset fallback.
  const target = viewerUrl ? `${viewerUrl}/hierarchy` : `${base}/hierarchy`;
  location.href = u ? `${target}?url=${encodeURIComponent(u)}` : target;
});

$('save').addEventListener('click', () => {
  const f = currentForm();
  if (!f.src) return say('Enter a dataset path or URL first.', 'err');
  library.push({ id: newId(), name: nameFor(f.src), addedAt: Date.now(), ...f });
  persist();
  say('Saved to library.', 'ok');
  showTab('library');
});

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
let library: LibraryEntry[] = loadLibrary();

function persist() {
  saveLibrary(library);
  renderLibrary();
}

function renderLibrary() {
  $('lib-count').textContent = String(library.length);
  const host = $('lib-list');
  host.textContent = '';
  if (!library.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nothing saved yet — build a URL and press “Save to library”, or start from Samples.';
    host.appendChild(p);
    return;
  }
  for (const e of library) {
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
    const meta = document.createElement('div');
    meta.className = 'item-meta';
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
    body.append(title, sub, meta);

    const acts = document.createElement('div');
    acts.className = 'item-actions';
    acts.append(
      mkBtn('Open', 'btn-ghost', () => { loadIntoBuilder(e); showTab('build'); }),
      mkBtn('Copy', 'btn-ghost', async () => {
        try { await navigator.clipboard.writeText(buildUrlFrom(e)); say('Copied.', 'ok'); } catch { /* ignore */ }
      }),
      mkBtn('Preview', 'btn-ghost', () => {
        const p = previewUrl(buildUrlFrom(e));
        if (p) location.href = p;
      }),
      mkBtn('Remove', 'btn-ghost', () => { library = library.filter((x) => x.id !== e.id); persist(); }),
    );

    row.append(glyph, body, acts);
    host.appendChild(row);
  }
}

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
  if (!base || !library.length) return;
  const btn = $<HTMLButtonElement>('lib-refresh');
  btn.disabled = true;
  for (const e of library) {
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
  io.value = serialize(library);
  io.select();
});

$('lib-import').addEventListener('click', () => {
  const io = $<HTMLTextAreaElement>('lib-io');
  if (io.style.display !== 'block') { io.style.display = 'block'; io.value = ''; io.focus(); return; }
  try {
    library = replaceAll(io.value);
    persist();
    io.style.display = 'none';
    say(`Imported ${library.length} entries.`, 'ok');
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
          library.push({ id: newId(), name: s.label, src: s.src, format: s.format, cache: 'none', addedAt: Date.now() });
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

  renderLibrary();
  renderSamples();

  if (!tilePort) {
    statusEl.textContent = 'tile-server failed to start';
    statusEl.className = 'status status-err';
    return;
  }
  statusEl.textContent = `tile-server ready on :${tilePort}`;
  statusEl.className = 'status status-ok';
  refresh();
  requestAnimationFrame(fitWindowToContent);
})();

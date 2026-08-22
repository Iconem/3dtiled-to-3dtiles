/**
 * stats-live.js — tileset **hierarchy statistics + visualization**:
 *
 *   GET /stats/tileset.json?url=<any tileset.json URL>[&maxNodes=4000][&maxDepth=32]
 *       → walks the tileset's tile tree — explicit children, 3D Tiles 1.1 implicit tiling
 *         (fetching + decoding .subtree availability), and external-tileset content refs —
 *         and returns per-level aggregates + a bounded node dump for the graph view.
 *
 *   GET /hierarchy[?url=…]
 *       → self-contained HTML page (no build step, vanilla-viewer style) rendering the stats as a
 *         cosmograph-style radial depth/breadth graph + per-level breadth chart + table.
 *
 * Works against ANY 3D Tiles URL — this server's own /stream, /convert, /bing, /aggregate output or a
 * remote tileset — so it doubles as a diagnostic for the live adapters (a truncated octree shows up
 * immediately as a ring that stops early; see the Potree 1.x .hrc boundary-cache fix).
 */
import { parseSubtreeBuffer, morton2Decode, morton3Decode } from '../core/index.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

// enclosing-sphere radius of a boundingVolume, for node sizing (parent-frame accuracy not needed here)
function radiusOfVolume(bv) {
  if (!bv) return 0;
  if (bv.sphere) return bv.sphere[3];
  if (bv.box) {
    const b = bv.box, ax = b.slice(3, 6), ay = b.slice(6, 9), az = b.slice(9, 12);
    return Math.hypot(ax[0]+ay[0]+az[0], ax[1]+ay[1]+az[1], ax[2]+ay[2]+az[2]);
  }
  if (bv.region) {
    const [w, s, e, n, h0, h1] = bv.region;
    return Math.max(1, 6378137 * Math.max(Math.abs(e - w), Math.abs(n - s)) / 2 + (h1 - h0) / 2);
  }
  return 0;
}

const resolveUri = (uri, base) => new URL(uri, base).href;
const isTilesetUri = (uri) => /\.json(\?|$)/i.test(uri.split('#')[0]);

/** Walk a tileset (explicit + implicit + external refs), collecting bounded node/level stats. */
export async function collectStats(tsUrl, { maxNodes = 4000, maxDepth = 32, maxExternal = 64 } = {}) {
  const nodes = [];                 // {i, p, l, ge, r, c}
  let truncated = false, externals = 0, subtreesFetched = 0;
  const full = () => nodes.length >= maxNodes;

  const addNode = (parent, level, ge, r, hasContent) => {
    const i = nodes.length;
    nodes.push({ i, p: parent, l: level, ge: +Number(ge ?? 0).toPrecision(4), r: +Number(r ?? 0).toPrecision(4), c: hasContent ? 1 : 0 });
    return i;
  };

  async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`); return r.json(); }
  async function fetchBuf(url) { const r = await fetch(url); if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`); return Buffer.from(await r.arrayBuffer()); }

  // Implicit-tiling walk rooted at `tile` (which carries implicitTiling); its cell (0,0,0,0) REPLACES
  // the tile. GE/radius halve per level (octree/quadtree subdivision).
  async function walkImplicit(tile, baseUrl, parentIdx, baseDepth) {
    const it = tile.implicitTiling;
    const quad = it.subdivisionScheme === 'QUADTREE';
    const sl = it.subtreeLevels || 3;
    const stTemplate = it.subtrees?.uri, ctTemplate = tile.content?.uri;
    if (!stTemplate) return;
    const rootGE = tile.geometricError ?? 0, rootR = radiusOfVolume(tile.boundingVolume);
    const decode = quad ? (m) => ({ ...morton2Decode(m), z: 0 }) : morton3Decode;
    const cellsAt = (d) => quad ? 4 ** d : 8 ** d;
    let frontier = [{ level: 0, x: 0, y: 0, z: 0, parentIdx }];
    while (frontier.length && !full()) {
      const next = [];
      for (const st of frontier) {
        if (full() || baseDepth + st.level > maxDepth) { truncated = true; continue; }
        let sub;
        try {
          const u = stTemplate.replace('{level}', st.level).replace('{x}', st.x).replace('{y}', st.y).replace('{z}', st.z);
          sub = parseSubtreeBuffer(await fetchBuf(resolveUri(u, baseUrl)));
          subtreesFetched++;
        } catch { continue; }
        // internal levels: level-major, morton-within-level bit order; parents linked via cell>>1
        const idxByCell = new Map();      // "d-x-y-z" (d relative to subtree root) → node idx
        let bit = 0;
        for (let d = 0; d < sl; d++) {
          const total = cellsAt(d);
          for (let m = 0; m < total; m++, bit++) {
            if (!sub.tileBit(bit)) continue;
            const { x: dx, y: dy, z: dz } = decode(m);
            const level = st.level + d;
            if (baseDepth + level > maxDepth) { truncated = true; continue; }
            const parent = d === 0 ? st.parentIdx : (idxByCell.get(`${d-1}-${dx>>1}-${dy>>1}-${dz>>1}`) ?? st.parentIdx);
            if (full()) { truncated = true; break; }
            const i = addNode(parent, baseDepth + level, rootGE / 2 ** level, rootR / 2 ** level, sub.contentBit(bit));
            idxByCell.set(`${d}-${dx}-${dy}-${dz}`, i);
          }
          if (full()) break;
        }
        const childCells = cellsAt(sl);
        for (let m = 0; m < childCells && !full(); m++) {
          if (!sub.childBit(m)) continue;
          const { x: dx, y: dy, z: dz } = decode(m);
          const parent = idxByCell.get(`${sl-1}-${dx>>1}-${dy>>1}-${dz>>1}`) ?? st.parentIdx;
          next.push({ level: st.level + sl, x: st.x * 2 ** sl + dx, y: st.y * 2 ** sl + dy, z: st.z * 2 ** sl + dz, parentIdx: parent });
        }
      }
      frontier = next;
    }
    if (frontier.length) truncated = true;
  }

  async function walkTile(tile, baseUrl, parentIdx, depth) {
    if (full() || depth > maxDepth) { truncated = true; return; }
    if (tile.implicitTiling) { await walkImplicit(tile, baseUrl, parentIdx, depth); return; }
    const uri = tile.content?.uri ?? tile.content?.url;
    const isExternal = uri && isTilesetUri(uri);
    const i = addNode(parentIdx, depth, tile.geometricError, radiusOfVolume(tile.boundingVolume), !!uri && !isExternal);
    if (isExternal && externals < maxExternal) {
      externals++;
      try {
        const extUrl = resolveUri(uri, baseUrl);
        const ext = await fetchJson(extUrl);
        if (ext.root) await walkTile(ext.root, extUrl, i, depth + 1);
      } catch { /* unreachable external ref — keep going */ }
    } else if (isExternal) truncated = true;
    for (const ch of tile.children || []) {
      if (full()) { truncated = true; break; }
      await walkTile(ch, baseUrl, i, depth + 1);
    }
  }

  const ts = await fetchJson(tsUrl);
  if (!ts.root) throw new Error('no root tile in tileset');
  await walkTile(ts.root, tsUrl, -1, 0);

  // per-level aggregates
  const byLevel = new Map();
  for (const n of nodes) {
    let L = byLevel.get(n.l);
    if (!L) byLevel.set(n.l, L = { level: n.l, tiles: 0, content: 0, geMin: Infinity, geMax: -Infinity });
    L.tiles++; L.content += n.c;
    if (n.ge < L.geMin) L.geMin = n.ge;
    if (n.ge > L.geMax) L.geMax = n.ge;
  }
  const levels = [...byLevel.values()].sort((a, b) => a.level - b.level)
    .map(L => ({ ...L, geMin: L.geMin === Infinity ? 0 : L.geMin, geMax: L.geMax === -Infinity ? 0 : L.geMax }));

  return {
    url: tsUrl, tilesetGeometricError: ts.geometricError ?? null,
    totalNodes: nodes.length, contentNodes: nodes.reduce((a, n) => a + n.c, 0),
    maxDepth: nodes.reduce((a, n) => Math.max(a, n.l), 0),
    truncated, subtreesFetched, externalTilesets: externals,
    levels, nodes,
  };
}

/** Try to handle a /stats/* or /hierarchy request. Returns true iff it owned the response. */
export async function handleStats(req, res, u) {
  if (u.pathname === '/stats/tileset.json') {
    const url = u.searchParams.get('url');
    if (!url) { res.writeHead(400, CORS); res.end('missing ?url=<tileset.json URL>'); return true; }
    const maxNodes = Math.min(20000, Number(u.searchParams.get('maxNodes')) || 4000);
    const maxDepth = Math.min(48, Number(u.searchParams.get('maxDepth')) || 32);
    const stats = await collectStats(url, { maxNodes, maxDepth });
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(stats));
    return true;
  }
  if (u.pathname === '/hierarchy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
    res.end(HIERARCHY_HTML);
    return true;
  }
  return false;
}

// ── /hierarchy — self-contained page (kept dependency-free, vanilla-viewer style) ────────────────
const HIERARCHY_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tileset hierarchy — depth / breadth</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1:#fcfcfb; --page:#f9f9f7;
    --ink-1:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --ring:rgba(11,11,11,0.10);
    --accent:#2a78d6;
    /* ordinal depth ramp — 5 steps, validated (monotone L, visible gaps, light end ≥2:1 on light) */
    --ramp:#86b6ef,#5598e7,#2a78d6,#1c5cab,#0d366b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1:#1a1a19; --page:#0d0d0d;
      --ink-1:#ffffff; --ink-2:#c3c2b7; --ink-3:#898781;
      --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
      --accent:#3987e5;
      /* dark ordinal ramp — 5 steps, validated (darkest step ≥2:1 on the dark surface) */
      --ramp:#cde2fb,#86b6ef,#5598e7,#2a78d6,#184f95;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1:#1a1a19; --page:#0d0d0d;
    --ink-1:#ffffff; --ink-2:#c3c2b7; --ink-3:#898781;
    --grid:#2c2c2a; --axis:#383835; --ring:rgba(255,255,255,0.10);
    --accent:#3987e5;
    --ramp:#cde2fb,#86b6ef,#5598e7,#2a78d6,#184f95;
  }
  * { box-sizing: border-box; margin: 0; }
  body.viz-root { background: var(--page); color: var(--ink-1);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 20px; }
  h1 { font-size: 17px; font-weight: 600; margin-bottom: 2px; }
  .sub { color: var(--ink-2); font-size: 12.5px; margin-bottom: 14px; overflow-wrap: anywhere; }
  .filters { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .filters input[type=text] { flex: 1 1 420px; padding: 7px 10px; border: 1px solid var(--axis);
    border-radius: 7px; background: var(--surface-1); color: var(--ink-1); font: inherit; }
  .filters select, .filters button { padding: 7px 10px; border: 1px solid var(--axis); border-radius: 7px;
    background: var(--surface-1); color: var(--ink-1); font: inherit; cursor: pointer; }
  .filters button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .tile { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 10px 12px; }
  .tile .lbl { color: var(--ink-2); font-size: 12px; }
  .tile .val { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .tile .note { color: var(--ink-3); font-size: 11.5px; margin-top: 1px; }
  .grid2 { display: grid; grid-template-columns: minmax(380px, 3fr) minmax(300px, 2fr); gap: 14px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 14px; min-width: 0; }
  .card h2 { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .card .hint { color: var(--ink-3); font-size: 11.5px; margin-bottom: 10px; }
  canvas { width: 100%; display: block; }
  #tree-wrap { position: relative; }
  #bars-wrap { position: relative; }
  .tooltip { position: absolute; pointer-events: none; background: var(--surface-1); color: var(--ink-1);
    border: 1px solid var(--ring); border-radius: 8px; padding: 7px 10px; font-size: 12.5px;
    box-shadow: 0 4px 14px rgba(0,0,0,.18); display: none; z-index: 5; max-width: 260px; }
  .tooltip .v { font-weight: 600; font-size: 13.5px; }
  .tooltip .k { color: var(--ink-2); }
  .tooltip .key { display: inline-block; width: 10px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-top: 8px; }
  th { text-align: right; color: var(--ink-2); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--grid); }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--grid);
    font-variant-numeric: tabular-nums; color: var(--ink-1); }
  .status { color: var(--ink-3); font-size: 12.5px; margin: 30px 0; }
</style></head>
<body class="viz-root">
<h1>Tileset hierarchy — depth &amp; breadth</h1>
<div class="sub" id="sub">Point it at any tileset.json (this server’s /stream, /convert, /aggregate output or a remote URL). Node color steps with depth; dots mark tiles with content.</div>

<div class="filters">
  <input type="text" id="url" placeholder="tileset.json URL — e.g. /stream/tileset.json?url=…&amp;format=potree" />
  <select id="maxNodes" title="node budget">
    <option value="2000">2 000 nodes</option>
    <option value="4000" selected>4 000 nodes</option>
    <option value="10000">10 000 nodes</option>
  </select>
  <button class="primary" id="load">Load</button>
</div>

<div id="status" class="status">No tileset loaded yet — paste a URL above.</div>

<div id="content" style="display:none">
  <div class="kpis">
    <div class="tile"><div class="lbl">Tiles walked</div><div class="val" id="k-total"></div><div class="note" id="k-trunc"></div></div>
    <div class="tile"><div class="lbl">Tiles with content</div><div class="val" id="k-content"></div></div>
    <div class="tile"><div class="lbl">Max depth</div><div class="val" id="k-depth"></div></div>
    <div class="tile"><div class="lbl">Root geometric error</div><div class="val" id="k-ge"></div><div class="note">meters</div></div>
  </div>
  <div class="grid2">
    <div class="card" id="tree-wrap">
      <h2>Radial tree</h2>
      <div class="hint">Rings = depth levels · dot = tile (filled when it has content) · hover for details</div>
      <canvas id="tree"></canvas>
      <div class="tooltip" id="tt-tree"></div>
    </div>
    <div>
      <div class="card" id="bars-wrap" style="margin-bottom:14px">
        <h2>Breadth per level</h2>
        <div class="hint">Tiles at each depth level</div>
        <canvas id="bars" height="220"></canvas>
        <div class="tooltip" id="tt-bars"></div>
      </div>
      <div class="card">
        <h2>Per-level table</h2>
        <table id="tbl"><thead><tr><th>Level</th><th>Tiles</th><th>With content</th><th>GE min–max (m)</th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
</div>

<script>
'use strict';
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const RAMP = () => css('--ramp').split(',').map(s => s.trim());
const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e4 ? (n/1e3).toFixed(1)+'K' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const fmtGe = (n) => n >= 100 ? Math.round(n).toLocaleString('en') : n >= 1 ? n.toFixed(1) : n.toPrecision(2);

let STATS = null, LAYOUT = null;

async function load(url) {
  $('status').style.display = ''; $('content').style.display = 'none';
  $('status').textContent = 'Walking hierarchy… (fetching subtrees / external refs)';
  try {
    const r = await fetch('/stats/tileset.json?url=' + encodeURIComponent(url) + '&maxNodes=' + $('maxNodes').value);
    if (!r.ok) throw new Error(await r.text());
    STATS = await r.json();
  } catch (e) { $('status').textContent = 'Failed: ' + e.message; return; }
  $('status').style.display = 'none'; $('content').style.display = '';
  $('sub').textContent = STATS.url;
  $('k-total').textContent = fmt(STATS.totalNodes);
  $('k-trunc').textContent = STATS.truncated ? 'truncated at budget — raise the node cap' : (STATS.subtreesFetched ? STATS.subtreesFetched + ' subtrees read' : 'full walk');
  $('k-content').textContent = fmt(STATS.contentNodes);
  $('k-depth').textContent = STATS.maxDepth;
  $('k-ge').textContent = STATS.tilesetGeometricError == null ? '—' : fmtGe(STATS.tilesetGeometricError);
  buildTable(); layoutTree(); drawTree(); drawBars();
  history.replaceState(null, '', '/hierarchy?url=' + encodeURIComponent(url));
}

function buildTable() {
  const tb = $('tbl').querySelector('tbody'); tb.textContent = '';
  for (const L of STATS.levels) {
    const tr = document.createElement('tr');
    for (const v of [L.level, fmt(L.tiles), fmt(L.content), fmtGe(L.geMin) + ' – ' + fmtGe(L.geMax)]) {
      const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
}

// ── radial tidy layout: angular span ∝ leaf count ──
function layoutTree() {
  const N = STATS.nodes, kids = new Map();
  for (const n of N) { if (n.p >= 0) { (kids.get(n.p) || kids.set(n.p, []).get(n.p)).push(n.i); } }
  const leaves = new Float64Array(N.length);
  for (let i = N.length - 1; i >= 0; i--) {           // children always come after parents (BFS/DFS order)
    const ch = kids.get(i);
    leaves[i] = ch ? ch.reduce((a, c) => a + leaves[c], 0) : 1;
  }
  const angle = new Float64Array(N.length);
  const roots = N.filter(n => n.p < 0).map(n => n.i);
  const totalLeaves = roots.reduce((a, r) => a + leaves[r], 0) || 1;
  const assign = (i, a0, a1) => {
    angle[i] = (a0 + a1) / 2;
    const ch = kids.get(i); if (!ch) return;
    let a = a0;
    for (const c of ch) { const w = (a1 - a0) * leaves[c] / leaves[i]; assign(c, a, a + w); a += w; }
  };
  let a = -Math.PI / 2;
  for (const r of roots) { const w = 2 * Math.PI * leaves[r] / totalLeaves; assign(r, a, a + w); a += w; }
  LAYOUT = { angle, kids };
}

function drawTree() {
  const canvas = $('tree'), wrap = $('tree-wrap');
  const W = wrap.clientWidth - 28, H = Math.max(420, Math.min(640, W)), dpr = devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const cx = W / 2, cy = H / 2, maxL = Math.max(1, STATS.maxDepth);
  const R = Math.min(W, H) / 2 - 18, ring = R / maxL;
  const ramp = RAMP(), colorOf = (l) => ramp[Math.min(ramp.length - 1, Math.round(l / maxL * (ramp.length - 1)))];
  const pos = (n) => { const r = n.l * ring, t = LAYOUT.angle[n.i]; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  ctx.clearRect(0, 0, W, H);
  // depth rings (hairline, recessive)
  ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
  for (let l = 1; l <= maxL; l++) { ctx.beginPath(); ctx.arc(cx, cy, l * ring, 0, 7); ctx.stroke(); }
  // edges
  ctx.strokeStyle = css('--axis'); ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const n of STATS.nodes) {
    if (n.p < 0) continue;
    const [x1, y1] = pos(STATS.nodes[n.p]), [x2, y2] = pos(n);
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
  // nodes — dot size by content; surface ring keeps overlaps legible
  const pts = [];
  for (const n of STATS.nodes) {
    const [x, y] = pos(n); pts.push(x, y);
    const rad = n.c ? 3 : 1.8;
    ctx.beginPath(); ctx.arc(x, y, rad + 1, 0, 7); ctx.fillStyle = css('--surface-1'); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fillStyle = colorOf(n.l); ctx.fill();
  }
  LAYOUT.pts = pts; LAYOUT.geom = { cx, cy, ring, W, H };
  // hover: nearest node within 24px (dense-scatter rule)
  const tt = $('tt-tree');
  canvas.onpointermove = (ev) => {
    const b = canvas.getBoundingClientRect(), mx = ev.clientX - b.left, my = ev.clientY - b.top;
    let best = -1, bd = 24 * 24;
    for (let i = 0; i < STATS.nodes.length; i++) {
      const dx = pts[i*2] - mx, dy = pts[i*2+1] - my, d = dx*dx + dy*dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) { tt.style.display = 'none'; canvas.onpointerleave?.(); return; }
    const n = STATS.nodes[best];
    tt.textContent = '';
    const v = document.createElement('div'); v.className = 'v';
    v.textContent = 'Level ' + n.l + (n.c ? ' · has content' : ' · structural');
    const k1 = document.createElement('div'); k1.className = 'k'; k1.textContent = 'geometric error ' + fmtGe(n.ge) + ' m';
    const k2 = document.createElement('div'); k2.className = 'k'; k2.textContent = 'bounding radius ' + fmtGe(n.r) + ' m';
    tt.append(v, k1, k2);
    tt.style.display = 'block';
    tt.style.left = Math.min(mx + 14, LAYOUT.geom.W - 200) + 'px'; tt.style.top = (my + 40) + 'px';
  };
  canvas.onpointerleave = () => { tt.style.display = 'none'; };
}

function drawBars() {
  const canvas = $('bars'), wrap = $('bars-wrap');
  const W = wrap.clientWidth - 28, H = 220, dpr = devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const L = STATS.levels, maxV = Math.max(...L.map(l => l.tiles), 1);
  const padL = 8, padR = 8, padB = 22, padT = 16;
  const iw = W - padL - padR, ih = H - padT - padB;
  const slot = iw / L.length, bw = Math.min(24, Math.max(3, slot - 2));   // ≤24px thick, 2px surface gap
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = css('--axis'); ctx.lineWidth = 1;                      // baseline
  ctx.beginPath(); ctx.moveTo(padL, padT + ih + .5); ctx.lineTo(W - padR, padT + ih + .5); ctx.stroke();
  const accent = css('--accent');
  const rects = [];
  for (let i = 0; i < L.length; i++) {
    const h = Math.max(1, L[i].tiles / maxV * ih);
    const x = padL + i * slot + (slot - bw) / 2, y = padT + ih - h;
    rects.push([x, y, bw, h]);
    ctx.fillStyle = accent;
    ctx.beginPath();                                                       // 4px rounded data-end, square baseline
    const r = Math.min(4, bw / 2, h);
    ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + bw - r, y); ctx.arcTo(x + bw, y, x + bw, y + r, r); ctx.lineTo(x + bw, y + h); ctx.closePath();
    ctx.fill();
  }
  // selective direct labels: peak + deepest level only; ticks under each Nth level
  ctx.fillStyle = css('--ink-2'); ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
  const peak = L.reduce((a, l, i) => l.tiles > L[a].tiles ? i : a, 0);
  for (const i of new Set([peak, L.length - 1])) {
    const [x, y, w] = rects[i];
    ctx.fillText(fmt(L[i].tiles), x + w / 2, y - 4);
  }
  ctx.fillStyle = css('--ink-3');
  const step = Math.ceil(L.length / Math.max(3, Math.floor(iw / 40)));
  for (let i = 0; i < L.length; i += step) {
    const [x, , w] = rects[i];
    ctx.fillText(String(L[i].level), x + w / 2, H - 7);
  }
  const tt = $('tt-bars');
  canvas.onpointermove = (ev) => {
    const b = canvas.getBoundingClientRect(), mx = ev.clientX - b.left;
    const i = Math.max(0, Math.min(L.length - 1, Math.floor((mx - padL) / slot)));
    if (mx < padL || mx > W - padR) { tt.style.display = 'none'; return; }
    tt.textContent = '';
    const v = document.createElement('div'); v.className = 'v'; v.textContent = fmt(L[i].tiles) + ' tiles';
    const k = document.createElement('div'); k.className = 'k';
    const key = document.createElement('span'); key.className = 'key'; key.style.background = accent;
    k.append(key, document.createTextNode('level ' + L[i].level + ' · ' + fmt(L[i].content) + ' with content'));
    tt.append(v, k);
    tt.style.display = 'block';
    tt.style.left = Math.min(mx + 12, W - 190) + 'px'; tt.style.top = '46px';
  };
  canvas.onpointerleave = () => { tt.style.display = 'none'; };
}

addEventListener('resize', () => { if (STATS) { drawTree(); drawBars(); } });
$('load').onclick = () => { const v = $('url').value.trim(); if (v) load(v); };
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('load').onclick(); });
const q = new URLSearchParams(location.search);
const theme = q.get('theme');                       // ?theme=dark|light overrides the OS scheme
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
const init = q.get('url');
if (init) { $('url').value = init; load(init); }
</script>
</body></html>`;

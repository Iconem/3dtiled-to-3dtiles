/**
 * Launcher view — builds the tileset URL and exercises it against the locally-spawned tile-server.
 *
 * The ports arrive in the query string (see src/bun/index.ts): the main process may adopt an
 * already-running server rather than starting one, so the port is not knowable at build time.
 */
const params = new URLSearchParams(location.search);
const tilePort = params.get("tilePort");
const staticPort = params.get("staticPort");
const base = tilePort ? `http://127.0.0.1:${tilePort}` : "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const srcEl = $<HTMLInputElement>("src");
const formatEl = $<HTMLSelectElement>("format");
const cacheEl = $<HTMLSelectElement>("cache");
const urlEl = $<HTMLElement>("url");
const resultEl = $<HTMLElement>("result");

const placement = ["lon", "lat", "alt", "heading"] as const;

/**
 * `/tiles` is the front door: it dispatches to /stream for cache=none|hierarchy and /convert for
 * cache=full, so the UI does not have to encode that routing rule a second time.
 */
function buildUrl(): string {
  const src = srcEl.value.trim();
  if (!base || !src) return "";
  const q = new URLSearchParams();
  q.set("url", src);
  if (formatEl.value) q.set("format", formatEl.value);
  q.set("cache", cacheEl.value);
  for (const k of placement) {
    const v = $<HTMLInputElement>(k).value.trim();
    if (v !== "") q.set(k, v);
  }
  return `${base}/tiles/tileset.json?${q.toString()}`;
}

function refresh() {
  const u = buildUrl();
  urlEl.textContent = u || "—";
  urlEl.classList.toggle("empty", !u);
}

function say(msg: string, kind: "ok" | "err" | "info" = "info") {
  resultEl.textContent = msg;
  resultEl.className = `result result-${kind}`;
}

for (const el of [srcEl, formatEl, cacheEl, ...placement.map((k) => $<HTMLInputElement>(k))]) {
  el.addEventListener("input", refresh);
  el.addEventListener("change", refresh);
}

$("copy").addEventListener("click", async () => {
  const u = buildUrl();
  if (!u) return say("Enter a dataset path or URL first.", "err");
  try { await navigator.clipboard.writeText(u); say("Copied — paste it into Cesium for Unreal/Unity, QGIS or CesiumJS.", "ok"); }
  catch { say(u, "info"); }
});

$("check").addEventListener("click", async () => {
  const u = buildUrl();
  if (!u) return say("Enter a dataset path or URL first.", "err");
  say("requesting…");
  try {
    const t0 = performance.now();
    const r = await fetch(u);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return say(`HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`, "err");
    const j = await r.json();
    const root = j.root ?? {};
    const bv = root.boundingVolume ?? {};
    const kind = bv.region ? "region" : bv.box ? "box" : bv.sphere ? "sphere" : "none";
    say(`OK in ${ms} ms — asset ${j.asset?.version ?? "?"}, geometricError ${Math.round(root.geometricError ?? 0)}, `
      + `boundingVolume ${kind}, ${root.children?.length ?? 0} root children`
      + (root.transform ? ", placed via root transform" : ""), "ok");
  } catch (e) { say(`Request failed: ${e}`, "err"); }
});

$("preview").addEventListener("click", () => {
  const u = buildUrl();
  if (!u) return say("Enter a dataset path or URL first.", "err");
  if (!staticPort) return say("Preview unavailable — the static server for cesium-harness.html did not start.", "err");
  // The harness is stock CesiumJS with zero viewer-side fix-ups, so whatever it shows is what any
  // 3D Tiles client gets from the tileset alone.
  location.href = `http://127.0.0.1:${staticPort}/cesium-harness.html?url=${encodeURIComponent(u)}`;
});

$("playground").addEventListener("click", () => { if (base) location.href = `${base}/playground`; });
$("hierarchy").addEventListener("click", () => {
  const u = buildUrl();
  if (!base) return;
  location.href = u ? `${base}/hierarchy?url=${encodeURIComponent(u)}` : `${base}/hierarchy`;
});

(async () => {
  const statusEl = $("status");
  const portsEl = $("ports");
  portsEl.textContent = `tile-server :${tilePort ?? "—"} · preview :${staticPort ?? "—"}`;
  if (!tilePort) {
    statusEl.textContent = "tile-server failed to start";
    statusEl.className = "status status-err";
    return;
  }
  statusEl.textContent = `tile-server ready on :${tilePort}`;
  statusEl.className = "status status-ok";
  refresh();
})();

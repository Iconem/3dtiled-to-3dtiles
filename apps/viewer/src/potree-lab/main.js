/**
 * Potree lab — test point-cloud datasets one at a time, with the point-rendering controls that
 * 3DTilesRendererJS added in #1742 (merged 2026-09-10, not in any npm release yet; see ./vendor).
 *
 * Two ways to load the same Potree dataset, switchable, so they can be compared directly:
 *
 *   potree   PotreePlugin reads cloud.js in the browser. Points get ADAPTIVE size: each point is sized
 *            by the deepest active octree node containing it, resolved in the vertex shader from a
 *            texture of the active node hierarchy.
 *   stream   This repo's /stream middleware turns the same cloud.js into 3D Tiles (POINTS GLB).
 *            PointCloudEffectsPlugin still converts the material, so shape + EDL apply — but a GLB
 *            carries no point spacing, so sizing is either fixed, or (toggle) derived per TILE from
 *            its geometric error. That toggle is the cheap approximation of "passing density down"
 *            from the octree into a plain 3D Tiles endpoint; per-POINT adaptive sizing would also
 *            need the active-node texture, keyed from each tile's implicit (level, x, y, z).
 *
 *   tileset  Any 3D Tiles URL as is — typically an /aggregate mosaic of point clouds (filter it with
 *            &only= so it stays regional) — with the same effects and sizing as `stream`.
 *
 * `stream` also takes a COPC (.copc.laz) url; `&crs=EPSG:<n>` is passed through for files that
 * declare no CRS (flai's open LiDAR).
 *
 * State lives in the query string so any view is shareable:
 *   /potree-lab?url=<cloud.js|.copc.laz|tileset.json>&mode=potree|stream|tileset&shape=round&edl=0.4&scale=1&geSize=1
 *
 * Dataset list = built-in public samples + (dev server only) the Iconem share-link manifest at
 * .local/aggregate-sets/iconem.json, served loopback-only by vite.config.ts.
 */
import { Scene, WebGLRenderer, PerspectiveCamera, Box3, Sphere, Vector2, Raycaster } from 'three';
import { TilesRenderer, EnvironmentControls, GlobeControls } from '3d-tiles-renderer';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DebugTilesPlugin, ImplicitTilingPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { PotreePlugin } from './vendor/potree/PotreePlugin.js';
import { PointCloudEffectsPlugin } from './vendor/pointcloud/PointCloudEffectsPlugin.js';
import { MW } from '@/lib/formats';
import { ImplicitAddRefineFixPlugin } from '@/lib/implicitAddFix';

const POTREE_REPO = 'https://raw.githubusercontent.com/potree/potree/refs/heads/develop/pointclouds/';
const BUILTIN = {
  'sample · Lion Takanawa': `${POTREE_REPO}lion_takanawa/cloud.js`,
  'sample · Lion (normals)': `${POTREE_REPO}lion_takanawa_normals/cloud.js`,
  'sample · Vol Total': `${POTREE_REPO}vol_total/cloud.js`,
  'flai COPC · Belgium Namur (EPSG:3812)': 'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/BE/SPW/NAMUR_2021-2022/overview/overview.copc.laz#crs=EPSG:3812',
  'aggregate · Open Heritage 3D (Potree 2.0 via /stream)': `${MW}/aggregate/tileset.json?set=openheritage3d`,
};
// Presets that only make sense in one mode switch to it when picked.
const MODE_OF = (u) => (/\/aggregate\/|tileset\.json/.test(u) ? 'tileset' : null);

const q = new URLSearchParams(location.search);
const params = {
  dataset: '',
  url: q.get('url') || BUILTIN['sample · Lion Takanawa'],
  mode: ['stream', 'tileset'].includes(q.get('mode')) ? q.get('mode') : 'potree',
  enable: true,
  errorTarget: Number(q.get('error') ?? 1),
  pointScale: Number(q.get('scale') ?? 1),
  pointShape: q.get('shape') || 'round',
  minPointSize: Number(q.get('min') ?? 2),
  edl: (q.get('edl') ?? '0.4') !== '0',
  edlStrength: Number(q.get('edl') ?? 0.4) || 0.4,
  edlRadius: 1.4,
  controls: ['globe', 'orbit'].includes(q.get('controls')) ? q.get('controls') : 'env',
  // inertia half-life in seconds (3DTRjs controls: dampingFactor IS that time constant); 0 = none
  damping: Number(q.get('damping') ?? 0.05),
  // loading: parallel downloads per origin / parses per frame, and the tile cache in MB
  maxDownloads: Number(q.get('dl') ?? 25),
  maxParse: Number(q.get('parse') ?? 5),
  cacheMB: Number(q.get('cache') ?? 400),
  debugColorMode: q.get('debug') || 'none',
  displayBoxBounds: q.get('boxes') === '1',
  geSize: q.get('geSize') !== '0',        // stream mode: size points from each tile's geometric error
  geFactor: Number(q.get('geFactor') ?? 1.7),
  fixedSize: Number(q.get('fixed') ?? 0.05),
};

// Surfaced for headless verification (scripts/cdp-screenshot.mjs --print-eval) and for poking at in devtools.
const LAB = (window.LAB = { errors: [], visibleTiles: 0, visiblePoints: 0, rootLoaded: false });
addEventListener('error', (e) => LAB.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => LAB.errors.push(String(e.reason?.message ?? e.reason)));

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x111111);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(4, 2, 8);

/**
 * Camera controls, switchable: 3DTRjs's EnvironmentControls (the default — a local scene with a
 * fallback ground plane) and GlobeControls (orbit on the WGS84 ellipsoid: only meaningful for
 * ECEF-placed content, which the lab recentres, so it is here to compare feel), or three's own
 * OrbitControls (a fixed target, no pick-to-pivot).
 */
let controls = null;
let radius = 10;                                 // of the loaded dataset's bounding sphere
function makeControls(kind) {
  controls?.dispose();
  if (kind === 'orbit') {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
  } else {
    controls = kind === 'globe' ? new GlobeControls(scene, camera, renderer.domElement) : new EnvironmentControls(scene, camera, renderer.domElement);
    controls.cameraRadius = 0;
    if (kind !== 'globe') controls.useFallbackPlane = true;
    if (kind === 'globe' && tiles) controls.setEllipsoid(controls.ellipsoid, tiles.group);
  }
  applyControlsRange();
  applyDamping();
}
/**
 * 3DTRjs controls damp with factor = 2^(−dt / dampingFactor), so dampingFactor is a half-life in
 * seconds (their default 0.15 s glides long after the pointer stops). three's OrbitControls damp
 * per frame with velocity *= (1 − dampingFactor); map the same half-life onto it at 60 fps.
 */
function applyDamping() {
  if (!controls) return;
  const t = params.damping;
  controls.enableDamping = t > 0;
  controls.dampingFactor = controls.isOrbitControls ? Math.min(1, 1 - Math.pow(2, -1 / 60 / Math.max(t, 1e-3))) : t;
}
/** Double-click: pivot on the picked point and move halfway to it — every control scheme. */
renderer.domElement.addEventListener('dblclick', (e) => {
  if (!tiles) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new Raycaster();
  ray.params.Points.threshold = radius / 200;
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(tiles.group, true)[0];
  if (!hit) return;
  const from = camera.position.clone(), to = camera.position.clone().lerp(hit.point, 0.5);
  const t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 350);
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(from, to, ease);
    if (controls.target) controls.target.copy(hit.point);           // OrbitControls
    camera.lookAt(hit.point);
    if (k < 1) requestAnimationFrame(step);
  };
  step();
});
function applyControlsRange() {
  if (!controls) return;
  controls.minDistance = radius / 50;
  controls.maxDistance = radius * 20;
  if (controls.raycaster) controls.raycaster.params.Points.threshold = radius / 200;
}
makeControls(params.controls);

let tiles = null, effects = null;

function streamUrl(src) {
  if (params.mode === 'tileset') return src;
  // "<url>#crs=EPSG:n" carries a CRS for sources that declare none
  const [bare, frag = ''] = src.split('#');
  const crs = new URLSearchParams(frag).get('crs');
  const format = /\.copc\.laz$/i.test(bare) ? 'copc' : 'potree';
  return `${MW}/stream/tileset.json?format=${format}&url=${encodeURIComponent(bare)}&cache=none${crs ? `&crs=${encodeURIComponent(crs)}` : ''}`;
}

/** Point size for a /stream tile. GE of a Potree-derived tile is its point spacing, so reuse it. */
function sizeFor(tile) {
  return params.geSize ? tile.geometricError * params.geFactor * params.pointScale : params.fixedSize * params.pointScale;
}

function applyStreamSizes() {
  if (!tiles || params.mode === 'potree') return;
  tiles.forEachLoadedModel((model, tile) => {
    model.traverse((o) => { if (o.isPoints && o.material?.isPointCloudMaterial) o.material.size = sizeFor(tile); });
  });
}

function initTiles() {
  if (tiles) { scene.remove(tiles.group); tiles.dispose(); }
  LAB.rootLoaded = false;
  const effectOpts = {
    pointShape: params.pointShape,
    minPointSize: params.minPointSize,
    debugColorMode: params.debugColorMode,
    edlStrength: params.edl ? params.edlStrength : 0,
    edlRadius: params.edlRadius,
  };

  if (params.mode === 'potree' && /\.copc\.laz|tileset\.json|\/aggregate\//i.test(params.url)) params.mode = 'stream';
  if (params.mode === 'potree') {
    tiles = new TilesRenderer();
    effects = new PotreePlugin({ url: params.url, pointScale: params.pointScale, ...effectOpts });
    tiles.registerPlugin(effects);
    tiles.group.rotation.x = -Math.PI / 2;           // Potree is Z-up
  } else {
    tiles = new TilesRenderer(streamUrl(params.url));
    tiles.registerPlugin(new ImplicitTilingPlugin());
    tiles.registerPlugin(new ImplicitAddRefineFixPlugin());   // see lib/implicitAddFix.ts
    // /stream may emit a georeferenced (ECEF) root; recentre + orient so both modes frame the same way.
    tiles.registerPlugin(new ReorientationPlugin({ recenter: true }));
    effects = new PointCloudEffectsPlugin(effectOpts);
    tiles.registerPlugin(effects);
    tiles.addEventListener('load-model', ({ scene: model, tile }) => {
      model.traverse((o) => { if (o.isPoints && o.material?.isPointCloudMaterial) o.material.size = sizeFor(tile); });
    });
  }
  tiles.registerPlugin(new DebugTilesPlugin({ displayBoxBounds: params.displayBoxBounds }));
  tiles.errorTarget = params.errorTarget;
  applyLoading();
  tiles.setCamera(camera);
  scene.add(tiles.group);
  if (params.controls === 'globe') controls.setEllipsoid(controls.ellipsoid, tiles.group);
  LAB.tiles = tiles;                               // devtools / headless inspection
  LAB.url = params.url;                            // potree mode keeps it in the plugin (tiles.rootURL is null)
  LAB.mode = params.mode;

  // Frame whatever loaded: datasets range from metres to kilometres, so everything scales off the bounds.
  // A bounding SPHERE, not a box: in stream mode ReorientationPlugin rotates the group, and the
  // world-axis box around a rotated box is inflated (up to √3×), which framed georeferenced sites
  // several times too far away. A sphere is rotation-invariant, so both modes frame identically.
  tiles.addEventListener('load-root-tileset', () => {
    const sphere = new Sphere();
    tiles.group.updateMatrixWorld();
    tiles.getBoundingSphere(sphere);
    sphere.applyMatrix4(tiles.group.matrixWorld);
    tiles.group.position.sub(sphere.center);
    radius = sphere.radius || 10;
    tiles.group.updateMatrixWorld();                 // pick up the recentring before measuring again
    const box = new Box3();                          // only for the fallback plane height below
    tiles.getBoundingBox(box);
    box.applyMatrix4(tiles.group.matrixWorld);
    camera.position.set(0.6, 0.4, 1).normalize().multiplyScalar(radius * 2.5);
    camera.lookAt(0, 0, 0);
    camera.near = radius / 1000;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    applyControlsRange();
    if (controls.fallbackPlane) controls.fallbackPlane.constant = -box.min.y;
    LAB.rootLoaded = true;
  });
  tiles.addEventListener('load-error', (e) => LAB.errors.push(`load-error: ${e.error?.message ?? e.error} (${e.url ?? ''})`));
  syncUrl();
}

/**
 * How fast tiles arrive. The queues are shared defaults (25 downloads per origin, 5 parses per
 * frame): what feels slow in motion is usually the PARSE budget — each tile's points are decoded on
 * the main thread, so a frame that parses 5 big tiles stalls. The cache keeps parsed tiles around
 * when the camera comes back.
 */
function applyLoading() {
  if (!tiles) return;
  tiles.downloadQueue.maxJobsPerOrigin = params.maxDownloads;
  tiles.parseQueue.maxJobs = params.maxParse;
  tiles.lruCache.maxBytesSize = params.cacheMB * 1024 * 1024;
  tiles.lruCache.minBytesSize = Math.min(tiles.lruCache.minBytesSize, tiles.lruCache.maxBytesSize);
}

function syncUrl() {
  const s = new URLSearchParams({ url: params.url, mode: params.mode, shape: params.pointShape,
    edl: params.edl ? String(params.edlStrength) : '0', scale: String(params.pointScale), error: String(params.errorTarget) });
  if (params.mode !== 'potree') { s.set('geSize', params.geSize ? '1' : '0'); if (!params.geSize) s.set('fixed', String(params.fixedSize)); }
  if (params.debugColorMode !== 'none') s.set('debug', params.debugColorMode);
  if (params.displayBoxBounds) s.set('boxes', '1');
  if (params.controls !== 'env') s.set('controls', params.controls);
  if (params.damping !== 0.05) s.set('damping', String(params.damping));
  if (params.maxDownloads !== 25) s.set('dl', String(params.maxDownloads));
  if (params.maxParse !== 5) s.set('parse', String(params.maxParse));
  if (params.cacheMB !== 400) s.set('cache', String(params.cacheMB));
  history.replaceState(null, '', `?${s}`);
}

// ── GUI ─────────────────────────────────────────────────────────────────────────────────────────
const gui = new GUI({ title: 'Potree lab' });
const datasets = { ...BUILTIN };

/**
 * lil-gui's `controller.options(list)` does not update in place: it DESTROYS the controller and returns
 * a new one, appended at the end of its parent, without the old onChange. So swap in the returned
 * controller, re-attach the handler and put it back where the old one was.
 */
function replaceOptions(ctl, list, onChange) {
  const el = ctl.domElement;
  const next = el.nextSibling;
  const parentEl = el.parentElement;
  const fresh = ctl.options(list).onChange(onChange);
  if (parentEl) parentEl.insertBefore(fresh.domElement, next);
  return fresh;
}

function onDatasetChange(name) {
  if (!(name in datasets)) return;
  params.url = datasets[name];
  const mode = MODE_OF(params.url);
  if (mode) { params.mode = mode; modeCtl.updateDisplay(); streamFolder.show(true); }
  else if (params.mode === 'tileset') { params.mode = 'stream'; modeCtl.updateDisplay(); }
  urlCtl.updateDisplay();
  initTiles();
}
let datasetCtl = gui.add(params, 'dataset', Object.keys(datasets)).name('dataset').onChange(onDatasetChange);
const urlCtl = gui.add(params, 'url').name('source url').onFinishChange(initTiles);
const modeCtl = gui.add(params, 'mode', { 'PotreePlugin (adaptive size)': 'potree', '/stream 3D Tiles + effects': 'stream', 'any 3D Tiles url + effects': 'tileset' })
  .name('load as').onChange(() => { streamFolder.show(params.mode !== 'potree'); scaleCtl.name(params.mode === 'potree' ? 'point scale' : 'size multiplier'); initTiles(); });

gui.add(params, 'controls', { 'EnvironmentControls (3DTRjs)': 'env', 'GlobeControls (3DTRjs)': 'globe', 'OrbitControls (three)': 'orbit' })
  .name('controls').onChange((v) => { makeControls(v); syncUrl(); });
gui.add(params, 'damping', 0, 0.5, 0.01).name('inertia (s)').onChange(() => { applyDamping(); syncUrl(); });

const tilesFolder = gui.addFolder('tiles');
tilesFolder.add(params, 'enable').name('update tiles');
tilesFolder.add(params, 'errorTarget', 0.5, 16, 0.1).name('error target').onChange((v) => { tiles.errorTarget = v; syncUrl(); });
tilesFolder.add(params, 'maxDownloads', 1, 64, 1).name('parallel downloads').onChange(() => { applyLoading(); syncUrl(); });
tilesFolder.add(params, 'maxParse', 1, 32, 1).name('parses / frame').onChange(() => { applyLoading(); syncUrl(); });
tilesFolder.add(params, 'cacheMB', 50, 2000, 50).name('tile cache (MB)').onChange(() => { applyLoading(); syncUrl(); });

const points = gui.addFolder('points');
const scaleCtl = points.add(params, 'pointScale', 0.1, 4, 0.05).name(params.mode === 'potree' ? 'point scale' : 'size multiplier').onChange((v) => {
  if (params.mode === 'potree') effects.pointScale = v; else applyStreamSizes();
  syncUrl();
});
points.add(params, 'pointShape', ['square', 'round', 'sphere']).name('shape').onChange((v) => { effects.pointShape = v; syncUrl(); });
points.add(params, 'minPointSize', 0, 8, 0.5).name('min size (px)').onChange((v) => { effects.minPointSize = v; });
points.add(params, 'edl').name('eye-dome lighting').onChange((v) => { effects.edlStrength = v ? params.edlStrength : 0; syncUrl(); });
points.add(params, 'edlStrength', 0.05, 2, 0.01).name('edl strength').onChange((v) => { if (params.edl) effects.edlStrength = v; syncUrl(); });
points.add(params, 'edlRadius', 1, 4, 0.01).name('edl radius').onChange((v) => { effects.edlRadius = v; });

const streamFolder = gui.addFolder('stream mode sizing');
streamFolder.add(params, 'geSize').name('size from tile GE').onChange(() => { applyStreamSizes(); syncUrl(); });
streamFolder.add(params, 'geFactor', 0.25, 4, 0.05).name('GE → size factor').onChange(applyStreamSizes);
streamFolder.add(params, 'fixedSize', 0.001, 1, 0.001).name('fixed size (m)').onChange(applyStreamSizes);
streamFolder.show(params.mode !== 'potree');

const debug = gui.addFolder('debug');
debug.add(params, 'debugColorMode', ['none', 'node', 'depth', 'tile']).name('color by').onChange((v) => { effects.debugColorMode = v; syncUrl(); });
debug.add(params, 'displayBoxBounds').name('bounding boxes').onChange((v) => {
  tiles.getPluginByName('DEBUG_TILES_PLUGIN').displayBoxBounds = v; syncUrl();
});

// Iconem datasets: dev-only manifest of share links (see file header). Absent in production builds.
fetch('/local-sets/iconem.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((m) => {
    if (!m?.entries) return;
    for (const e of m.entries.filter((x) => x.format === 'potree')) datasets[`Iconem · ${e.project} / ${e.name}`] = e.url;
    const match = Object.entries(datasets).find(([, u]) => u === params.url);
    params.dataset = match ? match[0] : '';
    datasetCtl = replaceOptions(datasetCtl, Object.keys(datasets), onDatasetChange);
    datasetCtl.updateDisplay();
    hud.dataset.iconem = String(Object.keys(datasets).length - Object.keys(BUILTIN).length);
  })
  .catch(() => {});

// ── HUD + loop ──────────────────────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud');
function updateHud() {
  let pts = 0, vis = 0;
  tiles.forEachLoadedModel((model, tile) => {
    if (!tiles.visibleTiles.has(tile)) return;
    vis++;
    model.traverse((o) => { if (o.isPoints) pts += o.geometry.attributes.position.count; });
  });
  LAB.visibleTiles = vis;
  LAB.visiblePoints = pts;
  hud.textContent = `${params.mode === 'potree' ? 'PotreePlugin · adaptive size' : `${params.mode === 'tileset' ? '3D Tiles url' : '/stream 3D Tiles'} · ${params.geSize ? 'size from tile GE' : 'fixed size'}`}`
    + ` · ${vis} tiles · ${pts.toLocaleString('en-US')} points · ${tiles.downloadQueue.currJobs ?? 0}↓ ${tiles.parseQueue.currJobs ?? 0}⚙ · cache ${(tiles.lruCache.cachedBytes / 1048576).toFixed(0)} MB`
    + (hud.dataset.iconem ? ` · ${hud.dataset.iconem} Iconem datasets listed` : '')
    + (LAB.errors.length ? ` · ${LAB.errors.length} error(s)` : '');
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

let frame = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  if (params.enable) {
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
  }
  renderer.render(scene, camera);
  if (++frame % 15 === 0) updateHud();
});

initTiles();

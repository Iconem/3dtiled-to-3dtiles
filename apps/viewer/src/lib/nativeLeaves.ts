/**
 * Native mosaic leaves: render an `/aggregate?native=1` leaf in its SOURCE format instead of
 * through /stream — and switch between the two in place.
 *
 * With `&native=1` the aggregate keeps every leaf's `content.uri` (the /stream 3D Tiles wrapper) and
 * adds the source alongside it:
 *
 *   content.extensions.ICONEM_content_source = { format, version, encoding, uri, transform }
 *
 * `transform` maps the source's own coordinates (what PotreePlugin draws) to the leaf's frame.
 *
 * This plugin claims the leaves it can read. Today that is Potree 1.x with `.bin` nodes (1.8 thanks
 * to the vendored loader patch) and Potree 2.0 DEFAULT. For each claimed leaf it mounts a CHILD
 * TilesRenderer — two variants, created lazily and kept side by side:
 *
 *   native   3DTRjs's own PotreePlugin reading the source octree directly;
 *   stream   a plain TilesRenderer on the /stream wrapper (what every other client renders).
 *
 * `mode` picks the one that updates and draws. The other keeps its loaded tiles (the shared LRU
 * cache evicts them under pressure, as it does for anything not marked used), so flipping back is
 * instant and nothing is re-requested: the mosaic URL is the same either way, so the parent
 * renderer never remounts. Every other leaf, and every leaf in a client without this plugin
 * (CesiumJS), takes the 3D Tiles path through the parent as before.
 *
 * How it plugs into the parent renderer:
 *   - preprocessNode   the core marks a leaf whose uri ends in .json as an EXTERNAL TILESET
 *                      (unrenderable). A claimed leaf is flipped to renderable content, so the
 *                      parent shows/hides it like a model.
 *   - preprocessURL    the content request is redirected to a placeholder URL (content.uri itself is
 *                      untouched: the viewer derives dataset ids, styling and hide/tint from it).
 *   - fetchData        the placeholder resolves to an empty buffer, so nothing goes over the network.
 *   - parseToMesh      returns a Group holding both variants' groups. The children share the
 *                      parent's LRU cache, download and parse queues, so memory and bandwidth
 *                      budgets stay global.
 *   - update-after     each frame, the ACTIVE variant of every leaf that is VISIBLE gets the
 *                      parent's cameras, resolutions and error target, then updates. Hidden leaves
 *                      and inactive variants cost nothing.
 *   - disposeTile      a leaf evicted from the cache disposes both children.
 */
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
// Vendored from 3DTilesRendererJS master (not in an npm release yet), with the Potree 1.8 patch.
import { PotreePlugin } from '@/potree-lab/vendor/potree/PotreePlugin.js';

export const NATIVE_EXT = 'ICONEM_content_source';
const PLACEHOLDER_EXT = 'iconem-native';

export type LeafMode = 'native' | 'stream';

export interface NativeSource {
  format: string;
  version?: string;
  encoding?: string;
  uri: string;
  transform: number[];
}

/** Whether 3DTRjs (with the vendored PotreePlugin) reads this source directly. */
export function nativeSupported(src: NativeSource | undefined | null): boolean {
  if (!src || src.format !== 'potree' || !Array.isArray(src.transform) || src.transform.length !== 16) return false;
  const v = String(src.version ?? '');
  const enc = String(src.encoding ?? '').toUpperCase();
  if (v.startsWith('2')) return enc === '' || enc === 'DEFAULT';     // BROTLI: the loader never checks it
  return enc === 'BINARY';                                            // 1.x LAS/LAZ nodes: always fetches .bin
}

interface Variant {
  child: any;
  group: THREE.Group;
  potree?: any;
}

interface Mounted {
  tile: any;
  scene: THREE.Group;
  src: NativeSource;
  streamUrl: string;
  native?: Variant;
  stream?: Variant;
}

export interface NativeLeavesOptions {
  /** Which variant draws; switchable at any time through the `mode` property. */
  mode?: LeafMode;
  /** PotreePlugin point-size multiplier. */
  pointScale?: number;
  /** Error target for the child renderers; defaults to the parent's, read every frame. */
  errorTarget?: number | null;
  /** Fresh plugin instances for every /stream child renderer (implicit tiling, glTF extensions…). */
  createStreamPlugins?: (() => any[]) | null;
  /** Fresh plugin instances for EVERY child renderer, native and /stream alike (load scheduling…). */
  extraPlugins?: (() => any[]) | null;
  /** PointCloudEffectsPlugin options (shape, min/max size, EDL) for every native PotreePlugin. */
  effectOptions?: (() => Record<string, unknown>) | null;
  /**
   * Called for every model a child loads, with the PARENT leaf tile (for per-dataset styling) and
   * the child's own tile (geometric error, for point sizing).
   */
  onChildModel?: ((scene: THREE.Object3D, leafTile: any, childTile: any) => void) | null;
}

export class NativeLeavesPlugin {
  name = 'NATIVE_LEAVES_PLUGIN';
  tiles: any = null;
  mounted = new Map<any, Mounted>();
  private _mode: LeafMode;
  private _pointScale: number;
  errorTarget: number | null;
  createStreamPlugins: NativeLeavesOptions['createStreamPlugins'];
  extraPlugins: NativeLeavesOptions['extraPlugins'];
  effectOptions: NativeLeavesOptions['effectOptions'];
  onChildModel: NativeLeavesOptions['onChildModel'];
  private _seq = 0;
  private _onUpdateAfter = () => this._updateChildren();
  private _forward = (e: any) => this.tiles?.dispatchEvent({ type: e.type });

  constructor({ mode = 'native', pointScale = 1, errorTarget = null, createStreamPlugins = null, extraPlugins = null, effectOptions = null, onChildModel = null }: NativeLeavesOptions = {}) {
    this._mode = mode;
    this._pointScale = pointScale;
    this.errorTarget = errorTarget;
    this.createStreamPlugins = createStreamPlugins;
    this.extraPlugins = extraPlugins;
    this.effectOptions = effectOptions;
    this.onChildModel = onChildModel;
  }

  /** Every PointCloudEffectsPlugin under this plugin: each native PotreePlugin, each /stream child's. */
  forEachEffects(cb: (plugin: any) => void) {
    this.mounted.forEach((m) => {
      if (m.native) cb(m.native.potree);
      const p = m.stream?.child.getPluginByName?.('POINT_CLOUD_EFFECTS_PLUGIN');
      if (p) cb(p);
    });
  }

  get mode() { return this._mode; }
  set mode(v: LeafMode) {
    if (v === this._mode) return;
    this._mode = v;
    this.mounted.forEach((m) => this._activate(m));
    this.tiles?.dispatchEvent({ type: 'needs-update' });
    this.tiles?.dispatchEvent({ type: 'needs-render' });
  }

  get pointScale() { return this._pointScale; }
  set pointScale(v: number) {
    this._pointScale = v;
    this.mounted.forEach((m) => { if (m.native) m.native.potree.pointScale = v; });
    this.tiles?.dispatchEvent({ type: 'needs-render' });
  }

  init(tiles: any) {
    this.tiles = tiles;
    tiles.addEventListener('update-after', this._onUpdateAfter);
  }

  /** Every loaded model of every child renderer, both variants: `(scene, leafTile, childTile)`. */
  forEachChildModel(cb: (scene: THREE.Object3D, leafTile: any, childTile: any) => void) {
    this.mounted.forEach((m, tile) => {
      for (const v of [m.native, m.stream]) v?.child.forEachLoadedModel((sc: THREE.Object3D, ct: any) => cb(sc, tile, ct));
    });
  }

  /** Counts for a HUD: leaves mounted, leaves drawing, points on screen across the active children. */
  stats() {
    let visible = 0, points = 0;
    this.mounted.forEach((m, tile) => {
      const v = m[this._mode];
      if (!v || !this.tiles.visibleTiles.has(tile)) return;
      visible++;
      v.child.visibleTiles.forEach((t: any) => {
        t.engineData?.scene?.traverse((o: any) => { if (o.isPoints) points += o.geometry.attributes.position?.count ?? 0; });
      });
    });
    return { mounted: this.mounted.size, visible, points, mode: this._mode };
  }

  preprocessNode(tile: any) {
    const src = tile.content?.extensions?.[NATIVE_EXT];
    if (!nativeSupported(src)) return;
    tile.internal.nativeLeaf = ++this._seq;
    // the /stream wrapper the leaf would have loaded as an external tileset; resolved now, the way
    // the core resolves content (basePath + '/'), before preprocessURL swaps in the placeholder
    tile.internal.nativeStreamUrl = new URL(tile.content.uri, `${tile.internal.basePath}/`).toString();
    if (tile.internal.hasUnrenderableContent) {
      tile.internal.hasUnrenderableContent = false;
      tile.internal.hasRenderableContent = true;
      tile.internal.depthFromRenderedParent += 1;
    }
  }

  preprocessURL(url: string, tile: any) {
    // a unique URL per leaf: the download queue is keyed by URL
    return tile?.internal?.nativeLeaf ? `${location.origin}/native-leaf/${tile.internal.nativeLeaf}.${PLACEHOLDER_EXT}` : url;
  }

  fetchData(url: string) {
    return url.endsWith(`.${PLACEHOLDER_EXT}`) ? Promise.resolve(new ArrayBuffer(0)) : null;
  }

  parseToMesh(_buffer: ArrayBuffer, tile: any, extension: string) {
    if (extension !== PLACEHOLDER_EXT) return null;
    const src: NativeSource = tile.content.extensions[NATIVE_EXT];
    const scene = new THREE.Group();
    scene.name = `native-leaf:${src.format}`;
    scene.userData.nativeSource = src;
    const m: Mounted = { tile, scene, src, streamUrl: tile.internal.nativeStreamUrl };
    this.mounted.set(tile, m);
    this._activate(m);
    return scene;
  }

  /** Make sure the active variant exists; show it, hide the other. */
  private _activate(m: Mounted) {
    if (!m[this._mode]) m[this._mode] = this._mode === 'native' ? this._mountNative(m) : this._mountStream(m);
    if (m.native) m.native.group.visible = this._mode === 'native';
    if (m.stream) m.stream.group.visible = this._mode === 'stream';
  }

  private _newChild(m: Mounted, url?: string): any {
    const parent = this.tiles;
    const child: any = url ? new TilesRenderer(url) : new TilesRenderer();
    // one memory + bandwidth budget across the mosaic (3DTRjs supports sharing these three)
    child.lruCache = parent.lruCache;
    child.downloadQueue = parent.downloadQueue;
    child.parseQueue = parent.parseQueue;
    child.fetchOptions = parent.fetchOptions;
    child.errorTarget = this.errorTarget ?? parent.errorTarget;
    // the R3F canvas renders on demand: a child's tile arriving must wake the parent's frame loop
    child.addEventListener('needs-update', this._forward);
    child.addEventListener('needs-render', this._forward);
    child.addEventListener('load-error', (e: any) => console.warn('[native leaf]', url ?? m.src.uri, e.error));
    child.addEventListener('load-model', (e: any) => this.onChildModel?.(e.scene, m.tile, e.tile));
    for (const p of this.extraPlugins?.() ?? []) child.registerPlugin(p);
    return child;
  }

  private _mountNative(m: Mounted): Variant {
    const child = this._newChild(m);
    const potree = new PotreePlugin({ ...(this.effectOptions?.() ?? {}), url: m.src.uri, pointScale: this._pointScale, useRecommendedSettings: false });
    child.registerPlugin(potree);
    // The native→leaf matrix is a georeferenced projected CRS: near-orthogonal, not exactly, so it
    // goes on its own node with a raw matrix rather than through a lossy decompose.
    const group = new THREE.Group();
    group.name = 'native-frame';
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(m.src.transform);
    group.add(child.group);
    m.scene.add(group);
    return { child, group, potree };
  }

  private _mountStream(m: Mounted): Variant {
    const child = this._newChild(m, m.streamUrl);
    for (const p of this.createStreamPlugins?.() ?? []) child.registerPlugin(p);
    // the /stream wrapper's own root transform places it in the leaf frame: nothing to add here
    const group = new THREE.Group();
    group.name = 'stream-frame';
    group.add(child.group);
    m.scene.add(group);
    return { child, group };
  }

  private _disposeVariant(v: Variant | undefined) {
    if (!v) return;
    v.child.removeEventListener('needs-update', this._forward);
    v.child.removeEventListener('needs-render', this._forward);
    v.child.dispose();
    v.group.removeFromParent();
  }

  disposeTile(tile: any) {
    const m = this.mounted.get(tile);
    if (!m) return;
    this.mounted.delete(tile);
    this._disposeVariant(m.native);
    this._disposeVariant(m.stream);
  }

  dispose() {
    this.tiles?.removeEventListener('update-after', this._onUpdateAfter);
    [...this.mounted.keys()].forEach((t) => this.disposeTile(t));
  }

  private _updateChildren() {
    const parent = this.tiles;
    if (!parent || !this.mounted.size) return;
    const cameras: any[] = parent.cameras;
    this.mounted.forEach((m, tile) => {
      // a dataset hidden by the viewer (scene.visible = false) stops loading too
      const v = m[this._mode];
      if (!v || !parent.visibleTiles.has(tile) || !m.scene.visible) return;
      const { child } = v;
      for (const cam of cameras) {
        if (!child.hasCamera(cam)) child.setCamera(cam);
        const res = parent.cameraMap.get(cam);
        if (res) child.setResolution(cam, res.x, res.y);
      }
      for (const cam of [...child.cameras]) if (!cameras.includes(cam)) child.deleteCamera(cam);
      child.errorTarget = this.errorTarget ?? parent.errorTarget;
      child.group.updateWorldMatrix(true, false);
      child.update();
    });
  }
}

/** An /aggregate tileset URL with `&native=1` added; any other URL unchanged. */
export function withNativeLeaves(url: string): string {
  try {
    const u = new URL(url, location.href);
    if (!/\/aggregate\/tileset\.json$/.test(u.pathname)) return url;
    u.searchParams.set('native', '1');
    return u.toString();
  } catch { return url; }
}

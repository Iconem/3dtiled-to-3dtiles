/**
 * Native mosaic leaves: render an `/aggregate?native=1` leaf in its SOURCE format instead of
 * through /stream.
 *
 * With `&native=1` the aggregate keeps every leaf's `content.uri` (the /stream 3D Tiles wrapper) and
 * adds the source alongside it:
 *
 *   content.extensions.ICONEM_content_source = { format, version, encoding, uri, transform }
 *
 * `transform` maps the source's own coordinates (what PotreePlugin draws) to the leaf's frame.
 *
 * This plugin claims the leaves it can read. Today that is Potree 1.x with `.bin` nodes (1.8 thanks
 * to the vendored loader patch) and Potree 2.0 DEFAULT. For each claimed leaf, instead of fetching
 * the /stream tileset.json, it mounts a CHILD TilesRenderer running 3DTRjs's own PotreePlugin. Every
 * other leaf, and every leaf in a client without this plugin (CesiumJS), takes the 3D Tiles path.
 *
 * How it plugs into the parent renderer:
 *   - preprocessNode   the core marks a leaf whose uri ends in .json as an EXTERNAL TILESET
 *                      (unrenderable). A claimed leaf is flipped to renderable content, so the
 *                      parent shows/hides it like a model.
 *   - preprocessURL    the content request is redirected to a placeholder URL (content.uri itself is
 *                      untouched: the viewer derives dataset ids, styling and hide/tint from it).
 *   - fetchData        the placeholder resolves to an empty buffer, so nothing goes over the network.
 *   - parseToMesh      returns a Group: [leaf transform, applied by the parent] → [native→leaf
 *                      matrix] → child.group. The child shares the parent's LRU cache, download and
 *                      parse queues, so memory and bandwidth budgets stay global.
 *   - update-after     each frame, every child whose leaf is VISIBLE gets the parent's cameras,
 *                      resolutions and error target, then updates. Hidden leaves cost nothing.
 *   - disposeTile      a leaf evicted from the cache disposes its child renderer.
 */
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
// Vendored from 3DTilesRendererJS master (not in an npm release yet), with the Potree 1.8 patch.
import { PotreePlugin } from '@/potree-lab/vendor/potree/PotreePlugin.js';

export const NATIVE_EXT = 'ICONEM_content_source';
const PLACEHOLDER_EXT = 'iconem-native';

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

interface Mounted {
  child: any;
  scene: THREE.Group;
  potree: any;
}

export interface NativeLeavesOptions {
  /** PotreePlugin point-size multiplier. */
  pointScale?: number;
  /** Error target for the child renderers; defaults to the parent's, read every frame. */
  errorTarget?: number | null;
  /** Called for every model a child loads, with the PARENT leaf tile (for per-dataset styling). */
  onChildModel?: ((scene: THREE.Object3D, leafTile: any) => void) | null;
}

export class NativeLeavesPlugin {
  name = 'NATIVE_LEAVES_PLUGIN';
  tiles: any = null;
  mounted = new Map<any, Mounted>();
  private _pointScale: number;
  errorTarget: number | null;
  onChildModel: NativeLeavesOptions['onChildModel'];
  private _seq = 0;
  private _onUpdateAfter = () => this._updateChildren();
  private _forward = (e: any) => this.tiles?.dispatchEvent({ type: e.type });

  constructor({ pointScale = 1, errorTarget = null, onChildModel = null }: NativeLeavesOptions = {}) {
    this._pointScale = pointScale;
    this.errorTarget = errorTarget;
    this.onChildModel = onChildModel;
  }

  get pointScale() { return this._pointScale; }
  set pointScale(v: number) {
    this._pointScale = v;
    this.mounted.forEach((m) => { m.potree.pointScale = v; });
    this.tiles?.dispatchEvent({ type: 'needs-render' });
  }

  init(tiles: any) {
    this.tiles = tiles;
    tiles.addEventListener('update-after', this._onUpdateAfter);
  }

  /** Counts for a HUD: leaves mounted, leaves drawing, points on screen across all children. */
  stats() {
    let visible = 0, points = 0;
    this.mounted.forEach((m, tile) => {
      if (!this.tiles.visibleTiles.has(tile)) return;
      visible++;
      m.child.visibleTiles.forEach((t: any) => {
        t.engineData?.scene?.traverse((o: any) => { if (o.isPoints) points += o.geometry.attributes.position?.count ?? 0; });
      });
    });
    return { mounted: this.mounted.size, visible, points };
  }

  preprocessNode(tile: any) {
    const src = tile.content?.extensions?.[NATIVE_EXT];
    if (!nativeSupported(src)) return;
    tile.internal.nativeLeaf = ++this._seq;
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
    const parent = this.tiles;
    const src: NativeSource = tile.content.extensions[NATIVE_EXT];

    const child: any = new TilesRenderer();
    // one memory + bandwidth budget across the mosaic (3DTRjs supports sharing these three)
    child.lruCache = parent.lruCache;
    child.downloadQueue = parent.downloadQueue;
    child.parseQueue = parent.parseQueue;
    child.fetchOptions = parent.fetchOptions;
    child.errorTarget = this.errorTarget ?? parent.errorTarget;
    const potree = new PotreePlugin({ url: src.uri, pointScale: this._pointScale, useRecommendedSettings: false });
    child.registerPlugin(potree);
    // the R3F canvas renders on demand: a child's tile arriving must wake the parent's frame loop
    child.addEventListener('needs-update', this._forward);
    child.addEventListener('needs-render', this._forward);
    child.addEventListener('load-error', (e: any) => console.warn('[native leaf]', src.uri, e.error));
    child.addEventListener('load-model', (e: any) => this.onChildModel?.(e.scene, tile));

    // The native→leaf matrix is a georeferenced projected CRS: near-orthogonal, not exactly, so it
    // goes on its own node with a raw matrix rather than through a lossy decompose.
    const frame = new THREE.Group();
    frame.name = 'native-frame';
    frame.matrixAutoUpdate = false;
    frame.matrix.fromArray(src.transform);
    frame.add(child.group);
    const scene = new THREE.Group();
    scene.name = `native-leaf:${src.format}`;
    scene.userData.nativeSource = src;
    scene.add(frame);

    this.mounted.set(tile, { child, scene, potree });
    return scene;
  }

  disposeTile(tile: any) {
    const m = this.mounted.get(tile);
    if (!m) return;
    this.mounted.delete(tile);
    m.child.removeEventListener('needs-update', this._forward);
    m.child.removeEventListener('needs-render', this._forward);
    m.child.dispose();
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
      if (!parent.visibleTiles.has(tile) || !m.scene.visible) return;
      const { child } = m;
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

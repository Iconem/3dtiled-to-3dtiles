/**
 * One picking rule for every "where did the user point" question in the 3DTRjs viewer: the
 * double-click pivot, the middle-drag zoom anchor, and the controls' own drag / rotate / zoom pivot
 * (GlobeControls and EnvironmentControls raycast the scene on every pointer-down; see
 * `installFilteredRaycast`).
 *
 * Candidates are filtered before the nearest one wins:
 *   - nothing hidden: an object whose ancestor chain has `visible = false` (a dataset hidden by the
 *     picker, the inactive native/stream variant of a leaf) — three's Raycaster does NOT skip those;
 *   - no "furniture": wireframe materials (the bare reference sphere when the basemap is off),
 *     materials that do not write colour (render hooks), transparent materials under 50 % opacity;
 *   - no back faces: a mesh face whose normal points away from the ray (the inside of a building,
 *     the far wall of a courtyard seen through a thin roof) is not a surface the user can see.
 *
 * Then the dataset wins over the terrain: when both the loaded content and the globe/terrain are
 * under the cursor, only content hits count (a cloud a few metres above the DEM must not lose to the
 * ground behind it, and content UNDER the terrain stays reachable); when only the terrain is hit, the
 * nearest terrain hit is used, so zooming toward bare ground keeps working with no data around.
 */
import * as THREE from 'three';

export interface PickHit extends THREE.Intersection {
  /** The hit is on the globe / terrain, not on the loaded content. */
  onTerrain: boolean;
}

const _normal = new THREE.Vector3();

function visibleChain(o: THREE.Object3D | null): boolean {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function materialPickable(m: THREE.Material | undefined): boolean {
  if (!m || m.visible === false) return false;
  if ((m as THREE.MeshBasicMaterial).wireframe) return false;
  if (m.colorWrite === false) return false;
  if (m.transparent && m.opacity < 0.5) return false;
  return true;
}

/** Whether a raw three.js intersection is a surface the user can see. */
export function hitPickable(hit: THREE.Intersection, rayDirection: THREE.Vector3): boolean {
  const o: any = hit.object;
  if (!visibleChain(o)) return false;
  const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  const m = hit.face && Array.isArray(o.material) ? o.material[hit.face.materialIndex] : mats[0];
  if (!materialPickable(m)) return false;
  if (hit.face && o.isMesh) {
    _normal.copy(hit.face.normal).transformDirection(o.matrixWorld);
    const facing = _normal.dot(rayDirection);
    // BackSide materials draw the other face: the visible one is the one facing away
    if (m.side === THREE.BackSide ? facing < 0 : facing > 0) return false;
  }
  return true;
}

function isUnder(o: THREE.Object3D | null, root: THREE.Object3D): boolean {
  for (let p = o; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * Nearest pickable hit under the ray. `content` is the loaded tileset's group (may be null before
 * a load), `nav` is the group holding both the content and the globe/terrain renderers; everything
 * under `nav` that is not under `content` counts as terrain.
 */
export function pickPoint(raycaster: THREE.Raycaster, content: THREE.Object3D | null, nav: THREE.Object3D | null): PickHit | null {
  const root = nav ?? content;
  if (!root) return null;
  const prevFirst = (raycaster as any).firstHitOnly;
  (raycaster as any).firstHitOnly = false;             // the nearest hit may be filtered out: look past it
  const hits = raycaster.intersectObject(root, true);  // sorted by distance
  (raycaster as any).firstHitOnly = prevFirst;
  const dir = raycaster.ray.direction;
  // Points: a hit counts only within the pixel radius AT ITS OWN DISTANCE. The raycaster's world
  // threshold is one number for the whole ray, sized for the scene's distance; a stray point two metres
  // in front of the camera then "hits" from metres away and, being nearest, wins — the pivot lands
  // right in front of the lens and a middle-drag zoom toward it moves nothing ("middle-drag does not
  // react on a point cloud, right after flying to a marker").
  const perUnit = (raycaster as any).pointsPixelAngle as number | undefined;
  let terrain: THREE.Intersection | null = null;
  for (const h of hits) {
    if (perUnit != null && (h.object as any).isPoints && h.distanceToRay != null && h.distanceToRay > h.distance * perUnit) continue;
    if (!hitPickable(h, dir)) continue;
    if (content && isUnder(h.object, content)) return Object.assign(h, { onTerrain: false });
    if (!terrain) terrain = h;
  }
  return terrain ? Object.assign(terrain, { onTerrain: true }) : null;
}

/** NDC of a pointer event over an element. */
export function pointerNdc(e: { clientX: number; clientY: number }, dom: HTMLElement, out = new THREE.Vector2()): THREE.Vector2 {
  const r = dom.getBoundingClientRect();
  return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

/**
 * Points have no area: accept anything within `pixelRadius` screen pixels of the ray, as a
 * world-space radius at the distance of `refPoint` (roughly how far the scene is here).
 */
export function applyPointsPickTolerance(raycaster: THREE.Raycaster, camera: THREE.Camera, dom: HTMLElement, refPoint: THREE.Vector3, pixelRadius = 15) {
  const fovRad = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 60);
  const distance = camera.position.distanceTo(refPoint) || 1;
  const perUnit = (2 * Math.tan(fovRad / 2)) / (dom.clientHeight || 1);     // world units per pixel, per metre of distance
  raycaster.params.Points.threshold = perUnit * distance * pixelRadius;
  // per-hit check in pickPoint: a point counts within `pixelRadius` px at its own distance
  (raycaster as any).pointsPixelAngle = perUnit * pixelRadius;
}

const EMPTY = new THREE.Object3D();

/**
 * Make GlobeControls / EnvironmentControls pick with the same rule. Their `_raycast(raycaster)` is
 * the single place every pointer-down, zoom and "point below camera" query goes through; it returns
 * `{ point, distance, … }` or falls back (EnvironmentControls: a plane; GlobeControls: the
 * ellipsoid). The fallback code lives inside the original method after its own scene raycast, so on
 * a filtered miss the original is called against an empty scene to reach it.
 */
export function installFilteredRaycast(controls: any, getContent: () => THREE.Object3D | null, getNav: () => THREE.Object3D | null) {
  // drei's OrbitControls has no _raycast (and no scene picking at all): nothing to wrap
  if (!controls || controls.__filteredRaycast || typeof controls._raycast !== 'function') return;
  const original = controls._raycast.bind(controls);
  controls.__filteredRaycast = true;
  controls._raycast = (raycaster: THREE.Raycaster) => {
    const nav = getNav() ?? controls.scene ?? null;
    // the controls' raycaster keeps three's 1 m point threshold; the per-hit pixel rule above applies
    const cam = controls.camera, dom = controls.domElement;
    if (cam?.isPerspectiveCamera && dom) (raycaster as any).pointsPixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (dom.clientHeight || 1) * 15;
    const hit = pickPoint(raycaster, getContent(), nav);
    if (hit) return hit;
    const scene = controls.scene;
    controls.scene = EMPTY;
    try { return original(raycaster); } finally { controls.scene = scene; }
  };
}

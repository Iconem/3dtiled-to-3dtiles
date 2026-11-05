// The "shareable" state slice — synced to the browser's own address bar via nuqs, so a given view
// (format/mode/cache/params/url) is bookmarkable/shareable, matching the query-param-driven nature of
// the middleware endpoints themselves (?format=&cache=&prefetch=&transform=&url=). See the plan's
// "State" section. High-frequency/ephemeral state lives in ./store.ts (zustand) instead.
import { parseAsBoolean, parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import type { CacheScope, TilingMode, ToolName, ViewerMode } from '@/lib/middleware';

export type ActiveRenderer = 'cesium' | '3dtrjs';

// NOTE: the fully-resolved tileset URL (and the raw-url-mode toggle) deliberately live in the
// zustand store (./store.ts), NOT here. A resolved /stream URL nests its OWN query string inside a
// query value (…?format=copc&url=<encoded raw source>&cache=none…) — round-trippable via
// encodeURIComponent, but pushing that whole thing through ANOTHER layer of query-string
// serialization (nuqs → history.pushState → the browser's own URL parser) hit real, reproducible
// corruption in testing (nested `&`/`?` colliding with the outer param boundaries) and broke Vite's
// dev-server routing entirely. The preset id + these primitives already fully determine the URL on
// reload (TopBar re-derives and reloads it), so persisting the URL itself isn't needed for
// shareability anyway.
const urlStateParsers = {
  format: parseAsString.withDefault('copc'),
  mode: parseAsStringEnum<ViewerMode>(['stream', 'offline', 'tools']).withDefault('stream'),
  cache: parseAsStringEnum<CacheScope>(['none', 'hierarchy', 'all']).withDefault('none'),
  prefetch: parseAsInteger.withDefault(0),
  transform: parseAsString.withDefault(''),
  // Tileset-level op for the "3D Tiles" format group specifically — distinct from `transform` above
  // (a per-TILE glTF-Transform compression op that rides on /stream/tile requests). This instead picks
  // which /3dtiles-tools whole-tileset rewrite (if any) wraps the selected DIRECT preset's URL.
  tilesetOp: parseAsString.withDefault(''),
  centroids: parseAsBoolean.withDefault(false),
  tiling: parseAsStringEnum<TilingMode>(['implicit', 'explicit']).withDefault('implicit'),
  renderer: parseAsStringEnum<ActiveRenderer>(['cesium', '3dtrjs']).withDefault('3dtrjs'),
  tool: parseAsStringEnum<ToolName>(['implicit-to-explicit', 'upgrade', 'packages']).withDefault('implicit-to-explicit'),
  preset: parseAsString.withDefault(''),
  // 3DTRjs only: mosaic leaves in their source format (Potree via PotreePlugin) instead of /stream.
  native: parseAsBoolean.withDefault(true),
  // COPC on /stream (also every COPC child of a mosaic): points on the ellipsoid (proj4 → ECEF per
  // tile grid) instead of the tangent plane. auto = on past a 20 km extent.
  curved: parseAsStringEnum<'auto' | 'on' | 'off'>(['auto', 'on', 'off']).withDefault('auto'),
  // The camera: `lon,lat,height,heading,pitch,roll` (lib/cameraPose.ts), kept up to date as it moves, so a link opens
  // on the same view and a switch between two globes (Bing 3D, Google 3D) lands on the same place.
  view: parseAsString.withDefault(''),
};

/** One hook, one URL sync — everything in the "shareable" slice. */
export function useUrlState() {
  return useQueryStates(urlStateParsers, { history: 'replace' });
}

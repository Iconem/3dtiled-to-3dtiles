// Ported as pure functions from viewer.html's buildMiddlewareUrl/streamParams/assetUrl/srcUrl
// (lines ~694-797) — same algorithms, but read an explicit params object instead of globals.
import { MW, SDATA, FORMATS, DIRECT, TOOLS_DATASETS, PSEUDO_FORMATS, fmtMeta, canCentroids, type Asset, type AssetType, type FormatMeta } from './formats';

export type TilesetOp = 'implicit-to-explicit' | 'upgrade' | '';

export type ViewerMode = 'stream' | 'offline' | 'tools';
export type CacheScope = 'none' | 'hierarchy' | 'all';
export type TilingMode = 'implicit' | 'explicit';
export type ToolName = 'implicit-to-explicit' | 'upgrade' | 'packages';

export const isRemoteUrl = (s: string) => /^https?:\/\//i.test(s);
export const srcUrl = (s: string) => (isRemoteUrl(s) ? s : `${SDATA}/${s}`);

export interface MiddlewareParams {
  selectedFormat: string;
  viewerMode: ViewerMode;
  cacheScope: CacheScope;
  prefetchN: number;
  transformOp: string;
  centroidsOnly: boolean;
  tilingMode: TilingMode;
}

export function streamParams(f: FormatMeta | undefined, p: Pick<MiddlewareParams, 'tilingMode' | 'centroidsOnly' | 'selectedFormat'>) {
  let q = f?.octree ? `&tiling=${p.tilingMode}` : '';
  if (canCentroids(p.selectedFormat) && p.centroidsOnly) q += '&centroids=1';
  return q;
}

export function buildMiddlewareUrl(rawSrc: string, p: MiddlewareParams, fOverride?: FormatMeta) {
  const f = fOverride ?? fmtMeta(p.selectedFormat);
  const fmt = f ? f.fmt : p.selectedFormat;
  const enc = encodeURIComponent(rawSrc);
  if (p.cacheScope === 'all') return `${MW}/convert/tileset.json?format=${fmt}&url=${enc}${streamParams(f, p)}`;
  let q = `&cache=${p.cacheScope}`;
  if (p.cacheScope === 'none') q += `&prefetch=${p.prefetchN}`;
  if (p.transformOp) q += `&transform=${p.transformOp}`;
  return `${MW}/stream/tileset.json?format=${fmt}&url=${enc}${q}${streamParams(f, p)}`;
}

export function assetUrl(f: FormatMeta, a: Asset, p: MiddlewareParams): string | null {
  if (p.viewerMode === 'offline') {
    if (!a.out) return null;
    return `${SDATA}/${a.out}/tileset.json`;
  }
  if (p.viewerMode === 'stream') {
    if (!f.stream) return null;
    const rawSrc = srcUrl(p.cacheScope === 'all' ? a.src! : (a.streamSrc ?? a.src!));
    return buildMiddlewareUrl(rawSrc, p, f);
  }
  return null;
}

export interface Preset {
  id: string;
  label: string;
  type: AssetType;
  url: string | null;
  rawSrc?: string;
  custom?: boolean;
  octree?: boolean;
  flyTo?: { lon: number; lat: number; height: number };
}

/** Ported from viewer.html's currentPresets() — the asset-pill list for the current mode/format. */
export function currentPresets(p: MiddlewareParams & { toolName: ToolName; tilesetOp?: TilesetOp }): Preset[] {
  if (p.viewerMode === 'tools') {
    return (TOOLS_DATASETS[p.toolName] || []).map((a) => ({
      id: `tool-${p.toolName}-${a.id}`,
      label: a.label,
      type: a.type!,
      url:
        p.toolName === 'packages'
          ? `${MW}/3dtiles-self-contained/tileset.json?url=${encodeURIComponent(a.pkg!)}`
          : `${MW}/3dtiles-tools/tileset.json?tool=${encodeURIComponent(p.toolName)}&url=${encodeURIComponent(a.url!)}`,
    }));
  }
  if (p.selectedFormat === '3dtiles') {
    // Whole-tileset rewrite (implicit→explicit / legacy b3dm→1.1 upgrade) via the SAME generic
    // /3dtiles-tools endpoint the "Tools" mode pills already use — it already accepts an arbitrary
    // `url=`, not just the two hardcoded Tools presets, so any DIRECT tileset can be run through it.
    const wrap = (u: string) => (p.tilesetOp ? `${MW}/3dtiles-tools/tileset.json?tool=${p.tilesetOp}&url=${encodeURIComponent(u)}` : u);
    return DIRECT.map((d) => ({ id: d.id, label: `${d.icon} ${d.label}`, type: d.type, url: wrap(d.url) }));
  }
  if (p.selectedFormat === 'packages') {
    return (TOOLS_DATASETS['packages'] || []).map((a) => ({
      id: `fmt-pkg-${a.id}`,
      label: `📦 ${a.label}`,
      type: a.type!,
      url: `${MW}/stream/tileset.json?format=${a.pkg!.toLowerCase().endsWith('.3tz') ? '3tz' : '3dtiles-pkg'}&url=${encodeURIComponent(a.pkg!)}`,
    }));
  }
  if (p.selectedFormat === 'bing') {
    const bingUrl = `${MW}/bing/tileset.json?g=15530`;
    return [
      { id: 'bing-world', label: '🗺 Bing 3D — world (td1)', type: 'mesh', url: bingUrl },
      { id: 'bing-roma', label: '🗺 Bing 3D — Roma', type: 'mesh', url: bingUrl, flyTo: { lon: 12.4924, lat: 41.8902, height: 1200 } },
      { id: 'bing-washington', label: '🗺 Bing 3D — Washington', type: 'mesh', url: bingUrl, flyTo: { lon: -77.0353, lat: 38.8895, height: 1600 } },
      { id: 'bing-berlin', label: '🗺 Bing 3D — Berlin', type: 'mesh', url: bingUrl, flyTo: { lon: 13.3777, lat: 52.5163, height: 1200 } },
    ];
  }
  if (p.selectedFormat === 'threemx') {
    const tmx = (mdl: string) => `${MW}/stream/tileset.json?format=threemx&url=${encodeURIComponent(mdl)}`;
    return [
      { id: '3mx-tende', label: '🏛 Tende village (dept06, colormap)', type: 'mesh', url: tmx('https://3d.departement06.fr/3mx/2019_07_Village_Tende_Resolution/Scene/2019_07_Village_Tende_Resolution.3mx') },
      { id: '3mx-byu', label: '🏛 BYU Athletic (RGB)', type: 'mesh', url: tmx('https://campusmodel.groups.et.byu.net/Athletic_Buildings_3MX/Scene/Athletic_Buildings_3MX.3mx') },
      { id: '3mx-chapelle', label: '🏛 Chapelle (scanit, .3mxb)', type: 'mesh', url: tmx('https://www.scanit-alsace.fr/PARTAGE/CHAPELLE/Scene/Data/MESH.3mxb') },
    ];
  }
  if (p.selectedFormat === 'geosplats') {
    const gs = (mdl: string) => `${MW}/stream/tileset.json?format=geosplats&url=${encodeURIComponent(mdl)}&lod=5`;
    return [
      { id: 'gs-1', label: '✨ Jastrzębia Góra, Poland', type: 'splat', url: gs('https://api.maptiler.com/splats/019e67bf-b89b-743d-91dd-79f7f4b4bd4e/model.json?key=GKF1QdQ4MpjgqtKiQuxR') },
      { id: 'gs-2', label: '✨ Biltmore Hotel, Miami', type: 'splat', url: gs('https://api.maptiler.com/splats/019e5ff3-e23b-7063-bed2-c385d3e96d99/model.json?key=mNLmXyaTH4gRlwJHSYWp') },
    ];
  }
  const f = fmtMeta(p.selectedFormat);
  if (!f) return [];
  const pills: Preset[] = f.assets
    .map((a) => ({
      id: `${f.fmt}-${a.id}`,
      label: `${f.icon} ${a.label}`,
      type: f.type,
      url: assetUrl(f, a, p),
      octree: f.octree,
      rawSrc: srcUrl(a.streamSrc ?? a.src!),
    }))
    .filter((pr) => pr.url);
  pills.push({ id: `${f.fmt}-custom`, label: `${f.icon} ✎ custom url`, type: f.type, url: '__custom__', custom: true, octree: f.octree });
  return pills;
}

export { FORMATS, DIRECT, PSEUDO_FORMATS, fmtMeta, canCentroids };

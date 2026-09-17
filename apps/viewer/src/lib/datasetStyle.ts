/**
 * Per-dataset show/hide and colour for a loaded /aggregate mosaic — applied by the renderer to the
 * tiles already loaded, so the picker never has to reload the tileset.
 *
 * Every leaf of a mosaic carries 3D Tiles 1.1 tile metadata (class `dataset`, property `id`); a
 * content tile belongs to the dataset of its nearest ancestor with that id. Both renderers resolve it
 * the same way (walk `parent`), and cache it on the tile.
 */
import type { DatasetMarker } from './aggregate';
import { MARKER_COLORS } from '@/components/Viewport/DatasetTooltip';

export interface DatasetStyle {
  /** Dataset ids not to draw. */
  hidden: Set<string>;
  /** Dataset id → CSS colour to tint it with; null = the data's own colours. */
  colors: Map<string, string> | null;
}

/** How markers (and, for provider/dataset, the data itself) are coloured. */
export type ColorMode = 'format' | 'provider' | 'dataset';

const DS_ID = Symbol('datasetId');

/** The dataset a tile belongs to. `idOf` reads a tile's own metadata id (renderer-specific). */
export function tileDatasetId(tile: any, idOf: (t: any) => string | undefined): string | null {
  if (!tile) return null;
  if (tile[DS_ID] !== undefined) return tile[DS_ID];
  const own = idOf(tile);
  const id = own ?? tileDatasetId(tile.parent, idOf);
  tile[DS_ID] = id;
  return id;
}

/** Distinct, stable hues: golden-angle steps around the wheel. Comma syntax — Cesium and three both parse it. */
export const paletteColor = (i: number) => `hsl(${Math.round((i * 137.508) % 360)}, 80%, 58%)`;

const PROVIDER_COLORS: Record<string, string> = {
  Iconem: '#ef4444', Aerometrex: '#22c55e', Vexcel: '#3b82f6', Cesium: '#a78bfa',
};

/** Marker colour per dataset for a mode (providers without a fixed colour get palette hues, by name). */
export function markerColors(list: DatasetMarker[], mode: ColorMode): Map<string, string> {
  const out = new Map<string, string>();
  if (mode === 'format') {
    for (const d of list) out.set(d.id, MARKER_COLORS[d.format] ?? '#94a3b8');
    return out;
  }
  if (mode === 'provider') {
    const provs = [...new Set(list.map((d) => d.provider ?? ''))].sort();
    for (const d of list) {
      const p = d.provider ?? '';
      out.set(d.id, PROVIDER_COLORS[p] ?? (p ? paletteColor(provs.indexOf(p) + 3) : '#94a3b8'));
    }
    return out;
  }
  list.forEach((d, i) => out.set(d.id, paletteColor(i)));
  return out;
}

export const providerColor = (p: string, all: string[]) =>
  PROVIDER_COLORS[p] ?? (p ? paletteColor([...all].sort().indexOf(p) + 3) : '#94a3b8');

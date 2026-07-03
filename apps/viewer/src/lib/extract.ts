// Ported from viewer.html's extractCrop()/_extractModelMatrix() (lines ~1573-1607).
import { MW } from './formats';

export type ExtractKind = 'las' | 'copc' | 'glb' | 'splat' | 'zip';

export interface ExtractOptions {
  kind: ExtractKind;
  tilesetUrl: string; // the CURRENTLY LOADED tileset url (already resolved, not raw)
  bbox: [number, number, number, number, number, number]; // w,s,minH,e,n,maxH
  maxGE: number;
  lasStream?: boolean;
  enuFrame?: boolean;
  splatFormat?: string; // spz|glb|sog|ply
  splatClip?: boolean;
  extractMatrix?: number[] | null; // 16-array column-major, from ViewerHandle.getExtractMatrix()
}

/** Force an octree /stream source to explicit tiling + eager hierarchy (required for the extractor). */
export function forceExplicitHierarchy(src: string): string {
  if (!/\/stream\/tileset\.json/.test(src)) return src;
  let out = /tiling=implicit/.test(src) ? src.replace('tiling=implicit', 'tiling=explicit') : /tiling=/.test(src) ? src : `${src}&tiling=explicit`;
  out = /cache=/.test(out) ? out.replace(/cache=\w+/, 'cache=hierarchy') : `${out}&cache=hierarchy`;
  return out;
}

export function buildExtractUrl(o: ExtractOptions): string {
  const src = forceExplicitHierarchy(o.tilesetUrl);
  let extra = '';
  if (o.kind === 'las' && o.lasStream) extra += '&stream=1';
  if ((o.kind === 'las' || o.kind === 'copc') && o.enuFrame) extra += '&enu=1';
  if (o.kind === 'splat') {
    extra += `&format=${o.splatFormat || 'spz'}`;
    if (!o.splatClip) extra += '&clip=0';
  }
  if (o.extractMatrix && o.extractMatrix.length === 16) extra += `&matrix=${o.extractMatrix.join(',')}`;
  return `${MW}/extract/${o.kind}?url=${encodeURIComponent(src)}&bbox=${o.bbox.join(',')}&maxGE=${o.maxGE}${extra}`;
}

export function extractCrop(o: ExtractOptions) {
  const url = buildExtractUrl(o);
  window.open(url, '_blank');
  return url;
}

/** Server-side progress for cache=hierarchy/all loads — GET /progress?key=<url>. */
export async function fetchProgress(key: string): Promise<{ done: number; total: number; finished: boolean } | null> {
  try {
    const r = await fetch(`${MW}/progress?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

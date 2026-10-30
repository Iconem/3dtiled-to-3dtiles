/**
 * Hover card for an /aggregate dataset marker — shared by both renderers, which only report which
 * marker is under the cursor and where. Positioned in the viewport's own coordinates and never
 * catches the pointer, so it cannot steal the hover it is describing.
 *
 * Layout: a header (colour, name, where, format badge), a key/value grid of the facts that help
 * decide whether to fly there (extent, capture date, provider, licence), the mosaic internals in a
 * quieter row, and the click hint.
 */
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { DatasetMarker } from '@/lib/aggregate';

/** Pastel per-format colours (the 'format' colour mode) and the single default colour. */
export const MARKER_COLORS: Record<string, string> = { potree: '#f6c58a', copc: '#9fd6ee', '3dtiles': '#c9b8ec' };
export const UNIFORM_COLOR = '#8ed1dc';
export const MARKER_INACTIVE_COLOR = '#9ca3af';
/** The dark ring around every marker disc (both renderers). */
export const MARKER_RING_COLOR = '#1a1a22';

export const markerColor = (d: Pick<DatasetMarker, 'color' | 'format' | 'inactive'>) =>
  d.inactive ? MARKER_INACTIVE_COLOR : d.color ?? MARKER_COLORS[d.format] ?? UNIFORM_COLOR;

/** x/y: cursor in viewport pixels; w/h: the viewport's size (to flip the card near its edges). */
export interface MarkerHover { d: DatasetMarker; x: number; y: number; w: number; h: number }

/**
 * The hover changes on every mouse move; keeping that state HERE, fed through a ref, means only this
 * small component re-renders — not the whole viewer that owns the canvas.
 */
export type TooltipChannel = React.MutableRefObject<((h: MarkerHover | null) => void) | null>;

const extent = (r: number) => (r >= 500 ? `≈ ${(2 * r / 1000).toFixed(1)} km across` : `≈ ${Math.round(2 * r)} m across`);
const dateLabel = (s: string) => s.replace('/', ' → ');

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  if (v == null || v === '') return null;
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono text-[10px]' : ''}`}>{v}</dd>
    </>
  );
}

export default function DatasetTooltip({ channel, visible }: { channel: TooltipChannel; visible: boolean }) {
  const [hover, setHover] = useState<MarkerHover | null>(null);
  useEffect(() => {
    channel.current = setHover;
    return () => { channel.current = null; };
  }, [channel]);
  if (!hover || !visible) return null;
  const { d, x, y, w, h } = hover;
  const place = [d.scene && d.scene !== d.name ? d.scene : null, d.project && d.project !== d.scene ? d.project : null].filter(Boolean);
  const licence = d.licence?.replace(/\[License\]\((.*?)\)/, '$1');
  const snap = d.snap
    ? d.snap.dz == null ? 'no ground found' : `${d.snap.dz > 0 ? '+' : ''}${d.snap.dz} m on ${d.snap.terrain}${d.snap.bins ? ` (${d.snap.bins} bins)` : ''}`
    : null;
  return (
    <div
      className="pointer-events-none absolute z-30 w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover/95 text-popover-foreground shadow-xl backdrop-blur [overflow-wrap:anywhere]"
      // Right of and below the cursor; flipped back towards the centre near the right/bottom edges.
      style={{ left: x + 14, top: y + 14, transform: `translate(${x > 0.6 * w ? 'calc(-100% - 28px)' : '0'}, ${y > 0.7 * h ? 'calc(-100% - 28px)' : '0'})` }}
    >
      <div className="flex items-start gap-2 border-b px-3 py-2">
        <span className="mt-1 size-2.5 shrink-0 rounded-full ring-2 ring-background" style={{ background: markerColor(d) }} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">{d.name}</div>
          {place.length > 0 && <div className="mt-0.5 text-xs text-muted-foreground">{place.join(' · ')}</div>}
        </div>
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">{d.format === '3dtiles' ? '3D Tiles' : d.format}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
        <Row k="Extent" v={extent(d.radius)} />
        <Row k="Captured" v={d.date ? dateLabel(d.date) : null} />
        <Row k="Provider" v={d.attribution || d.provider} />
        <Row k="Licence" v={licence} />
        <Row k="State" v={d.inactive ? 'hidden by the picker' : null} />
      </dl>
      {(d.cell || snap) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          {d.cell && <Row k="Mosaic cell" v={`${d.cell.scheme} ${d.cell.key || '(root)'} · z${d.cell.level} · depth ${d.depth}`} mono />}
          <Row k="Snapped" v={snap} />
        </dl>
      )}
      <div className="border-t bg-muted/40 px-3 py-1 text-[10px] text-muted-foreground">Click to fly there</div>
    </div>
  );
}

/**
 * Hover card for an /aggregate dataset marker — shared by both renderers, which only report which
 * marker is under the cursor and where. Positioned in the viewport's own coordinates and never
 * catches the pointer, so it cannot steal the hover it is describing.
 */
import { useEffect, useState } from 'react';
import type { DatasetMarker } from '@/lib/aggregate';

export const MARKER_COLORS: Record<string, string> = { potree: '#f59e0b', copc: '#38bdf8', '3dtiles': '#a78bfa' };

/** x/y: cursor in viewport pixels; w/h: the viewport's size (to flip the card near its edges). */
export interface MarkerHover { d: DatasetMarker; x: number; y: number; w: number; h: number }

/**
 * The hover changes on every mouse move; keeping that state HERE, fed through a ref, means only this
 * small component re-renders — not the whole viewer that owns the canvas.
 */
export type TooltipChannel = React.MutableRefObject<((h: MarkerHover | null) => void) | null>;

export default function DatasetTooltip({ channel, visible }: { channel: TooltipChannel; visible: boolean }) {
  const [hover, setHover] = useState<MarkerHover | null>(null);
  useEffect(() => {
    channel.current = setHover;
    return () => { channel.current = null; };
  }, [channel]);
  if (!hover || !visible) return null;
  const { d, x, y, w, h } = hover;
  const place = [d.scene && d.scene !== d.name ? d.scene : null, d.project && d.project !== d.scene ? d.project : null].filter(Boolean);
  return (
    <div
      className="pointer-events-none absolute z-30 max-w-[320px] rounded-md border bg-popover/95 px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg backdrop-blur"
      // Right of and below the cursor; flipped back towards the centre near the right/bottom edges.
      style={{ left: x + 14, top: y + 14, transform: `translate(${x > 0.6 * w ? 'calc(-100% - 28px)' : '0'}, ${y > 0.7 * h ? 'calc(-100% - 28px)' : '0'})` }}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <span className="size-2 shrink-0 rounded-full" style={{ background: MARKER_COLORS[d.format] ?? '#94a3b8' }} />
        <span className="break-words">{d.name}</span>
      </div>
      {place.map((p) => <div key={p} className="text-muted-foreground break-words">{p}</div>)}
      <div className="mt-0.5 text-muted-foreground">
        {d.format}{d.date ? ` · ${d.date.replace('/', ' → ')}` : ''} · {d.radius >= 1000 ? `${(d.radius / 1000).toFixed(1)} km` : `${Math.round(d.radius)} m`}
        {d.inactive ? ' · hidden' : ''}
      </div>
      {(d.attribution || d.provider) && <div className="text-[10px] text-muted-foreground break-words">{d.attribution || d.provider}</div>}
      {d.licence && <div className="text-[10px] text-muted-foreground break-words">{d.licence.replace(/\[License\]\((.*?)\)/, '$1')}</div>}
      <div className="text-[10px] text-muted-foreground/70">click to fly there</div>
    </div>
  );
}

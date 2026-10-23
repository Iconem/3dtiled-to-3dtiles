/**
 * Per-level comparison chart — the "compare several tilesets at once" half of the explorer.
 *
 * Trees are small multiples (each needs its own space), but the per-level aggregates are directly
 * comparable, so they get OVERLAID on one shared axis. That is what makes questions like "does our
 * Potree stream really flatten out at level 4 while the same site in COPC keeps going?" answerable at
 * a glance instead of by reading two tables side by side.
 *
 * Deliberately no charting library: the data is a handful of short series indexed by an integer
 * level, so a scale is two multiplications, and hand-rolling it avoids adding a dependency whose
 * theming would then have to be reconciled with the app's tokens.
 */
import { useCallback, useMemo, useState } from 'react';

export interface LevelSeries {
  label: string;
  color: string;
  points: { level: number; value: number }[];
}

interface Props {
  series: LevelSeries[];
  /** Log scale is the right default for geometric error, which spans orders of magnitude. */
  log?: boolean;
  height?: number;
  valueFormat?: (v: number) => string;
}

// t:16 — the top gridline carries a label drawn above its own line, so a smaller top pad clips it.
const PAD = { l: 46, r: 10, t: 16, b: 20 };

export default function LevelChart({ series, log = false, height = 200, valueFormat = fmtCount }: Props) {
  const [hoverLevel, setHoverLevel] = useState<number | null>(null);
  const [width, setWidth] = useState(560);

  // Stable identity + explicit cleanup — see the same note in TilesetTree: an inline ref callback is
  // re-attached every render, leaking a ResizeObserver each time.
  const setWrap = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();                 // React 19 ref-cleanup
  }, []);

  const model = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (!all.length) return null;
    const maxLevel = Math.max(...all.map((p) => p.level));
    // Log axes cannot show zero; clamp the floor to the smallest positive value present so an
    // all-zero level drops out rather than collapsing the whole scale.
    const positives = all.map((p) => p.value).filter((v) => v > 0);
    const maxV = Math.max(...all.map((p) => p.value), 1);
    const minV = log ? Math.min(...(positives.length ? positives : [1])) : 0;

    const iw = Math.max(40, width - PAD.l - PAD.r);
    const ih = height - PAD.t - PAD.b;
    const x = (level: number) => PAD.l + (maxLevel === 0 ? iw / 2 : (level / maxLevel) * iw);
    const y = (v: number) => {
      if (!log) return PAD.t + ih - (v / maxV) * ih;
      const lo = Math.log10(Math.max(minV, 1e-6)), hi = Math.log10(Math.max(maxV, minV * 10));
      const t = (Math.log10(Math.max(v, minV)) - lo) / (hi - lo || 1);
      return PAD.t + ih - t * ih;
    };

    const paths = series.map((s) => {
      const pts = s.points.filter((p) => (log ? p.value > 0 : true)).sort((a, b) => a.level - b.level);
      return {
        ...s,
        d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.level).toFixed(1)},${y(p.value).toFixed(1)}`).join(''),
        dots: pts.map((p) => ({ cx: x(p.level), cy: y(p.value), ...p })),
      };
    });

    // Dedupe on the RENDERED label, not the value: a decade axis spanning 0.01–0.1 m formats both
    // ends to the same string at two significant figures, and stacking two identical labels on the
    // same pixel row is what made the geometric-error axis unreadable.
    const rawTicks = log ? logTicks(minV, maxV) : [0, 0.5, 1].map((f) => f * maxV);
    const seen = new Set<string>();
    const ticks = rawTicks.filter((t) => {
      const k = valueFormat(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return { x, y, maxLevel, ih, iw, paths, ticks };
  }, [series, width, height, log, valueFormat]);

  if (!model) return <div className="text-xs text-muted-foreground">no data</div>;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.target as SVGRectElement).getBoundingClientRect();
    const mx = e.clientX - box.left;
    const lvl = Math.round(((mx - PAD.l) / Math.max(1, model.iw)) * model.maxLevel);
    setHoverLevel(Math.max(0, Math.min(model.maxLevel, lvl)));
  };

  const hoverRows = hoverLevel == null ? [] : model.paths
    .map((s) => ({ label: s.label, color: s.color, p: s.points.find((q) => q.level === hoverLevel) }))
    .filter((r) => r.p);

  return (
    <div ref={setWrap} className="relative w-full">
      <svg width="100%" height={height} className="block">
        {model.ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={width - PAD.r} y1={model.y(t)} y2={model.y(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.l - 6} y={model.y(t) + 3} textAnchor="end" fontSize={9} className="fill-muted-foreground">
              {valueFormat(t)}
            </text>
          </g>
        ))}
        {hoverLevel != null && (
          <line x1={model.x(hoverLevel)} x2={model.x(hoverLevel)} y1={PAD.t} y2={PAD.t + model.ih}
                className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="3 3" />
        )}
        {model.paths.map((s) => (
          <g key={s.label}>
            <path d={s.d} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" />
            {s.dots.map((d) => <circle key={d.level} cx={d.cx} cy={d.cy} r={2.2} fill={s.color} />)}
          </g>
        ))}
        {/* x ticks: every level when there is room, otherwise thinned to ~1 per 34 px */}
        {Array.from({ length: model.maxLevel + 1 }, (_, l) => l)
          .filter((l) => l % Math.max(1, Math.ceil((model.maxLevel + 1) / Math.max(3, model.iw / 34))) === 0)
          .map((l) => (
            <text key={l} x={model.x(l)} y={height - 6} textAnchor="middle" fontSize={9} className="fill-muted-foreground">{l}</text>
          ))}
        <rect x={0} y={0} width="100%" height={height} fill="transparent"
              onPointerMove={onMove} onPointerLeave={() => setHoverLevel(null)} />
      </svg>
      {hoverLevel != null && hoverRows.length > 0 && (
        <div className="pointer-events-none absolute top-1 right-1 z-10 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md">
          <div className="mb-0.5 font-medium">Level {hoverLevel}</div>
          {hoverRows.map((r) => (
            <div key={r.label} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: r.color }} />
              <span className="text-muted-foreground">{r.label}</span>
              <span className="ml-auto pl-2 font-medium tabular-nums">{valueFormat(r.p!.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One tick per decade across the ACTUAL data range. Clamping the top to ≥1 (as an earlier version
 * did) invents decades the data never reaches, which on a sub-metre geometric-error axis produced
 * three ticks for a range that only spans one decade.
 */
function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(Math.max(min, 1e-6)));
  const hi = Math.ceil(Math.log10(Math.max(max, min * 10, 1e-6)));
  const out: number[] = [];
  for (let e = lo; e <= hi; e++) out.push(10 ** e);
  return out.length > 6 ? out.filter((_, i) => i % 2 === 0) : out;
}

export function fmtCount(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function fmtMeters(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}Mm`;
  if (v >= 1000) return `${(v / 1000).toFixed(0)}km`;
  if (v >= 1) return `${v.toFixed(0)}m`;
  // Leaf geometric errors are routinely centimetres; "0.010m" is both wider and harder to read at a
  // glance than "1cm", and two such values at 2 s.f. collide into the same label.
  if (v >= 0.01) return `${Math.round(v * 100)}cm`;
  return `${(v * 1000).toPrecision(2)}mm`;
}

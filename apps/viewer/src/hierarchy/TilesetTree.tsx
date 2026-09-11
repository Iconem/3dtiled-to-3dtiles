/**
 * Top-down tidy tree of a tileset's tile hierarchy.
 *
 * Layout comes from d3-hierarchy (Reingold–Tilford via `tree()`), drawing does NOT. A tileset walk
 * routinely returns 4 000 nodes, and four of those side by side would be ~32 000 SVG elements — React
 * reconciliation alone makes that unusable. Instead every link is concatenated into ONE <path>, and
 * nodes are batched into one <path> PER DEPTH LEVEL (so depth can still be colour-coded), which keeps
 * the tree at roughly 20 DOM nodes regardless of size while staying real, crisp, zoomable SVG.
 *
 * Hover is therefore not per-element: a transparent overlay captures pointer moves and finds the
 * nearest laid-out node by linear scan, which at these counts is far cheaper than 4 000 listeners.
 */
import { useCallback, useMemo, useState } from 'react';
import { hierarchy, tree as d3tree, type HierarchyPointNode } from 'd3-hierarchy';
import type { Stats, StatsNode } from './api';
import { depthColor } from './palette';

interface Props {
  stats: Stats;
  seriesIndex: number;
  dark: boolean;
  height?: number;
}

/** Stand-in parent used only when a walk yields several roots (external refs can do this). */
const FOREST_ROOT: StatsNode = { i: -1, p: -2, l: -1, ge: 0, r: 0, c: 0 };

type Pt = { x: number; y: number; n: StatsNode };

export default function TilesetTree({ stats, seriesIndex, dark, height = 340 }: Props) {
  const [hover, setHover] = useState<Pt | null>(null);
  const [width, setWidth] = useState(600);

  // Observe the card width so the tree reflows with the responsive grid rather than fixing a size.
  // useCallback + an explicit cleanup, not an inline callback: an inline ref changes identity on
  // every render, so React detaches and re-attaches it each time — which would construct a fresh
  // ResizeObserver per render and never disconnect the previous ones.
  const setWrap = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();                 // React 19 ref-cleanup
  }, []);

  const layout = useMemo(() => {
    const nodes = stats.nodes;
    if (!nodes.length) return null;

    const kids = new Map<number, StatsNode[]>();
    const roots: StatsNode[] = [];
    for (const n of nodes) {
      if (n.p < 0) roots.push(n);
      else {
        const arr = kids.get(n.p);
        if (arr) arr.push(n); else kids.set(n.p, [n]);
      }
    }
    const single = roots.length === 1;
    const root = hierarchy<StatsNode>(single ? roots[0] : FOREST_ROOT, (d) =>
      d === FOREST_ROOT ? roots : kids.get(d.i));

    const padX = 10, padTop = 12, padBottom = 16;
    const laid = d3tree<StatsNode>().size([Math.max(50, width - padX * 2), height - padTop - padBottom])(root);

    const pts: Pt[] = [];
    const byDepth = new Map<number, Pt[]>();
    let links = '';
    laid.each((d: HierarchyPointNode<StatsNode>) => {
      if (d.data === FOREST_ROOT) return;                       // synthetic node is layout-only
      const p: Pt = { x: d.x + padX, y: d.y + padTop, n: d.data };
      pts.push(p);
      const bucket = byDepth.get(d.data.l);
      if (bucket) bucket.push(p); else byDepth.set(d.data.l, [p]);
      const parent = d.parent;
      if (parent && parent.data !== FOREST_ROOT) {
        const px = parent.x + padX, py = parent.y + padTop, my = (py + p.y) / 2;
        links += `M${px.toFixed(1)},${py.toFixed(1)}C${px.toFixed(1)},${my.toFixed(1)} ${p.x.toFixed(1)},${my.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }
    });

    // One path per depth. A circle is two half-arcs; radius grows slightly for content tiles so
    // "has geometry" is visible without a second colour channel.
    const maxLevel = stats.maxDepth;
    const dense = pts.length > 1200;
    const levels = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) => {
      let d = '';
      for (const p of list) {
        const r = (p.n.c ? 2.6 : 1.5) * (dense ? 0.8 : 1);
        d += `M${(p.x - r).toFixed(1)},${p.y.toFixed(1)}a${r},${r} 0 1,0 ${(r * 2).toFixed(1)},0a${r},${r} 0 1,0 ${(-r * 2).toFixed(1)},0`;
      }
      return { level, d, fill: depthColor(seriesIndex, level, maxLevel, dark) };
    });

    // Level gridlines: one per depth, at that depth's own y (all siblings share it in a tidy tree).
    const rows = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) => ({ level, y: list[0].y }));

    return { pts, links, levels, rows };
  }, [stats, width, height, dark, seriesIndex]);

  if (!layout) return <div className="text-xs text-muted-foreground">no nodes</div>;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = (e.target as SVGRectElement).getBoundingClientRect();
    const mx = e.clientX - box.left, my = e.clientY - box.top;
    let best: Pt | null = null, bd = 18 * 18;
    for (const p of layout.pts) {
      const dx = p.x - mx, dy = p.y - my, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = p; }
    }
    setHover(best);
  };

  return (
    <div ref={setWrap} className="relative w-full">
      <svg width="100%" height={height} className="block overflow-visible">
        {layout.rows.map((r) => (
          <g key={r.level}>
            <line x1={0} x2="100%" y1={r.y} y2={r.y} className="stroke-border" strokeWidth={1} strokeDasharray="2 4" />
            <text x={2} y={r.y - 3} className="fill-muted-foreground" fontSize={9}>{r.level}</text>
          </g>
        ))}
        <path d={layout.links} fill="none" className="stroke-muted-foreground" strokeOpacity={0.35} strokeWidth={0.8} />
        {layout.levels.map((l) => <path key={l.level} d={l.d} fill={l.fill} />)}
        {hover && (
          <circle cx={hover.x} cy={hover.y} r={6} fill="none" className="stroke-foreground" strokeWidth={1.5} />
        )}
        <rect
          x={0} y={0} width="100%" height={height} fill="transparent"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(hover.x + 10, Math.max(0, width - 180)), top: hover.y + 10 }}
        >
          <div className="font-medium">
            Level {hover.n.l} · {hover.n.c ? 'has content' : 'structural'}
          </div>
          <div className="text-muted-foreground">geometric error {fmtNum(hover.n.ge)} m</div>
          <div className="text-muted-foreground">bounding radius {fmtNum(hover.n.r)} m</div>
        </div>
      )}
    </div>
  );
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return '—';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  if (n >= 1) return n.toFixed(1);
  return n.toPrecision(2);
}

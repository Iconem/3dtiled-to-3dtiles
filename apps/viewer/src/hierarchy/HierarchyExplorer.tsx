/**
 * Tileset hierarchy explorer — a React/shadcn front end for the tile-server's `/stats` walker.
 *
 * WHY IT EXISTS. Every source format this repo reads is already a spatial tree, and almost every
 * streaming bug is therefore a SHAPE bug: an octree that stops refining at level 4, a mosaic whose
 * root fans out to 500 children, a converter emitting one enormous leaf. Those are invisible in a 3D
 * viewport (the tiles that never load look exactly like tiles that don't exist) and obvious the
 * moment you draw the tree. The tile-server's own `/hierarchy` page shows ONE tileset; this shows
 * several at once, which is what turns "is this shallow?" into "shallower than what?".
 *
 * It is a separate Vite entry rather than a route inside the main app on purpose: the viewer pulls in
 * Cesium, three and SparkJS, none of which a graph page needs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MW, DOCS_URL, FORMATS } from '@/lib/formats';
import { fetchStats, labelForUrl, type Stats } from './api';
import { seriesColor } from './palette';
import TilesetTree from './TilesetTree';
import LevelChart, { fmtCount, fmtMeters, type LevelSeries } from './LevelChart';

interface Item {
  id: string;
  url: string;
  label: string;
  status: 'loading' | 'ok' | 'error';
  stats?: Stats;
  error?: string;
}

/**
 * Ready-made 3D Tiles endpoints that need no conversion — public open data, plus this repo's own
 * aggregates. These go first because they are the fastest way to see the tool do something, and
 * because comparing a hand-built city mesh against a streamed point cloud is the actual use case.
 */
const DIRECT_PRESETS = [
  { key: 'agg:world', label: '★ /aggregate?set=world — 33 tilesets, 4 continents', url: `${MW}/aggregate/tileset.json?set=world&nest=geodetic` },
  { key: 'agg:opendata', label: '★ /aggregate?set=opendata — 10 open datasets', url: `${MW}/aggregate/tileset.json?set=opendata&nest=geodetic` },
  { key: 'agg:angkor', label: '★ /aggregate?set=angkor — 23 Iconem Angkor sites', url: `${MW}/aggregate/tileset.json?set=angkor&nest=geodetic` },
  { key: 'agg:angkor-merc', label: '★ same, nest=mercator (compare the seams)', url: `${MW}/aggregate/tileset.json?set=angkor&nest=mercator` },
  { key: 'angkor:merged', label: '◆ Angkor merged — Iconem hand-authored root', url: 'https://api.iconem.com/s/is52XRiz30fn30HPjbgGe-KrydjSA3r0/81a079e7-920a-41da-9572-66eba2557b9a.json' },
];

/** Middleware presets, derived from the viewer's own format table so they cannot drift apart. */
const FORMAT_PRESETS = FORMATS.flatMap((f) =>
  f.assets
    .filter((a) => a.src && /^https?:\/\//i.test(a.src))
    .slice(0, 4)
    .map((a) => ({
      key: `${f.fmt}:${a.id}`,
      label: `${f.icon} ${f.label} — ${a.label}`,
      url: `${MW}/stream/tileset.json?format=${f.fmt}&url=${encodeURIComponent(a.src!)}&cache=none`,
    })),
);

const PRESETS = [...DIRECT_PRESETS, ...FORMAT_PRESETS];

const NODE_BUDGETS = ['2000', '4000', '10000', '20000'];
const SAMPLE_SIZES = ['0', '6', '12', '24'];
// 'auto' = the server default (32). A hard cap is the fastest way to make a deep tileset legible:
// the graphs stop at the chosen level instead of burying the top of the tree under 4 000 leaves.
const DEPTH_CAPS = ['auto', '3', '5', '8', '12', '16', '24'];
// LoD-chain formats (RAD) hit this long before the node budget — see the docs on truncatedBy.
const EXTERNAL_CAPS = ['64', '256', '1024'];

const TRUNCATION_HINT: Record<string, string> = {
  nodes: 'raise the node budget',
  depth: 'raise the depth cap',
  external: 'raise the external-tileset cap',
};

let seq = 0;

export default function HierarchyExplorer() {
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [maxNodes, setMaxNodes] = useState('4000');
  const [maxDepth, setMaxDepth] = useState('auto');
  const [maxExternal, setMaxExternal] = useState('64');
  const [sample, setSample] = useState('0');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  // Guards the one-shot restore below: without it, React 19 StrictMode's double-invoked effect loads
  // every URL from the query string twice.
  const restored = useRef(false);

  interface Opts { maxNodes: string; maxDepth: string; maxExternal: string; sample: string }

  /** Fetch one tileset's stats into `items`, replacing `reuseId` in place when reloading. */
  const load = useCallback(async (url: string, o: Opts, reuseId?: string) => {
    const id = reuseId ?? `t${seq++}`;
    setItems((prev) => reuseId
      ? prev.map((it) => (it.id === id ? { ...it, status: 'loading', error: undefined } : it))
      : [...prev, { id, url, label: labelForUrl(url), status: 'loading' }]);
    try {
      const stats = await fetchStats(url, {
        maxNodes: Number(o.maxNodes),
        maxDepth: o.maxDepth === 'auto' ? undefined : Number(o.maxDepth),
        maxExternal: Number(o.maxExternal),
        sample: Number(o.sample),
      });
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'ok', stats } : it)));
    } catch (e) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'error', error: String((e as Error).message ?? e) } : it)));
    }
  }, []);

  const opts: Opts = { maxNodes, maxDepth, maxExternal, sample };

  // Restore a shared comparison from the query string.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const q = new URLSearchParams(location.search);
    const restoredOpts: Opts = {
      maxNodes: q.get('maxNodes') ?? '4000',
      maxDepth: q.get('maxDepth') ?? 'auto',
      maxExternal: q.get('maxExternal') ?? '64',
      sample: q.get('sample') ?? '0',
    };
    setMaxNodes(restoredOpts.maxNodes);
    setMaxDepth(restoredOpts.maxDepth);
    setMaxExternal(restoredOpts.maxExternal);
    setSample(restoredOpts.sample);
    for (const u of q.getAll('url')) load(u, restoredOpts);
  }, [load]);

  // Keep the address bar in sync so a comparison is shareable — the whole point of loading several.
  useEffect(() => {
    const q = new URLSearchParams();
    for (const it of items) q.append('url', it.url);
    if (maxNodes !== '4000') q.set('maxNodes', maxNodes);
    if (maxDepth !== 'auto') q.set('maxDepth', maxDepth);
    if (maxExternal !== '64') q.set('maxExternal', maxExternal);
    if (sample !== '0') q.set('sample', sample);
    history.replaceState(null, '', q.toString() ? `?${q}` : location.pathname);
  }, [items, maxNodes, maxDepth, maxExternal, sample]);

  /**
   * Re-walk everything with the current options. Explicit rather than automatic: each reload is N
   * server walks over remote hosts, so firing one on every dropdown change would hammer them while
   * the user is still picking settings.
   */
  const reloadAll = () => { for (const it of items) load(it.url, opts, it.id); };

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('3d-tiled-theme', next ? 'dark' : 'light');
  };

  const ready = items.filter((it) => it.stats);

  const breadth = useMemo<LevelSeries[]>(() => ready.map((it) => ({
    label: it.label,
    color: seriesColor(indexOf(items, it), dark),
    points: it.stats!.levels.map((L) => ({ level: L.level, value: L.tiles })),
  })), [ready, items, dark]);

  const leaves = useMemo<LevelSeries[]>(() => ready.map((it) => ({
    label: it.label,
    color: seriesColor(indexOf(items, it), dark),
    points: it.stats!.levels.map((L) => ({ level: L.level, value: L.leaves })),
  })), [ready, items, dark]);

  const geo = useMemo<LevelSeries[]>(() => ready.map((it) => ({
    label: it.label,
    color: seriesColor(indexOf(items, it), dark),
    points: it.stats!.levels.map((L) => ({ level: L.level, value: L.geMax })),
  })), [ready, items, dark]);

  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    load(v, opts);
  };

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4 p-5">
        <header className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">Tileset hierarchy explorer</h1>
            <p className="text-xs text-muted-foreground">
              Depth, breadth, leaf counts and geometric-error distribution for any 3D Tiles endpoint —
              several at once, from <code className="text-[11px]">/stats</code>.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={toggleTheme}>{dark ? '☀ Light' : '☾ Dark'}</Button>
          <Button variant="ghost" size="sm" asChild><a href="/">← Viewer</a></Button>
          <Button variant="ghost" size="sm" asChild><a href={`${MW}/playground`} target="_blank" rel="noreferrer">API playground</a></Button>
          <Button variant="ghost" size="sm" asChild><a href={`${DOCS_URL}/guide/hierarchy-explorer`} target="_blank" rel="noreferrer">Docs</a></Button>
        </header>

        <Card>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="tileset.json URL — or a middleware URL like /stream/tileset.json?url=…&format=potree"
                className="min-w-[320px] flex-1"
              />
              <Button onClick={submit}>Add</Button>
              <Select value="" onValueChange={(v) => load(v, opts)}>
                <SelectTrigger className="w-[290px]"><SelectValue placeholder="Add a preset…" /></SelectTrigger>
                <SelectContent className="max-h-[420px]">
                  {PRESETS.map((p) => <SelectItem key={p.key} value={p.url}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={maxNodes} onValueChange={setMaxNodes}>
                <SelectTrigger className="w-[135px]"><SelectValue /></SelectTrigger>
                <SelectContent>{NODE_BUDGETS.map((n) => <SelectItem key={n} value={n}>{fmtCount(Number(n))} nodes</SelectItem>)}</SelectContent>
              </Select>
              <Select value={maxDepth} onValueChange={setMaxDepth}>
                <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEPTH_CAPS.map((n) => (
                    <SelectItem key={n} value={n}>{n === 'auto' ? 'no depth cap' : `stop at level ${n}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={maxExternal} onValueChange={setMaxExternal}>
                <SelectTrigger className="w-[165px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXTERNAL_CAPS.map((n) => <SelectItem key={n} value={n}>{n} external refs</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={sample} onValueChange={setSample}>
                <SelectTrigger className="w-[165px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SAMPLE_SIZES.map((n) => (
                    <SelectItem key={n} value={n}>{n === '0' ? 'no content sample' : `sample ${n} tiles`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {items.length > 0 && <Button variant="secondary" onClick={reloadAll}>Reload all</Button>}
              {items.length > 0 && <Button variant="ghost" onClick={() => setItems([])}>Clear</Button>}
              <span className="text-xs text-muted-foreground">
                Options apply to newly added tilesets — press <em>Reload all</em> to re-walk the ones already loaded.
              </span>
            </div>
            {sample !== '0' && (
              <p className="text-xs text-muted-foreground">
                Content sampling downloads {sample} tiles per tileset and reads only their GLB JSON chunk —
                triangle/point counts, extensions and compression are declared there, so nothing is decoded.
                The structural walk itself never fetches geometry.
              </p>
            )}
            {items.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {items.map((it, i) => (
                  <Badge key={it.id} variant="outline" className="gap-1.5 py-1">
                    <span className="inline-block size-2 rounded-full" style={{ background: seriesColor(i, dark) }} />
                    <span className="max-w-[260px] truncate">{it.label}</span>
                    {it.status === 'loading' && <span className="text-muted-foreground">walking…</span>}
                    {it.status === 'error' && <span className="text-destructive">failed</span>}
                    <button
                      className="ml-1 text-muted-foreground hover:text-foreground"
                      onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                      aria-label={`Remove ${it.label}`}
                    >×</button>
                  </Badge>
                ))}
              </div>
            )}
            {items.filter((it) => it.status === 'error').map((it) => (
              <p key={it.id} className="text-xs text-destructive">{it.label}: {it.error}</p>
            ))}
          </CardContent>
        </Card>

        {ready.length === 0 && (
          <Card><CardContent>
            <p className="text-sm text-muted-foreground">
              Nothing loaded yet. Add a preset above, or paste any <code>tileset.json</code> URL —
              local, remote, or one of this server's own <code>/stream</code>, <code>/convert</code>,
              <code>/bing</code> or <code>/aggregate</code> endpoints.
            </p>
          </CardContent></Card>
        )}

        {ready.length > 0 && (
          <>
            <Card>
              <CardHeader><CardTitle>Comparison</CardTitle></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tileset</TableHead>
                      <TableHead className="text-right">Tiles</TableHead>
                      <TableHead className="text-right">With content</TableHead>
                      <TableHead className="text-right">Leaves</TableHead>
                      <TableHead className="text-right">Max depth</TableHead>
                      <TableHead className="text-right">Max fanout</TableHead>
                      <TableHead className="text-right">Subtrees</TableHead>
                      <TableHead className="text-right">External</TableHead>
                      <TableHead className="text-right">Root GE</TableHead>
                      <TableHead>Walk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ready.map((it) => {
                      const s = it.stats!;
                      return (
                        <TableRow key={it.id}>
                          <TableCell className="max-w-[280px] truncate">
                            <span className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: seriesColor(indexOf(items, it), dark) }} />
                            {it.label}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCount(s.totalNodes)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCount(s.contentNodes)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCount(s.leafNodes)}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.maxDepth}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.maxFanout}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.subtreesFetched}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.externalTilesets}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.tilesetGeometricError == null ? '—' : fmtMeters(s.tilesetGeometricError)}</TableCell>
                          <TableCell>
                            {s.truncated
                              // Name the budget that stopped it — "truncated" alone sends you to
                              // raise the node cap even when the walk ran out of external refs.
                              ? <Badge variant="destructive" title={(s.truncatedBy ?? []).map((r) => TRUNCATION_HINT[r] ?? r).join(' · ')}>
                                  stopped: {(s.truncatedBy ?? ['budget']).join(' + ')}
                                </Badge>
                              : <Badge variant="secondary">complete</Badge>}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <p className="text-xs text-muted-foreground">
                  A “stopped:” badge means the walk hit a budget, so every count is a lower bound —
                  <strong> nodes</strong> = raise the node budget, <strong>depth</strong> = raise the
                  depth cap, <strong>external</strong> = raise the external-tileset cap (LoD-chain
                  formats like RAD exhaust that one long before the node budget).
                </p>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Breadth per level</CardTitle>
                  <p className="text-xs text-muted-foreground">Tiles at each depth. A healthy octree roughly quadruples per level; a line that flattens early is a truncated hierarchy.</p>
                </CardHeader>
                <CardContent><LevelChart series={breadth} /></CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Leaves per level</CardTitle>
                  <p className="text-xs text-muted-foreground">Where refinement actually stops. Leaves spread over many levels mean adaptive depth; all leaves on one level means a fixed-depth tiler.</p>
                </CardHeader>
                <CardContent><LevelChart series={leaves} /></CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Geometric error by level</CardTitle>
                  <p className="text-xs text-muted-foreground">Max GE per level, log scale. Should halve per level; a flat run means tiles compete at the same screen-space error.</p>
                </CardHeader>
                <CardContent><LevelChart series={geo} log valueFormat={fmtMeters} /></CardContent>
              </Card>
            </div>

            <div className={ready.length > 1 ? 'grid gap-4 xl:grid-cols-2' : ''}>
              {ready.map((it) => (
                <Card key={it.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <span className="inline-block size-2 rounded-full" style={{ background: seriesColor(indexOf(items, it), dark) }} />
                      <span className="truncate normal-case">{it.label}</span>
                    </CardTitle>
                    <p className="truncate text-[11px] text-muted-foreground" title={it.url}>{it.url}</p>
                  </CardHeader>
                  <CardContent>
                    <TilesetTree stats={it.stats!} seriesIndex={indexOf(items, it)} dark={dark} />
                    <p className="text-xs text-muted-foreground">
                      Rows = depth · larger dots have content · hover for geometric error and bounding radius
                    </p>
                    {it.stats!.content && <ContentPanel stats={it.stats!} />}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Stable colour identity: a series keeps its hue when an earlier tileset is removed. */
function indexOf(items: Item[], it: Item): number {
  return items.findIndex((x) => x.id === it.id);
}

function ContentPanel({ stats }: { stats: Stats }) {
  const c = stats.content!;
  const chips = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Content sample — {c.decoded}/{c.sampled} tiles read ({c.leavesSampled} leaves)
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="avg triangles" value={fmtCount(c.avgTriangles)} />
        <Stat label="avg points/splats" value={fmtCount(c.avgPoints)} />
        <Stat label="avg vertices" value={fmtCount(c.avgVertices)} />
        <Stat label="avg tile size" value={`${(c.avgBytes / 1024).toFixed(0)} KB`} />
      </div>
      {[['glTF extensions', c.extensions], ['compression', c.compression], ['textures', c.textures]].map(([title, map]) => {
        const entries = chips(map as Record<string, number>);
        if (!entries.length) return null;
        return (
          <div key={title as string} className="mt-2">
            <div className="mb-1 text-[11px] text-muted-foreground">{title as string}</div>
            <div className="flex flex-wrap gap-1">
              {entries.map(([k, n]) => <Badge key={k} variant="secondary">{k} ×{n}</Badge>)}
            </div>
          </div>
        );
      })}
      {c.decoded < c.sampled && (
        <p className="mt-2 text-xs text-destructive">
          {c.sampled - c.decoded} sampled tile(s) failed to read — e.g.{' '}
          {c.perTile.find((t) => !t.ok)?.reason ?? 'unknown'}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

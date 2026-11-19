import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import { extractCrop, type ExtractKind } from '@/lib/extract';
import { runBrowserExtract, canStreamToDisk, BROWSER_SPLAT_FORMATS, type BrowserExtractKind } from '@/lib/browserExtract';
import { buildMiddlewareUrl, type MiddlewareParams } from '@/lib/middleware';
import { MW, type AssetType } from '@/lib/formats';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

export default function CropExtractSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;
  const currentType = useViewerStore((st) => st.currentType);
  // Which extract format group to show — defaults to whatever's actually loaded (pointcloud: potree/
  // copc, mesh: 3dtiles/i3s/3mx/bing, splat: rad/sog/lcc/geosplats) but stays user-overridable, since a
  // format like 3D Tiles can itself contain mesh, point-cloud, OR splat content. Only snaps back to the
  // loaded type on a NEW load (currentType changing), not every render, so an override sticks.
  const [family, setFamily] = useState<AssetType>(currentType);
  useEffect(() => setFamily(currentType), [currentType]);

  // Where the extract runs. The tile server's /extract is the default; without a reachable server (a statically
  // hosted viewer) the browser is, and it is offered either way. Asked once, when the section mounts.
  const inBrowser = s.extractWhere === 'browser';
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${MW}/openapi.json`, { method: 'HEAD' }).then((r) => r.ok, () => false).then((ok) => {
      if (!alive) return;
      setServerUp(ok);
      if (!ok) useViewerStore.getState().setExtractWhere('browser');
    });
    return () => { alive = false; };
  }, []);
  // A browser extract in progress: what it has done so far, and how to stop it.
  const [running, setRunning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const params: MiddlewareParams = {
    selectedFormat: url.format, viewerMode: url.mode, cacheScope: url.cache,
    prefetchN: url.prefetch, transformOp: url.transform, centroidsOnly: url.centroids, tilingMode: url.tiling, shDegree: url.sh,
  };

  function resolvedTilesetUrl(): string | null {
    const field = s.urlField.trim();
    if (!field) { s.setStatus('Load a tileset first.'); return null; }
    return s.rawUrlMode && !field.startsWith(MW) ? buildMiddlewareUrl(field, params) : field;
  }

  async function doBrowserExtract(kind: BrowserExtractKind, tilesetUrl: string, bbox: [number, number, number, number, number, number], heading: number, extractMatrix: number[] | null) {
    if (running) return;
    const ctl = new AbortController(); abortRef.current = ctl;
    const t0 = performance.now();
    setRunning('starting…');
    s.tlog(`⬇ extract ${kind} in the browser (GE ${s.maxGE})…`);
    try {
      const r = await runBrowserExtract(
        { kind, tilesetUrl, bbox, heading, maxGE: s.maxGE, enuFrame: s.enuFrame, splatFormat: s.splatFormat, splatClip: s.splatClip, extractMatrix },
        { signal: ctl.signal, onProgress: (p) => setRunning(Object.entries(p).filter(([k]) => k !== 'pass').map(([k, v]) => `${Number(v).toLocaleString()} ${k}`).join(', ') + (p.pass === 'count' ? ' (counting)' : '')) },
      );
      if (!r) { s.tlog('extract cancelled'); return; }
      const what = Object.entries(r.stats).filter(([k]) => k !== 'bytes').map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ');
      const skipped = r.skipped ? ` · ${r.skipped} tiles skipped (${r.firstSkip})` : '';
      s.tlog(`✓ ${r.fileName}: ${what} in ${((performance.now() - t0) / 1000).toFixed(1)} s${skipped}`);
      s.setStatus(`Extract written: ${r.fileName} (${what})${skipped}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      s.tlog(`✗ extract failed: ${msg}`); s.setStatus(`Extract failed: ${msg}`);
    } finally { abortRef.current = null; setRunning(null); }
  }

  function doExtract(kind: ExtractKind) {
    const tilesetUrl = resolvedTilesetUrl();
    if (!tilesetUrl) return;
    const { w, s: sN, minH, e, n, maxH } = s.crop;
    const heading = Number.isFinite(s.crop.heading) ? s.crop.heading : 0;
    if ([w, sN, minH, e, n, maxH].some(Number.isNaN)) { s.setStatus('Set the crop box first (⬚ Set box to view).'); return; }
    const extractMatrix = h()?.getExtractMatrix() ?? null;
    if (inBrowser && kind !== 'copc') { void doBrowserExtract(kind, tilesetUrl, [w, sN, minH, e, n, maxH], heading, extractMatrix); return; }
    const outUrl = extractCrop({
      kind, tilesetUrl, bbox: [w, sN, minH, e, n, maxH], heading, maxGE: s.maxGE,
      lasStream: s.lasStream, enuFrame: s.enuFrame, splatFormat: s.splatFormat, splatClip: s.splatClip, extractMatrix,
    });
    s.tlog(`⬇ extract ${kind} (GE ${s.maxGE}) — download starting…`);
    void outUrl;
  }

  function setToView() {
    const bbox = h()?.setCropToView();
    if (bbox) {
      s.setStatus('Crop box set from current view.');
      // Populating the numbers without also showing the box left users wondering where it went
      // ("set box to view does things, but is not shown") — turn the 3D gizmo on to match.
      if (url.renderer === '3dtrjs' && !s.cropGizmoOn) { s.setCropGizmoOn(true); h()?.showCropGizmo?.(); }
    }
  }

  return (
    <SidebarCollapsibleSection title="Crop & Extract" defaultOpen={false}>
        <Button size="sm" variant="outline" onClick={setToView}>⬚ Set box to view (80%)</Button>
        <div className="flex items-center justify-between">
          <Label className="text-xs">max GE (m)</Label>
          <Input type="number" className="h-7 w-24" value={s.maxGE} onChange={(e) => s.setMaxGE(parseFloat(e.target.value) || 0)} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Label className="w-16 text-xs">W / E (°)</Label>
          <Input type="number" className="h-7" value={Number.isNaN(s.crop.w) ? '' : s.crop.w} onChange={(e) => s.setCrop({ w: parseFloat(e.target.value) })} />
          <Input type="number" className="h-7" value={Number.isNaN(s.crop.e) ? '' : s.crop.e} onChange={(e) => s.setCrop({ e: parseFloat(e.target.value) })} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Label className="w-16 text-xs">S / N (°)</Label>
          <Input type="number" className="h-7" value={Number.isNaN(s.crop.s) ? '' : s.crop.s} onChange={(e) => s.setCrop({ s: parseFloat(e.target.value) })} />
          <Input type="number" className="h-7" value={Number.isNaN(s.crop.n) ? '' : s.crop.n} onChange={(e) => s.setCrop({ n: parseFloat(e.target.value) })} />
        </div>
        <div className="flex items-center justify-between gap-1">
          <Label className="w-24 shrink-0 text-xs">minH / maxH (m)</Label>
          <Input type="number" className="h-7" value={s.crop.minH} onChange={(e) => s.setCrop({ minH: parseFloat(e.target.value) })} />
          <Input type="number" className="h-7" value={s.crop.maxH} onChange={(e) => s.setCrop({ maxH: parseFloat(e.target.value) })} />
        </div>
        <div className="flex items-center justify-between gap-1" title="Turns the box about its centre, clockwise from north, for a street or a building that does not run north-south. The numbers above are the box before it is turned. With the 3D gizmo: rotate it (R).">
          <Label className="w-24 shrink-0 text-xs">Heading (°)</Label>
          <Input type="number" className="h-7" step={1} value={s.crop.heading || 0} onChange={(e) => s.setCrop({ heading: parseFloat(e.target.value) || 0 })} />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={s.extractWhere} onValueChange={(v) => v && s.setExtractWhere(v as 'server' | 'browser')}
          title="Where the extract runs. Tile server: every output, any size. Browser: no server needed, the file is written by this page (LAS, GLB, SPZ/PLY/GLB splats, zip); no COPC">
          <ToggleGroupItem value="server" className="h-7 flex-1 text-xs" disabled={serverUp === false} title={serverUp === false ? 'No tile server reachable' : undefined}>Tile server</ToggleGroupItem>
          <ToggleGroupItem value="browser" className="h-7 flex-1 text-xs">In the browser</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" value={family} onValueChange={(v) => v && setFamily(v as AssetType)}
          title="Extract output family — defaults to the loaded asset's type, but e.g. 3D Tiles can hold mesh, point-cloud, or splat content">
          <ToggleGroupItem value="pointcloud" className="h-7 flex-1 text-xs">Pointcloud</ToggleGroupItem>
          <ToggleGroupItem value="mesh" className="h-7 flex-1 text-xs">Mesh</ToggleGroupItem>
          <ToggleGroupItem value="splat" className="h-7 flex-1 text-xs">Splat</ToggleGroupItem>
        </ToggleGroup>
        {family === 'pointcloud' && (
          <>
            {!inBrowser && (
              <Label className="text-xs" title="LAS: disk-free out-of-core streaming">
                <Checkbox checked={s.lasStream} onCheckedChange={(v) => s.setLasStream(!!v)} />
                LAS disk-free stream (2-pass)
              </Label>
            )}
            <Label className="text-xs" title="LAS/COPC: local ENU frame instead of ECEF">
              <Checkbox checked={s.enuFrame} onCheckedChange={(v) => s.setEnuFrame(!!v)} />
              LAS local ENU frame (else ECEF)
            </Label>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => doExtract('las')}>⬇ LAS</Button>
              <Button size="sm" variant="outline" disabled={inBrowser} title={inBrowser ? 'COPC is made by PDAL on the tile server' : undefined} onClick={() => doExtract('copc')}>⬇ COPC</Button>
            </div>
          </>
        )}
        {family === 'mesh' && (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => doExtract('glb')}>⬇ GLB</Button>
          </div>
        )}
        {family === 'splat' && (
          <>
            <div className="flex items-center gap-1">
              <Select value={s.splatFormat} onValueChange={s.setSplatFormat}>
                <SelectTrigger size="sm" className="w-20"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="spz">SPZ</SelectItem>
                  <SelectItem value="glb">GLB</SelectItem>
                  <SelectItem value="sog">SOG</SelectItem>
                  <SelectItem value="ply">PLY</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => doExtract('splat')}>⬇ Splat</Button>
            </div>
            <Label className="text-xs" title="Drop splats whose centroid falls outside the box">
              <Checkbox checked={s.splatClip} onCheckedChange={(v) => s.setSplatClip(!!v)} />
              Splat: clip splats outside box
            </Label>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => doExtract('zip')}>⬇ ZIP (bundle)</Button>
        {running && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-muted-foreground" title={running}>⏳ {running}</span>
            <Button size="sm" variant="outline" className="h-6 shrink-0" onClick={() => abortRef.current?.abort()}>Cancel</Button>
          </div>
        )}
        {url.renderer === '3dtrjs' && (
          <Button size="sm" variant={s.cropGizmoOn ? 'default' : 'outline'} onClick={() => { const on = !s.cropGizmoOn; s.setCropGizmoOn(on); if (on) h()?.showCropGizmo?.(); else h()?.hideCropGizmo?.(); }}>
            ⬚ 3D box gizmo (3DTRJS)
          </Button>
        )}
        {url.renderer === '3dtrjs' && (s.cropGizmoOn || s.tilesetGizmoOn) && (
          // drei's TransformControls only ever does ONE of translate/rotate/scale at a time — W/E/R
          // keyboard shortcuts exist in plain three.js apps, but this canvas has no keyboard-focus
          // story, so it needs an explicit control. Shared between the crop-box and tileset-placement
          // gizmos (only one is normally on at a time anyway).
          <div className="flex gap-1" title="Gizmo mode — only one of translate/rotate/scale is active at a time">
            {(['translate', 'rotate', 'scale'] as const).map((m) => (
              <Button key={m} size="sm" variant={s.gizmoMode === m ? 'default' : 'outline'} onClick={() => s.setGizmoMode(m)}>
                {m === 'translate' ? '✥ T' : m === 'rotate' ? '↻ R' : '⤢ S'}
              </Button>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Extracts the loaded tileset within the box. Octree sources are fetched as explicit tiling.
          {inBrowser && (canStreamToDisk()
            ? ' In the browser: you pick the file, and it is written tile by tile.'
            : ' In the browser: built in memory and downloaded, up to 1 GB (Chrome and Edge write straight to disk).')}
        </p>
    </SidebarCollapsibleSection>
  );
}

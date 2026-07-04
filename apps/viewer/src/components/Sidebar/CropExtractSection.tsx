import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import { extractCrop, type ExtractKind } from '@/lib/extract';
import { buildMiddlewareUrl, type MiddlewareParams } from '@/lib/middleware';
import { MW } from '@/lib/formats';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarSection } from './SidebarSection';

export default function CropExtractSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;

  const params: MiddlewareParams = {
    selectedFormat: url.format, viewerMode: url.mode, cacheScope: url.cache,
    prefetchN: url.prefetch, transformOp: url.transform, centroidsOnly: url.centroids, tilingMode: url.tiling,
  };

  function resolvedTilesetUrl(): string | null {
    const field = s.urlField.trim();
    if (!field) { s.setStatus('Load a tileset first.'); return null; }
    return s.rawUrlMode && !field.startsWith(MW) ? buildMiddlewareUrl(field, params) : field;
  }

  function doExtract(kind: ExtractKind) {
    const tilesetUrl = resolvedTilesetUrl();
    if (!tilesetUrl) return;
    const { w, s: sN, minH, e, n, maxH } = s.crop;
    if ([w, sN, minH, e, n, maxH].some(Number.isNaN)) { s.setStatus('Set the crop box first (⬚ Set box to view).'); return; }
    const extractMatrix = h()?.getExtractMatrix() ?? null;
    const outUrl = extractCrop({
      kind, tilesetUrl, bbox: [w, sN, minH, e, n, maxH], maxGE: s.maxGE,
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
    <SidebarSection title="Crop & Extract">
        <Button size="sm" variant="outline" onClick={setToView}>⬚ Set box to view (80%)</Button>
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
        <div className="flex items-center justify-between">
          <Label className="text-xs">max GE (m)</Label>
          <Input type="number" className="h-7 w-24" value={s.maxGE} onChange={(e) => s.setMaxGE(parseFloat(e.target.value) || 0)} />
        </div>
        <Label className="text-xs" title="LAS: disk-free out-of-core streaming">
          <Checkbox checked={s.lasStream} onCheckedChange={(v) => s.setLasStream(!!v)} />
          LAS disk-free stream (2-pass)
        </Label>
        <Label className="text-xs" title="LAS/COPC: local ENU frame instead of ECEF">
          <Checkbox checked={s.enuFrame} onCheckedChange={(v) => s.setEnuFrame(!!v)} />
          LAS local ENU frame (else ECEF)
        </Label>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => doExtract('las')}>⬇ LAS</Button>
          <Button size="sm" variant="outline" onClick={() => doExtract('copc')}>⬇ COPC</Button>
          <Button size="sm" variant="outline" onClick={() => doExtract('glb')}>⬇ GLB</Button>
        </div>
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
          <Button size="sm" variant="outline" onClick={() => doExtract('zip')}>⬇ ZIP</Button>
        </div>
        <Label className="text-xs" title="Drop splats whose centroid falls outside the box">
          <Checkbox checked={s.splatClip} onCheckedChange={(v) => s.setSplatClip(!!v)} />
          Splat: clip splats outside box
        </Label>
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
        <p className="text-xs text-muted-foreground">Extracts the loaded tileset within the box. Octree sources are fetched as explicit tiling.</p>
    </SidebarSection>
  );
}

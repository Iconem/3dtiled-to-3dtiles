import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useViewerStore } from '@/state/store';
import { useUrlState } from '@/state/urlState';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';

/** How the content is drawn: material mode (3DTRjs), point size / shape / eye-dome lighting, Cesium shading. */
export default function MaterialSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url] = useUrlState();
  const s = useViewerStore();
  const h = () => activeHandleRef.current;

  return (
    <SidebarCollapsibleSection title="Material & Points" defaultOpen>
      {url.renderer === '3dtrjs' && (
        <div className="flex items-center justify-between">
          <Label className="text-xs" title="Default: the content's own materials. Point colours are set below, in every mode. X-ray: see-through — meshes as an additive tint that does not write depth, points additive at 35 %, so a scan's interior shows through its walls and overlapping datasets read through each other. Wireframe: mesh edges only. Features: one colour per feature (EXT_mesh_features ids: a feature-ID attribute as vertex colours, a feature-ID texture as the map), one colour per tile mesh where there are none.">Material</Label>
          <Select value={s.materialMode} onValueChange={(v) => s.setMaterialMode(v as any)}>
            <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default</SelectItem>
              <SelectItem value="xray">X-ray</SelectItem>
              <SelectItem value="wireframe">Wireframe</SelectItem>
              <SelectItem value="features">Features</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {url.renderer === '3dtrjs' && s.materialMode === 'xray' && (
        <>
          <div className="flex items-center justify-between">
            <Label className="text-xs" title="Opacity of the x-ray points; meshes draw at 60 % of it. Additive, so dense areas build up to white.">X-ray opacity</Label>
            <div className="flex w-32 items-center gap-2">
              <Slider min={0.02} max={1} step={0.02} value={[s.xrayOpacity]} onValueChange={([v]) => s.setXrayOpacity(v)} />
              <span className="w-8 text-right text-xs text-muted-foreground">{s.xrayOpacity.toFixed(2)}</span>
            </div>
          </div>
        </>
      )}
      {url.renderer === '3dtrjs' && s.currentType !== 'splat' && (
        <>
          <div className="flex items-center justify-between">
            <Label className="text-xs" title="Points only; meshes keep their textures. RGB: their own colours. One colour: every point the same (white by default; in X-ray, density alone reads as brightness). Height: a blue-to-red ramp over the range below.">Point colour</Label>
            <div className="flex items-center gap-2">
              {s.pointColorMode === 'color' && (
                <input type="color" aria-label="Point colour" value={s.pointColor} onChange={(e) => s.setPointColor(e.target.value)}
                  className="h-7 w-8 cursor-pointer rounded border border-border bg-transparent p-0.5" />
              )}
              <Select value={s.pointColorMode} onValueChange={(v) => s.setPointColorMode(v as any)}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rgb">RGB</SelectItem>
                  <SelectItem value="color">One colour</SelectItem>
                  <SelectItem value="height">Height</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {s.pointColorMode === 'height' && (
            <div className="flex items-center justify-between gap-1" title="Heights (m) at the two ends of the ramp, in the tileset's own frame. Fit reads them from the points loaded now, ignoring the top and bottom 2 %.">
              <Label className="w-14 shrink-0 text-xs">Range (m)</Label>
              <Input type="number" aria-label="Lowest height" className="h-7" value={s.pointHeightRange?.[0] ?? ''}
                onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) s.setPointHeightRange([v, s.pointHeightRange?.[1] ?? v + 1]); }} />
              <Input type="number" aria-label="Highest height" className="h-7" value={s.pointHeightRange?.[1] ?? ''}
                onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) s.setPointHeightRange([s.pointHeightRange?.[0] ?? v - 1, v]); }} />
              <Button size="sm" variant="outline" className="h-7" onClick={() => { if (!h()?.fitPointHeights?.()) s.setStatus('No points loaded yet to fit the range to.'); }}>Fit</Button>
            </div>
          )}
        </>
      )}
      {s.currentType !== 'splat' && (
        <>
          <div className="flex items-center justify-between">
            <Label className="text-xs" title="Point clouds (any tileset that holds points, a mixed mosaic included). Fixed size in pixels; with adaptive sizing, the minimum, and 2× it the cap.">Point size (px)</Label>
            <div className="flex w-32 items-center gap-2">
              <Slider min={0.5} max={10} step={0.5} value={[s.pointSize]} onValueChange={([v]) => { s.setPointSize(v); h()?.setPointSize?.(v); h()?.applyPointShading(); }} />
              <span className="w-8 text-right text-xs text-muted-foreground">{s.pointSize}</span>
            </div>
          </div>
          <Label className="text-xs" title="Size each point from its tile's point spacing (geometric error), so coarse tiles close the gaps and fine tiles stay sharp. Cesium: pointCloudShading.attenuation; 3DTRjs: world-space size = spacing × the px size / 2.">
            <Checkbox checked={s.pointAdaptive} onCheckedChange={(v) => { s.setPointAdaptive(!!v); h()?.applyPointShading(); }} />
            Adaptive point size
          </Label>
          {url.renderer === '3dtrjs' && (
            <div className="flex items-center justify-between">
              <Label className="text-xs" title="Sprite shape (3DTRjs PointCloudEffectsPlugin, applied to 3D Tiles points and native Potree leaves alike). Spheres write bulged depth so overlapping points intersect, at a fill-rate cost. Cesium always draws squares.">Point shape</Label>
              <Select value={s.pointShape} onValueChange={(v) => { s.setPointShape(v as any); h()?.applyPointShading(); }}>
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="round">Round</SelectItem>
                  <SelectItem value="square">Square</SelectItem>
                  <SelectItem value="sphere">Sphere</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <Label className="text-xs" title="Eye-dome lighting: Cesium pointCloudShading.eyeDomeLighting; 3DTRjs PointCloudEffectsPlugin (a depth pre-pass per renderer, then each point is shaded by how far it sits behind its neighbours).">
            <Checkbox checked={s.edl} onCheckedChange={(v) => { s.setEdl(!!v); h()?.applyPointShading(); }} />
            Eye-dome lighting
          </Label>
          {s.edl && (
            <div className="flex items-center justify-between">
              <Label className="text-xs">EDL strength</Label>
              <div className="flex w-32 items-center gap-2">
                <Slider min={0.1} max={3} step={0.1} value={[s.edlStrength]} onValueChange={([v]) => { s.setEdlStrength(v); h()?.applyPointShading(); }} />
                <span className="w-8 text-right text-xs text-muted-foreground">{s.edlStrength}</span>
              </div>
            </div>
          )}
        </>
      )}
      {url.renderer === 'cesium' && (
        <>
          <Label className="text-xs" title="Unlit rendering — avoids dark results on baked-lighting photogrammetry">
            <Checkbox checked={s.shadeless} onCheckedChange={(v) => { s.setShadeless(!!v); h()?.applyShading(!!v, s.brightness); }} />
            Shadeless (unlit)
          </Label>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Brightness</Label>
            <Input type="number" step={0.1} className="h-7 w-20" value={s.brightness}
              onChange={(e) => { const v = Number(e.target.value) || 1; s.setBrightness(v); h()?.applyShading(s.shadeless, v); }} />
          </div>
        </>
      )}
    </SidebarCollapsibleSection>
  );
}

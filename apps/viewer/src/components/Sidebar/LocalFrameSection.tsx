import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { SidebarCollapsibleSection } from './SidebarSection';
import { isAggregateUrl, readSnap, snapParamFor, withSnap } from '@/lib/aggregate';
import { useUrlState } from '@/state/urlState';

export default function LocalFrameSection({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const lf = useViewerStore((s) => s.localFrame);
  const setLocalFrame = useViewerStore((s) => s.setLocalFrame);
  const gizmoOn = useViewerStore((s) => s.tilesetGizmoOn);
  const setGizmoOn = useViewerStore((s) => s.setTilesetGizmoOn);
  const h = () => activeHandleRef.current;
  const [{ renderer }] = useUrlState();
  const terrainMode = useViewerStore((s) => s.terrainMode);
  const zOffsetAuto = useViewerStore((s) => s.zOffsetAuto);
  const zOffsetClearance = useViewerStore((s) => s.zOffsetClearance);
  const setZOffsetClearance = useViewerStore((s) => s.setZOffsetClearance);
  const setZOffsetAuto = useViewerStore((s) => s.setZOffsetAuto);
  const zOffsetUndo = useViewerStore((s) => s.zOffsetUndo);
  const lastLoadUrl = useViewerStore((s) => s.lastLoadUrl);
  const mosaic = isAggregateUrl(lastLoadUrl);
  const mosaicSnapped = mosaic && !!readSnap(lastLoadUrl);
  /** A mosaic snaps server-side, per dataset: `&snap=` on or off, the tree reloads in place. */
  function setMosaicSnap(on: boolean) {
    const st = useViewerStore.getState();
    const url = withSnap(st.lastLoadUrl, on ? st.terrainMode : null, renderer);
    st.setLastLoadUrl(url); st.setUrlField(url);
    h()?.load(url, st.currentType, { skipAutoFrame: true });
    st.setStatus(on ? 'Snapping every dataset of the mosaic to the ground (server-side, per dataset)…' : 'Mosaic back at its own heights (snap removed).');
  }
  // A snapped mosaic follows the terrain on screen: its &snap= changes when the terrain does (and only
  // then, so a shared link keeps the snap it was shared with).
  useEffect(() => {
    if (mosaicSnapped && readSnap(lastLoadUrl) !== snapParamFor(terrainMode, renderer)) setMosaicSnap(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainMode, renderer]);
  const terrainLabel = {
    auto: 'Mapterhorn', wgs84: 'ellipsoid', cesium: 'World Terrain', 'reearth-qm': 'Mapterhorn', 'mapterhorn-ellipsoid': 'Mapterhorn (geoid)',
    mapterhorn: 'Mapterhorn, sea level', terrarium: 'AWS, sea level', google: 'Google 3D',
  }[terrainMode];

  function useCurrentView() {
    const v = h()?.useCurrentView();
    if (v) setLocalFrame(v);
  }

  return (
    <SidebarCollapsibleSection title="Local Frame" defaultOpen={false}>
      <Label className="text-xs" title="Keep the tileset on the ground, on whichever terrain is selected: the Z offset is re-measured when the terrain mode changes, when a new tileset loads and, on Google 3D or World Terrain, whenever the terrain under it refines — the dataset's own low bins against the terrain, so a scan of a building sits on its ground, not on its roof. On an /aggregate mosaic this turns the server-side per-dataset snap (&snap=) on, and it follows the terrain the same way.">
        <Checkbox checked={mosaic ? mosaicSnapped : zOffsetAuto} onCheckedChange={(v) => {
          const on = !!v;
          if (mosaic) { setZOffsetAuto(on); if (on !== mosaicSnapped) setMosaicSnap(on); return; }
          const st = useViewerStore.getState();
          if (on && st.zOffsetUndo == null) st.setZOffsetUndo(st.localFrame.zOffset);
          setZOffsetAuto(on);
        }} />
        Auto (follow the terrain)
      </Label>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Z offset (m)</Label>
        <Input type="number" className="h-7 w-28" value={lf.zOffset} onChange={(e) => { const v = Number(e.target.value); setLocalFrame({ zOffset: v }); h()?.applyZOffset(v); }} />
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="outline" className="flex-1"
          title="Bin the dataset's own top geometry on an 8×8 grid, compare each bin's low points with the active terrain, and set the Z offset to the difference. On an /aggregate mosaic every dataset is snapped separately, server-side (&snap=)."
          onClick={async () => {
            const st = useViewerStore.getState();
            // a mosaic: one offset per dataset, computed by the server and baked into each leaf
            if (mosaic) { setMosaicSnap(true); return; }
            st.setZOffsetUndo(st.localFrame.zOffset);
            st.setStatus('Snapping to ground…');
            st.setStatus((await h()?.snapToGround?.()) ?? 'Not supported by this renderer.');
          }}>
          ⤓ Snap to ground ({terrainLabel})
        </Button>
        {(mosaic ? mosaicSnapped : zOffsetUndo != null) && (
          <Button size="sm" variant="ghost" title={mosaic ? 'Remove the server-side snap: every dataset back at its own height' : `Back to the Z offset before the snap (${zOffsetUndo} m)`}
            onClick={() => {
              if (mosaic) { setZOffsetAuto(false); setMosaicSnap(false); return; }
              const st = useViewerStore.getState();
              const v = st.zOffsetUndo ?? 0;
              st.setZOffsetAuto(false);
              st.setLocalFrame({ zOffset: v }); h()?.applyZOffset(v);
              st.setZOffsetUndo(null);
              st.setStatus(`Z offset back to ${v} m.`);
            }}>
            ↶ Undo
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between" title="Added above the measured ground by Snap and Auto: the dataset's ground bins land this far above the terrain, so a scan lies above most of it instead of half inside it. 0 = exactly on the terrain.">
        <Label className="text-xs">Clearance above ground (m)</Label>
        <Input type="number" className="h-7 w-20" value={zOffsetClearance} step={1}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setZOffsetClearance(v); }} />
      </div>
      <Label className="text-xs" title="Drag (or press W/E/R to switch translate/rotate/scale) a gizmo on the loaded tileset itself">
        <Checkbox checked={gizmoOn} onCheckedChange={(v) => { const on = !!v; setGizmoOn(on); if (on) h()?.showTilesetGizmo?.(); else h()?.hideTilesetGizmo?.(); }} />
        Transform gizmo (3DTRJS)
      </Label>

      <Separator className="my-1" />

      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between text-xs text-muted-foreground">
          Lon / Lat / Alt <ChevronDown className="size-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5 flex flex-col gap-1.5">
          <div className="flex items-center justify-between"><Label className="text-xs">Lon</Label><Input type="number" className="h-7 w-28" value={lf.lon} onChange={(e) => setLocalFrame({ lon: Number(e.target.value) })} /></div>
          <div className="flex items-center justify-between"><Label className="text-xs">Lat</Label><Input type="number" className="h-7 w-28" value={lf.lat} onChange={(e) => setLocalFrame({ lat: Number(e.target.value) })} /></div>
          <div className="flex items-center justify-between"><Label className="text-xs">Alt (m)</Label><Input type="number" className="h-7 w-28" value={lf.alt} onChange={(e) => setLocalFrame({ alt: Number(e.target.value) })} /></div>
          <div className="flex items-center justify-between"><Label className="text-xs">Range (m)</Label><Input type="number" className="h-7 w-28" value={lf.range} onChange={(e) => setLocalFrame({ range: Number(e.target.value) })} /></div>
          <Button size="sm" variant="outline" onClick={useCurrentView}>↻ Use current view</Button>
          <Button size="sm" variant="outline" onClick={() => h()?.flyToLocalFrame(lf.lon, lf.lat, lf.alt, lf.range)}>✈ Fly to (no transform)</Button>
          <Button size="sm" onClick={() => h()?.applyLocalFrame(lf.lon, lf.lat, lf.alt, lf.range)}>Apply & fly to</Button>
        </CollapsibleContent>
      </Collapsible>
      <p className="text-xs text-muted-foreground">For tilesets with no geographic locator; places the origin at lon/lat/alt.</p>
    </SidebarCollapsibleSection>
  );
}

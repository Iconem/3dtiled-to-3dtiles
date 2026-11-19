import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { useViewerStore } from '@/state/store';
import type { ViewerHandle, TilesetPlacement } from '@/lib/viewer-handle';
import { placedStreamUrl, placedTileset } from '../../../../../packages/core/placement.js';
import { SidebarCollapsibleSection } from './SidebarSection';
import { isAggregateUrl, readSnap, snapParamFor, withSnap, loadMosaic } from '@/lib/aggregate';
import { useUrlState } from '@/state/urlState';

/**
 * One number of the placement: it shows what the viewer reads, and takes a typed value on Enter or on leaving the
 * field. While it is being typed in, the value read from the viewer does not overwrite it.
 */
function PlacedField({ id, label, value, digits, step, title, onCommit }: {
  id: string; label: string; value: number; digits: number; step: number; title?: string; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft);
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(v) && v !== Number(value.toFixed(digits))) onCommit(v);
  };
  return (
    <div className="flex items-center justify-between" title={title}>
      <Label className="text-xs" htmlFor={id}>{label}</Label>
      <Input id={id} type="number" step={step} className="h-7 w-32" value={draft ?? value.toFixed(digits)}
        onFocus={(e) => setDraft(e.target.value)} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') setDraft(null); }} />
    </div>
  );
}

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
    const showing = st.lastLoadUrl;
    st.setLastLoadUrl(url); st.setUrlField(url);
    void loadMosaic(h(), url, st.currentType, { skipAutoFrame: true }, showing);
    st.setStatus(on ? 'Snapping every dataset of the mosaic to the ground (server-side, per dataset)…' : 'Mosaic back at its own heights (snap removed).');
  }
  // A snapped mosaic follows the terrain on screen: its &snap= changes when the terrain does (and only
  // then, so a shared link keeps the snap it was shared with).
  useEffect(() => {
    if (mosaicSnapped && readSnap(lastLoadUrl) !== snapParamFor(terrainMode, renderer)) setMosaicSnap(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainMode, renderer]);
  const terrainLabel = {
    auto: 'Mapterhorn', wgs84: 'ellipsoid', cesium: 'World Terrain', 'reearth-qm': 'Mapterhorn', 'mapterhorn-ellipsoid': 'Re:Earth (Mapterhorn geoid)',
    mapterhorn: 'Mapterhorn, sea level', terrarium: 'AWS, sea level', google: 'Google 3D',
  }[terrainMode];

  function useCurrentView() {
    const v = h()?.useCurrentView();
    if (v) setLocalFrame(v);
  }

  // The placement tool: while the gizmo is on, where the tileset stands, read off the viewer a few times a second
  // (a drag moves it without touching the store), and the two ways to keep it.
  const gizmoMode = useViewerStore((s) => s.gizmoMode);
  const setGizmoMode = useViewerStore((s) => s.setGizmoMode);
  const [placed, setPlaced] = useState<TilesetPlacement | null>(null);
  useEffect(() => {
    if (!gizmoOn) { setPlaced(null); return; }
    const read = () => setPlaced(activeHandleRef.current?.getTilesetPlacement?.() ?? null);
    read();
    const id = window.setInterval(read, 400);
    return () => window.clearInterval(id);
  }, [gizmoOn, activeHandleRef]);
  const numbers = placed?.numbers ?? null;
  /** A typed number: the tileset goes there, and the readout follows at once. */
  function typePlacement(k: 'lon' | 'lat' | 'alt' | 'heading' | 'scale', v: number) {
    if (!numbers) return;
    if (k === 'scale' && !(v > 0)) return;
    const { lon, lat, alt, heading, scale } = numbers;
    activeHandleRef.current?.setTilesetPlacement?.({ lon, lat, alt, heading, scale, [k]: v });
    setPlaced(activeHandleRef.current?.getTilesetPlacement?.() ?? null);
  }

  async function copyPlacedUrl() {
    if (!placed?.streamUrl || !numbers) return;
    const url = placedStreamUrl(placed.streamUrl, numbers);
    try { await navigator.clipboard.writeText(url); useViewerStore.getState().setStatus(`Placed URL copied.\n${url}`); }
    catch { useViewerStore.getState().setStatus(`Placed URL (copy it from here):\n${url}`); }
  }
  function savePlacedTileset() {
    if (!placed?.sphere) return;
    const ts = placedTileset(placed.url, placed.matrix, { sphere: placed.sphere, geometricError: placed.geometricError,
      placement: numbers ? { lon: numbers.lon, lat: numbers.lat, alt: numbers.alt, heading: numbers.heading, scale: numbers.scale } : undefined });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(ts, null, 2)], { type: 'application/json' }));
    a.download = 'placed-tileset.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    useViewerStore.getState().setStatus('placed-tileset.json saved: the source tileset under the transform shown, for any 3D Tiles client.');
  }

  return (
    <SidebarCollapsibleSection title="Local Frame" defaultOpen={false}>
      <Label className="text-xs" title="Keep the tileset on the ground, on whichever terrain is selected: the Z offset is re-measured when the terrain mode changes, when a new tileset loads and, on Google 3D or World Terrain, whenever the terrain under it refines — the dataset's own low bins against the terrain, so a scan of a building sits on its ground, not on its roof. On an /aggregate mosaic this turns the server-side per-dataset snap (&snap=) on, and it follows the terrain the same way.">
        <Checkbox checked={mosaic ? mosaicSnapped : zOffsetAuto} onCheckedChange={(v) => {
          const on = !!v;
          if (mosaic) { setZOffsetAuto(on, true); if (on !== mosaicSnapped) setMosaicSnap(on); return; }
          const st = useViewerStore.getState();
          if (on && st.zOffsetUndo == null) st.setZOffsetUndo(st.localFrame.zOffset);
          setZOffsetAuto(on, true);
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
              if (mosaic) { setZOffsetAuto(false, true); setMosaicSnap(false); return; }
              const st = useViewerStore.getState();
              const v = st.zOffsetUndo ?? 0;
              st.setZOffsetAuto(false, true);
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
        <Checkbox checked={gizmoOn} onCheckedChange={(v) => {
          const on = !!v; setGizmoOn(on);
          // placing by hand: the automatic ground snap would put the tileset back where it measured it
          if (on) { if (zOffsetAuto) setZOffsetAuto(false, true); h()?.showTilesetGizmo?.(); } else h()?.hideTilesetGizmo?.();
        }} />
        Transform gizmo (3DTRJS)
      </Label>
      {gizmoOn && renderer === '3dtrjs' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            {(['translate', 'rotate', 'scale'] as const).map((m) => (
              <Button key={m} size="sm" className="flex-1" variant={gizmoMode === m ? 'default' : 'outline'} onClick={() => setGizmoMode(m)}>
                {m === 'translate' ? 'Move' : m === 'rotate' ? 'Turn' : 'Scale'}
              </Button>
            ))}
          </div>
          {numbers && (
            <div data-testid="placement" className="flex flex-col gap-1.5" title="Where the tileset stands: the placement /stream takes. Drag the gizmo, or type a number.">
              <PlacedField id="placed-lon" label="Longitude" value={numbers.lon} digits={7} step={0.0001} onCommit={(v) => typePlacement('lon', v)} />
              <PlacedField id="placed-lat" label="Latitude" value={numbers.lat} digits={7} step={0.0001} onCommit={(v) => typePlacement('lat', v)} />
              <PlacedField id="placed-alt" label="Altitude (m)" value={numbers.alt} digits={2} step={1} onCommit={(v) => typePlacement('alt', v)} />
              <PlacedField id="placed-heading" label="Heading (°)" value={numbers.heading} digits={2} step={1} title="Degrees clockwise from north" onCommit={(v) => typePlacement('heading', v)} />
              <PlacedField id="placed-scale" label="Scale" value={numbers.scale} digits={4} step={0.1} onCommit={(v) => typePlacement('scale', v)} />
              {!numbers.exact && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400" title="A tilt, or a scale that differs by axis, is not something the five numbers can say: the URL would drop it. The saved tileset keeps the exact transform.">
                  {numbers.tilt >= 0.05 ? `tilted ${numbers.tilt.toFixed(1)}°` : 'scaled by axis'}: saved tileset only
                </div>
              )}
            </div>
          )}
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="flex-1" disabled={!placed?.streamUrl || !numbers}
              title={placed?.streamUrl ? 'The stream URL with this placement as its lon, lat, alt, heading and scale: paste it into any 3D Tiles client.' : 'Only a /stream URL of a local dataset takes placement parameters. Save the tileset instead.'}
              onClick={copyPlacedUrl}>
              Copy placed URL
            </Button>
            <Button size="sm" variant="outline" className="flex-1" disabled={!placed?.sphere}
              title="A tileset.json that holds the loaded tileset under this exact transform (burnt into its root). It points at the source, which must stay reachable."
              onClick={savePlacedTileset}>
              Save tileset
            </Button>
          </div>
        </div>
      )}

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

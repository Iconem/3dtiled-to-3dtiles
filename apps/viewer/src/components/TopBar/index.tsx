import { Fragment, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';
import { PSEUDO_FORMATS, FORMAT_PILL_ORDER, pillMeta, fmtMeta, canCentroids, MW } from '@/lib/formats';
import { buildMiddlewareUrl, currentPresets, type MiddlewareParams, type Preset } from '@/lib/middleware';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { cn } from '@/lib/utils';
import { aggregateIndexUrl, isAggregateUrl, forgetUploadedSet, noteUploadedUrl, restoreUploadedSet, uploadManifest, uploadedSetOf, useAvailableSets, useUploadedSets } from '@/lib/aggregate';

// `?load=<tileset URL>[&type=mesh|pointcloud|splat]` — load an arbitrary tileset on start instead of a
// preset (the Aggregate Builder's "Preview in viewer" uses it for drafts). Read once: the URL itself is
// deliberately not part of the nuqs state (see urlState.ts), and this param is left untouched there.
const START = new URLSearchParams(location.search);
const START_LOAD = START.get('load');
const START_TYPE = (['mesh', 'pointcloud', 'splat'] as const).find((t) => t === START.get('type')) ?? 'mesh';
// `&fly=<lon>,<lat>,<height>` — where to look instead of auto-framing the whole tileset (a mosaic's
// root is often continent-sized, and from there no site is close enough to load).
const START_FLY = (() => {
  const [lon, lat, height] = (START.get('fly') ?? '').split(',').map(Number);
  return [lon, lat, height].every(Number.isFinite) ? { lon, lat, height } : undefined;
})();

const MODE_PILLS: [string, string][] = [
  ['stream', '⚡ Live streaming'],
  ['offline', '💾 Prebuilt offline'],
  ['tools', '⚙ Tools'],
];
const CACHE_PILLS: [string, string][] = [
  ['none', '◔ cache=none'],
  ['hierarchy', '◑ cache=hierarchy'],
  ['all', '● cache=all'],
];
const TOOL_PILLS: [string, string][] = [
  ['implicit-to-explicit', '⬡→⬢ implicit→explicit'],
  ['upgrade', '⬆ upgrade'],
  ['packages', '📦 packages'],
];
const TILING_PILLS: [string, string][] = [
  ['implicit', '⬡ implicit'],
  ['explicit', '⬢ explicit'],
];

type Tint = 'blue' | 'amber' | 'emerald' | 'fuchsia';

// Group container tint: a faint wash (instead of vertical dividers) so groups stay visually
// distinguishable, and each group becomes a single flex-wrap unit that wraps as a whole rather
// than splitting mid-group on narrow screens.
const GROUP_TINT: Record<Tint, string> = {
  blue: 'bg-blue-500/10',
  amber: 'bg-amber-500/10',
  emerald: 'bg-emerald-500/10',
  fuchsia: 'bg-fuchsia-500/10',
};

// Active-pill tint: a stronger wash of the SAME hue rather than the default variant's full-contrast
// white-on-dark fill — keeps the active state legible as belonging to its group instead of just
// "loudest element on the page". Text is dark by default (readable against the light tint the wash
// produces over a light-mode white page) and switches to a light shade in dark mode.
const ACTIVE_TINT: Record<Tint, string> = {
  blue: 'bg-blue-500/30 border-blue-400/40 text-blue-950 hover:bg-blue-500/35 dark:text-blue-50',
  amber: 'bg-amber-500/30 border-amber-400/40 text-amber-950 hover:bg-amber-500/35 dark:text-amber-50',
  emerald: 'bg-emerald-500/30 border-emerald-400/40 text-emerald-950 hover:bg-emerald-500/35 dark:text-emerald-50',
  fuchsia: 'bg-fuchsia-500/30 border-fuchsia-400/40 text-fuchsia-950 hover:bg-fuchsia-500/35 dark:text-fuchsia-50',
};

// Inactive-pill hover: a light wash of the group's own hue instead of the default variant's neutral
// accent — keeps hover feedback consistent with each group's color instead of a generic grey flash.
const HOVER_TINT: Record<Tint, string> = {
  blue: 'hover:bg-blue-500/15 hover:text-foreground',
  amber: 'hover:bg-amber-500/15 hover:text-foreground',
  emerald: 'hover:bg-emerald-500/15 hover:text-foreground',
  fuchsia: 'hover:bg-fuchsia-500/15 hover:text-foreground',
};

function Pill({ active, onClick, title, tint, children }: { active: boolean; onClick: () => void; title?: string; tint: Tint; children: React.ReactNode }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} title={title} className={cn('h-7 px-2 text-xs', active ? ACTIVE_TINT[tint] : HOVER_TINT[tint])}>
      {children}
    </Button>
  );
}

function PillGroup({ tint, className, children }: { tint: Tint; className?: string; children: React.ReactNode }) {
  return <div className={cn('flex flex-wrap items-center gap-1 rounded-md p-1', GROUP_TINT[tint], className)}>{children}</div>;
}

export default function TopBar({ activeHandleRef }: { activeHandleRef: React.RefObject<ViewerHandle | null> }) {
  const [url, setUrl] = useUrlState();
  const store = useViewerStore;
  const urlField = useViewerStore((s) => s.urlField);
  const rawUrlMode = useViewerStore((s) => s.rawUrlMode);
  const inputRef = useRef<HTMLInputElement>(null);
  const manifestRef = useRef<HTMLInputElement>(null);
  const startFlyRef = useRef(START_FLY);

  // Your own set manifest (e.g. the Iconem share-link list from scripts/iconem-share-links.mjs), from
  // a local file: uploaded to the server, then a pill of the Aggregate row like any server set. The
  // pill's preset id names the set, so the page URL (`format=aggregate&preset=agg-upload-…`) reopens
  // it in this browser, which kept the file.
  async function loadManifestFile(file: File) {
    const st = store.getState();
    st.setStatus(`Uploading ${file.name}…`);
    try {
      const up = await uploadManifest(file);
      const id = `agg-${up.set}`;
      if (url.format !== 'aggregate') setUrl({ format: 'aggregate', preset: id });   // the effect below loads it
      else {
        setUrl({ preset: id });
        st.setRawUrlMode(false);
        st.setUrlField(up.url);
        doLoad(up.url, up.pointsOnly ? 'pointcloud' : 'mesh');
      }
      st.setStatus(`${up.label} · ${up.count} datasets from ${file.name}`);
    } catch (e) {
      st.setStatus(`Manifest ${file.name}: ${(e as Error).message}`);
    }
  }

  const params: MiddlewareParams = {
    selectedFormat: url.format,
    viewerMode: url.mode,
    cacheScope: url.cache,
    prefetchN: url.prefetch,
    transformOp: url.transform,
    centroidsOnly: url.centroids,
    tilingMode: url.tiling,
  };

  const availableSets = useAvailableSets();
  const uploads = useUploadedSets();
  // Uploaded manifests come first in the Aggregate row, before the server's own sets.
  const uploadPresets: Preset[] = url.format === 'aggregate' ? uploads.map((u) => {
    const name = u.label.replace(/\s*\(\d+ datasets?\)$/i, '');
    return { id: `agg-${u.set}`, label: `📂 ${name.length > 40 ? name.slice(0, 39) + '…' : name}${u.count ? ` (${u.count})` : ''}`,
      type: u.pointsOnly ? 'pointcloud' : 'mesh', url: u.url };
  }) : [];
  const presets = [...uploadPresets, ...currentPresets({ ...params, toolName: url.tool, tilesetOp: url.tilesetOp as any })
    // Presets backed by a machine-local aggregate set stay hidden until the server confirms it has it.
    .filter((p) => !p.requiresSet || availableSets?.has(p.requiresSet))
    .filter((p) => !p.unlessSet || (availableSets != null && !availableSets.has(p.unlessSet)))];
  const fmtOfSelected = fmtMeta(url.format);

  // Deliberately-grouped pill order (see FORMAT_PILL_ORDER's own comment) — pseudo-formats (3D Tiles,
  // Packages, Bing, 3MX, GeoSplats) have no "offline" (prebuilt) story, so they're hidden in that mode,
  // same as before this was unified into one ordered list instead of two back-to-back arrays.
  const visibleFormatPills = FORMAT_PILL_ORDER
    .filter((item) => !(url.mode === 'offline' && PSEUDO_FORMATS.some(([v]) => v === item.id)))
    .map((item) => ({ ...item, meta: pillMeta(item.id) }))
    .filter((item): item is typeof item & { meta: NonNullable<typeof item.meta> } => item.meta != null);

  function doLoad(loadUrl: string, type: Preset['type'], flyTo?: Preset['flyTo']) {
    // &curved=on|off on this server's /stream and /aggregate URLs (auto = the server's extent rule)
    if (/\/(stream|aggregate)\/tileset\.json\?/.test(loadUrl)) {
      const w = new URL(loadUrl, location.href);
      if (url.curved === 'auto') w.searchParams.delete('curved'); else w.searchParams.set('curved', url.curved);
      loadUrl = w.toString();
    }
    store.getState().setCurrentType(type);
    store.getState().setLastLoadUrl(loadUrl);
    store.getState().tlogReset(`${url.mode} · ${url.format}${flyTo ? ' [fly]' : ''}`);
    activeHandleRef.current?.load(loadUrl, type, { skipAutoFrame: !!flyTo });
    if (flyTo) activeHandleRef.current?.flyToCity(flyTo.lon, flyTo.lat, flyTo.height);
  }

  function selectPreset(p: Preset) {
    setUrl({ preset: p.id });
    if (p.custom) {
      store.getState().setUrlField('');
      store.getState().setStatus(rawUrlMode ? `Custom · paste a RAW ${url.format} dataset URL, then Load.` : 'Custom · paste a full middleware/tileset URL, then Load.');
      inputRef.current?.focus();
      return;
    }
    if (!p.url) return;
    // Bing 3D's mesh has baked/pre-lit textures like most photogrammetry — lit shading double-darkens
    // it the same way plain b3dm mesh does elsewhere in this app. Default shadeless ON when picking any
    // Bing preset; the sidebar checkbox still lets you turn it back off manually afterward.
    if (url.format === 'bing') store.getState().setShadeless(true);
    const field = rawUrlMode && p.rawSrc ? p.rawSrc : p.url;
    store.getState().setUrlField(field);
    const loadUrl = rawUrlMode && p.rawSrc ? buildMiddlewareUrl(p.rawSrc, params) : p.url;
    // an uploaded manifest's mosaic: the server may have restarted since, so re-send the file first
    // a `?load=…&fly=` link to an uploaded set reaches here through its pill: keep its viewpoint
    const flyTo = p.flyTo ?? (uploadedSetOf(loadUrl) && startFlyRef.current ? startFlyRef.current : undefined);
    startFlyRef.current = undefined;
    if (uploadedSetOf(loadUrl)) restoreUploadedSet(loadUrl).finally(() => doLoad(loadUrl, p.type, flyTo));
    else doLoad(loadUrl, p.type, flyTo);
  }

  function handleLoadClick() {
    const field = urlField.trim();
    if (!field) return;
    const loadUrl = rawUrlMode && !field.startsWith(MW) ? buildMiddlewareUrl(field, params) : field;
    doLoad(loadUrl, store.getState().currentType);
  }

  // Toggling the pill alone used to leave the field showing whatever selectPreset()/handleLoadClick()
  // last wrote — flip it, and the text box wouldn't change, so there was no visible sign the toggle did
  // anything. Re-derive the field for whichever preset is currently selected (raw src vs wrapped
  // middleware URL) so the switch is immediately visible; doesn't re-trigger a network load (the two
  // forms resolve to the same content — only how it's *displayed/pasted* changes).
  function toggleRawUrlMode() {
    const next = !rawUrlMode;
    store.getState().setRawUrlMode(next);
    const current = presets.find((p) => p.id === url.preset);
    if (!current) return;
    if (current.custom) {
      store.getState().setStatus(next ? `Custom · paste a RAW ${url.format} dataset URL, then Load.` : 'Custom · paste a full middleware/tileset URL, then Load.');
      return;
    }
    if (!current.url) return;
    store.getState().setUrlField(next && current.rawSrc ? current.rawSrc : current.url);
  }

  // Whenever mode/format/tool/tilesetOp changes (including the very first mount, where `url.preset`
  // may already be populated from a shared/bookmarked link — the actual tileset URL is deliberately
  // NOT persisted, see urlState.ts, so it must be re-derived and reloaded here, not skipped), OR any
  // param that changes what buildMiddlewareUrl/currentPresets actually BUILDS for the current preset
  // (cache scope, the tiling pill, centroids-only, the per-tile transform) — load the preset the URL
  // already names, or fall back to the first available one. Missing cache/tiling/centroids/transform
  // here was a real bug: e.g. flipping the implicit/explicit tiling pill on a loaded COPC/Potree preset
  // updated the URL state but never re-triggered `doLoad`, so the viewport kept showing the stale tree.
  // `prefetch` is deliberately excluded — it's a free-typed number input, and reloading on every
  // keystroke would be jarring; its value is just read fresh the next time something else reloads.
  // The startup `?load=` wins only for the mode/format/… the page opened with: keyed on those deps
  // rather than a run-once flag, because StrictMode runs this effect twice on mount.
  const depsKey = [url.mode, url.format, url.tool, url.tilesetOp, url.cache, url.tiling, url.centroids, url.transform, url.curved].join('|');
  const startKey = useRef(depsKey);
  useEffect(() => {
    if (START_LOAD && depsKey === startKey.current) {
      // A shared link to an uploaded manifest's mosaic becomes its pill in the Aggregate row (even
      // without the file: the server still holds the set), and loads through the preset path below.
      const upSet = uploadedSetOf(START_LOAD);
      if (upSet) {
        noteUploadedUrl(START_LOAD);
        const page = new URL(location.href);
        for (const k of ['load', 'type', 'fly']) page.searchParams.delete(k);
        history.replaceState(history.state, '', page);
        if (url.format !== 'aggregate') { setUrl({ format: 'aggregate', preset: `agg-${upSet}` }); return; }
        setUrl({ preset: `agg-${upSet}` });
        store.getState().setRawUrlMode(false);
        store.getState().setUrlField(START_LOAD);
        restoreUploadedSet(START_LOAD).finally(() => doLoad(START_LOAD, START_TYPE, START_FLY));
        return;
      }
      store.getState().setRawUrlMode(false);
      store.getState().setUrlField(START_LOAD);
      doLoad(START_LOAD, START_TYPE, START_FLY);
      return;
    }
    const wanted = url.preset && presets.find((p) => p.id === url.preset && p.url);
    const target = wanted || presets.find((p) => p.url);
    if (target) selectPreset(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.mode, url.format, url.tool, url.tilesetOp, url.cache, url.tiling, url.centroids, url.transform, url.curved]);

  const manifestButton = (
    <>
      <input
        ref={manifestRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';                       // the same file again must still fire onChange
          if (f) loadManifestFile(f);
        }}
        data-testid="manifest-file"
      />
      <Button
        size="sm"
        variant="outline"
        className={cn('h-7 px-2 text-xs', HOVER_TINT.fuchsia)}
        onClick={() => manifestRef.current?.click()}
        title="Load your own set manifest from a local file ({ label, entries: [{ url, format: 'potree'|'copc'|'3dtiles', name? }] }, the .local/aggregate-sets/<name>.json shape) as an /aggregate mosaic. The file goes to the tile-server's memory (24 h) and this browser's storage, nowhere else."
        data-testid="open-manifest"
      >
        📂 manifest…
      </Button>
    </>
  );

  return (
    <header className="flex flex-col gap-2 border-b bg-background/95 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold">
          <img src="/logo.svg" alt="" className="h-4 w-4" />
          3D Tiled
        </h1>

        <PillGroup tint="blue">
          {MODE_PILLS.map(([v, l]) => (
            <Pill key={v} tint="blue" active={url.mode === v} onClick={() => setUrl({ mode: v as any })}>{l}</Pill>
          ))}
        </PillGroup>

        {url.mode === 'stream' && (
          <PillGroup tint="amber">
            {CACHE_PILLS.map(([v, l]) => (
              <Pill key={v} tint="amber" active={url.cache === v} onClick={() => setUrl({ cache: v as any })}>{l}</Pill>
            ))}
            {url.cache === 'none' && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                prefetch
                <Input type="number" min={-1} step={1} value={url.prefetch} onChange={(e) => setUrl({ prefetch: parseInt(e.target.value, 10) || 0 })} className="h-7 w-14" />
              </span>
            )}
            {url.format === '3dtiles' ? (
              // Tileset-level op, not per-tile compression: rewrites the WHOLE tileset (implicit→explicit
              // subtree expansion, or bumping a legacy 1.0/b3dm tileset to 1.1 with on-the-fly glb
              // conversion) via /3dtiles-tools — same backend the "Tools" mode pills use, now applied to
              // any DIRECT 3D Tiles preset instead of just the two hardcoded Tools datasets.
              <Select value={url.tilesetOp || 'none'} onValueChange={(v) => setUrl({ tilesetOp: v === 'none' ? '' : v })}>
                <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">tileset: none</SelectItem>
                  <SelectItem value="implicit-to-explicit">⬡→⬢ implicit→explicit</SelectItem>
                  <SelectItem value="upgrade">⬆ legacy b3dm upgrade</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Select value={url.transform || 'none'} onValueChange={(v) => setUrl({ transform: v === 'none' ? '' : v })}>
                <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">transform: none</SelectItem>
                  <SelectItem value="meshopt">meshopt ↓</SelectItem>
                  <SelectItem value="draco">draco ↓ (mesh)</SelectItem>
                  <SelectItem value="decompress">decompress ↑</SelectItem>
                </SelectContent>
              </Select>
            )}
            {(url.format === 'copc' || url.format === 'aggregate') && (
              <Select value={url.curved} onValueChange={(v) => setUrl({ curved: v as any })}>
                <SelectTrigger size="sm" className="h-7 text-xs"
                  title="COPC placement. Tangent plane: a point's source XY/Z minus the origin, exact at the origin, d²/2R above the ground away from it (30 km for Corsica in a France-wide file). Curved: each tile's points placed on the ellipsoid (proj4 → ECEF, sampled on a ≤505 m grid and interpolated, 1 cm). auto = curved past a 20 km extent. Applies to every COPC child of a mosaic too.">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">curved: auto (&gt; 20 km)</SelectItem>
                  <SelectItem value="on">curved: on</SelectItem>
                  <SelectItem value="off">curved: off (tangent plane)</SelectItem>
                </SelectContent>
              </Select>
            )}
          </PillGroup>
        )}

        <PillGroup tint="emerald">
          {url.mode === 'tools' ? (
            TOOL_PILLS.map(([v, l]) => (
              <Pill key={v} tint="emerald" active={url.tool === v} onClick={() => setUrl({ tool: v as any, preset: '' })}>{l}</Pill>
            ))
          ) : (
            <>
              {visibleFormatPills.map((item, idx) => (
                <Fragment key={item.id}>
                  {idx > 0 && item.group !== visibleFormatPills[idx - 1].group && (
                    <span className="mx-1 h-5 w-px self-center bg-current opacity-20" aria-hidden="true" />
                  )}
                  <Pill tint="emerald" active={url.format === item.id} onClick={() => setUrl({ format: item.id, preset: '' })}>
                    {item.meta.icon ? `${item.meta.icon} ${item.meta.label}` : item.meta.label}
                  </Pill>
                </Fragment>
              ))}
              {url.mode === 'stream' && fmtOfSelected?.octree &&
                TILING_PILLS.map(([v, l]) => (
                  <Pill key={v} tint="emerald" active={url.tiling === v} onClick={() => setUrl({ tiling: v as any })}>{l}</Pill>
                ))}
              {url.mode === 'stream' && canCentroids(url.format) && (
                <Pill tint="emerald" active={url.centroids} onClick={() => setUrl({ centroids: !url.centroids })} title="Render splat centres as glTF POINTS instead of full gaussians">◦ centroids</Pill>
              )}
            </>
          )}
        </PillGroup>
      </div>

      <PillGroup tint="fuchsia" className="self-start">
        {presets.map((p, i) => (
          <Fragment key={p.id}>
            {url.format === 'aggregate' && i === uploadPresets.length && manifestButton}
            {i < uploadPresets.length ? (
              // an uploaded manifest: the pill, welded to a small × that drops it (also Shift-click)
              <span className="inline-flex" data-testid="upload-pill">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => { if (e.shiftKey) forgetUploadedSet(p.id.slice(4)); else selectPreset(p); }}
                  className={cn('h-7 rounded-r-none px-2 text-xs', url.preset === p.id ? ACTIVE_TINT.fuchsia : HOVER_TINT.fuchsia)}
                  title={`${uploads[i].label} — a manifest you uploaded (kept in this browser)`}
                >
                  {p.label}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Remove ${uploads[i].label}`}
                  onClick={() => forgetUploadedSet(p.id.slice(4))}
                  className={cn('-ml-px h-7 w-5 rounded-l-none px-0 text-xs opacity-60 hover:opacity-100', HOVER_TINT.fuchsia)}
                  title="Remove this manifest from the row and this browser's storage (the server forgets it after 24 h)"
                  data-testid="forget-upload"
                >
                  ×
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!p.url}
                onClick={() => selectPreset(p)}
                className={cn('h-7 px-2 text-xs', url.preset === p.id ? ACTIVE_TINT.fuchsia : HOVER_TINT.fuchsia, !p.url && 'opacity-40')}
                title={!p.url ? `${url.format} has no ${url.mode} adapter` : undefined}
              >
                {p.label}
              </Button>
            )}
          </Fragment>
        ))}
        {url.format === 'aggregate' && presets.length === uploadPresets.length && manifestButton}
      </PillGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Pill tint="blue" active={rawUrlMode} onClick={toggleRawUrlMode} title="ON: field holds the RAW dataset URL — wrapped with the current format+cache+params. OFF: a ready middleware/tileset URL, loaded as-is.">
          raw url
        </Pill>
        <Input
          ref={inputRef}
          value={urlField}
          onChange={(e) => store.getState().setUrlField(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleLoadClick(); }}
          placeholder={rawUrlMode ? 'raw dataset URL (e.g. https://host/cloud.copc.laz) — wrapped with current format + cache' : 'http://localhost:3001/…/tileset.json'}
          className="min-w-[240px] flex-1 font-mono text-xs"
        />
        <Button size="sm" onClick={handleLoadClick}>Load</Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          // The RESOLVED tileset URL, not the input field: in `raw url` mode the field holds the bare
          // dataset (…/cloud.js), which /stats cannot walk — only the wrapped middleware URL can be.
          // Falls back to the field so the button still works before anything has been loaded.
          onClick={() => {
            const target = useViewerStore.getState().lastLoadUrl || urlField.trim();
            if (!target) return;
            window.open(`/hierarchy?url=${encodeURIComponent(target)}`, '_blank', 'noopener');
          }}
          title="Open this tileset's depth/breadth hierarchy graph in a new tab"
        >
          ⌗ hierarchy
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          // Point clouds open in the lab with 3DTRjs master's point effects (shape, EDL, adaptive size):
          // a raw cloud.js / .copc.laz as itself, anything already 3D Tiles (a /stream or /aggregate URL)
          // in "any 3D Tiles url" mode. Other assets open the lab on its default sample.
          onClick={() => {
            const st = useViewerStore.getState();
            const field = urlField.trim();
            const raw = /(cloud\.js|metadata\.json|\.copc\.laz)(\?|#|$)/i.test(field) ? field : '';
            const q = raw ? `?url=${encodeURIComponent(raw)}`
              : st.currentType === 'pointcloud' && st.lastLoadUrl ? `?mode=tileset&url=${encodeURIComponent(st.lastLoadUrl)}` : '';
            window.open(`/potree-lab${q}`, '_blank', 'noopener');
          }}
          title="Open the Potree lab (3DTRjs master point-cloud effects: shape, eye-dome lighting, adaptive size) in a new tab"
        >
          ✺ potree lab
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          // With an /aggregate mosaic (or a builder draft) loaded, its selection seeds the builder's library.
          onClick={() => {
            const last = useViewerStore.getState().lastLoadUrl;
            const q = isAggregateUrl(last) ? `?import=${encodeURIComponent(aggregateIndexUrl(last))}` : '';
            window.open(`/builder${q}`, '_blank', 'noopener');
          }}
          title="Open the Aggregate Builder: assemble your own mosaic of datasets by hand (tree, groups, metadata, export)"
          data-testid="open-builder"
        >
          🧱 builder
        </Button>
      </div>
    </header>
  );
}

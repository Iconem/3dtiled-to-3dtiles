import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUrlState } from '@/state/urlState';
import { useViewerStore } from '@/state/store';
import { FORMATS, PSEUDO_FORMATS, fmtMeta, canCentroids, MW } from '@/lib/formats';
import { buildMiddlewareUrl, currentPresets, type MiddlewareParams, type Preset } from '@/lib/middleware';
import type { ViewerHandle } from '@/lib/viewer-handle';
import { cn } from '@/lib/utils';

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

type Tint = 'blue' | 'amber' | 'emerald' | 'fuchsia' | 'violet';

// Group container tint: a faint wash (instead of vertical dividers) so groups stay visually
// distinguishable, and each group becomes a single flex-wrap unit that wraps as a whole rather
// than splitting mid-group on narrow screens.
const GROUP_TINT: Record<Tint, string> = {
  blue: 'bg-blue-500/10',
  amber: 'bg-amber-500/10',
  emerald: 'bg-emerald-500/10',
  fuchsia: 'bg-fuchsia-500/10',
  violet: 'bg-violet-500/10',
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
  violet: 'bg-violet-500/30 border-violet-400/40 text-violet-950 hover:bg-violet-500/35 dark:text-violet-50',
};

// Inactive-pill hover: a light wash of the group's own hue instead of the default variant's neutral
// accent — keeps hover feedback consistent with each group's color instead of a generic grey flash.
const HOVER_TINT: Record<Tint, string> = {
  blue: 'hover:bg-blue-500/15 hover:text-foreground',
  amber: 'hover:bg-amber-500/15 hover:text-foreground',
  emerald: 'hover:bg-emerald-500/15 hover:text-foreground',
  fuchsia: 'hover:bg-fuchsia-500/15 hover:text-foreground',
  violet: 'hover:bg-violet-500/15 hover:text-foreground',
};

const RENDERER_PILLS: [string, string][] = [
  ['cesium', 'CesiumJS'],
  ['3dtrjs', '3DTRJS'],
];

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

  const params: MiddlewareParams = {
    selectedFormat: url.format,
    viewerMode: url.mode,
    cacheScope: url.cache,
    prefetchN: url.prefetch,
    transformOp: url.transform,
    centroidsOnly: url.centroids,
    tilingMode: url.tiling,
  };

  const presets = currentPresets({ ...params, toolName: url.tool });
  const fmtOfSelected = fmtMeta(url.format);

  function doLoad(loadUrl: string, type: Preset['type'], flyTo?: Preset['flyTo']) {
    store.getState().setCurrentType(type);
    store.getState().setLastLoadUrl(loadUrl);
    store.getState().tlogReset(`${url.mode} · ${url.format}${flyTo ? ' [fly]' : ''}`);
    activeHandleRef.current?.load(loadUrl, type);
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
    const field = rawUrlMode && p.rawSrc ? p.rawSrc : p.url;
    store.getState().setUrlField(field);
    const loadUrl = rawUrlMode && p.rawSrc ? buildMiddlewareUrl(p.rawSrc, params) : p.url;
    doLoad(loadUrl, p.type, p.flyTo);
  }

  function handleLoadClick() {
    const field = urlField.trim();
    if (!field) return;
    const loadUrl = rawUrlMode && !field.startsWith(MW) ? buildMiddlewareUrl(field, params) : field;
    doLoad(loadUrl, store.getState().currentType);
  }

  // Whenever mode/format/tool changes (including the very first mount, where `url.preset` may
  // already be populated from a shared/bookmarked link — the actual tileset URL is deliberately NOT
  // persisted, see urlState.ts, so it must be re-derived and reloaded here, not skipped), load the
  // preset the URL already names, or fall back to the first available one.
  useEffect(() => {
    const wanted = url.preset && presets.find((p) => p.id === url.preset && p.url);
    const target = wanted || presets.find((p) => p.url);
    if (target) selectPreset(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.mode, url.format, url.tool]);

  return (
    <header className="flex flex-col gap-2 border-b bg-background/95 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 shrink-0 text-sm font-semibold">3D Tiled</h1>

        <PillGroup tint="violet">
          {RENDERER_PILLS.map(([v, l]) => (
            <Pill key={v} tint="violet" active={url.renderer === v} onClick={() => setUrl({ renderer: v as any })}>{l}</Pill>
          ))}
        </PillGroup>

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
            <Select value={url.transform || 'none'} onValueChange={(v) => setUrl({ transform: v === 'none' ? '' : v })}>
              <SelectTrigger size="sm" className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">transform: none</SelectItem>
                <SelectItem value="meshopt">meshopt ↓</SelectItem>
                <SelectItem value="draco">draco ↓ (mesh)</SelectItem>
                <SelectItem value="decompress">decompress ↑</SelectItem>
              </SelectContent>
            </Select>
          </PillGroup>
        )}

        <PillGroup tint="emerald">
          {url.mode === 'tools' ? (
            TOOL_PILLS.map(([v, l]) => (
              <Pill key={v} tint="emerald" active={url.tool === v} onClick={() => setUrl({ tool: v as any, preset: '' })}>{l}</Pill>
            ))
          ) : (
            <>
              {FORMATS.map((f) => (
                <Pill key={f.fmt} tint="emerald" active={url.format === f.fmt} onClick={() => setUrl({ format: f.fmt, preset: '' })}>{f.icon} {f.label}</Pill>
              ))}
              {url.mode !== 'offline' &&
                PSEUDO_FORMATS.map(([v, l]) => (
                  <Pill key={v} tint="emerald" active={url.format === v} onClick={() => setUrl({ format: v, preset: '' })}>{l}</Pill>
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

      <PillGroup tint="fuchsia">
        {presets.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant="outline"
            disabled={!p.url}
            onClick={() => selectPreset(p)}
            className={cn('h-7 px-2 text-xs', url.preset === p.id ? ACTIVE_TINT.fuchsia : HOVER_TINT.fuchsia, !p.url && 'opacity-40')}
            title={!p.url ? `${url.format} has no ${url.mode} adapter` : undefined}
          >
            {p.label}
          </Button>
        ))}
      </PillGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Pill tint="blue" active={rawUrlMode} onClick={() => store.getState().setRawUrlMode(!rawUrlMode)} title="ON: field holds the RAW dataset URL — wrapped with the current format+cache+params. OFF: a ready middleware/tileset URL, loaded as-is.">
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
      </div>
    </header>
  );
}

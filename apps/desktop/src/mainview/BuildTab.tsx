/**
 * Build — a dataset, then two flows, each in its own tab: live-stream (a paste-ready URL) or export to disk.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AppModel } from './App';
import { Card } from './components/Card';
import { Actions, Advanced, Choice, Code, Field, FieldLabel, Hint, Result, TextInput, UrlBar, type Message } from './components/bits';
import { ExportCard } from './ExportCard';
import { base, pickDataset, pickerAvailable, viewerUrl } from './host';
import { newId } from './library';
import { nameFor, PLACEMENT, typeOfFormat } from './urls';

const FLOWS = [
  ['stream', 'Stream live', 'A tileset URL converted on demand while this app runs: nothing is written to disk'],
  ['export', 'Export to a folder', 'Files on disk: crawl the stream, or run the offline converter'],
] as const;
/** How many threads the app's server builds tiles on: one setting, for the tiles it streams and the exports it runs. */
export const WORKERS = [
  { value: 'auto', label: 'Auto, up to 8 threads (default)' },
  { value: '', label: 'One thread' },
  { value: '2', label: '2 worker threads' },
  { value: '4', label: '4 worker threads' },
  { value: '8', label: '8 worker threads' },
];
export const WORKERS_TITLE = 'Decode and encode tiles on worker threads: about 3 to 4 times faster on 8 cores for COPC and Potree, less for splats and meshes. The same tiles, around 50 MB more memory a worker. One setting for the tiles this app streams and the exports it runs; the offline converter uses workers for COPC and Potree only.';
const FORMATS = [
  { value: '', label: 'auto-detect' }, { value: 'copc', label: 'COPC' }, { value: 'potree', label: 'Potree' },
  { value: 'sog', label: 'SOG (streamed)' }, { value: 'lcc', label: 'LCC' }, { value: 'rad', label: 'RAD' },
  { value: 'i3s', label: 'I3S' }, { value: 'threemx', label: '3MX' }, { value: 'osgb', label: 'OSGB' }, { value: 'geosplats', label: 'GeoSplats' },
];
const CACHES = [
  { value: 'none', label: 'cache=none — stream, nothing stored' },
  { value: 'hierarchy', label: 'cache=hierarchy — index in RAM' },
  { value: 'full', label: 'cache=full — convert once to disk' },
];
const PLACEMENT_FIELDS: Record<(typeof PLACEMENT)[number], { label: React.ReactNode; placeholder: string }> = {
  lon: { label: 'Longitude', placeholder: '2.2945' },
  lat: { label: 'Latitude', placeholder: '48.8584' },
  alt: { label: <>Altitude&nbsp;m</>, placeholder: '0' },
  heading: { label: 'Heading°', placeholder: '0' },
};

// ── native file picker ──────────────────────────────────────────────────────────────────────────
//
// Tree formats are a FOLDER (Potree's cloud.js directory, a streamed-SOG LOD folder, an unpacked
// 3D Tiles tree); single-file formats are a FILE (.copc.laz, .rad, .lcc, .3tz). Hence two buttons
// rather than one dialog that has to guess — on Windows a single dialog cannot offer both.
const DATASET_FILE_TYPES = 'laz,las,copc,rad,lcc,json,js,zip,3tz,slpk,glb,b3dm';

export function BuildTab({ app, message }: { app: AppModel; message: Message | null }) {
  const { form, patchForm, url, say } = app;
  const [checking, setChecking] = useState(false);
  const [flow, setFlow] = useState<string>('stream');

  async function browse(directory: boolean) {
    if (!pickerAvailable()) return say('The native picker needs the desktop app — paste a path instead.', 'err');
    try {
      const picked = await pickDataset({ directory, allowedFileTypes: directory ? '*' : DATASET_FILE_TYPES });
      const path = picked?.[0];
      if (!path) return;                                   // user cancelled — not an error
      patchForm({ src: path });
      say(`Selected ${path}`, 'ok');
    } catch (e) {
      say(`File picker failed: ${e}`, 'err');
    }
  }

  const needUrl = () => { if (!url) say('Enter a dataset path or URL first.', 'err'); return !url; };

  async function copy() {
    if (needUrl()) return;
    app.noteServedNow();
    try { await navigator.clipboard.writeText(url); say('Copied — paste it into Cesium for Unreal/Unity, QGIS or CesiumJS.', 'ok'); }
    catch { say(url, 'info'); }
  }

  async function check() {
    if (needUrl()) return;
    say('requesting…');
    setChecking(true);
    try {
      const t0 = performance.now();
      const r = await fetch(url);
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) return say(`HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`, 'err');
      const j = await r.json();
      app.noteServedNow();
      const root = j.root ?? {};
      const bv = root.boundingVolume ?? {};
      const kind = bv.region ? 'region' : bv.box ? 'box' : bv.sphere ? 'sphere' : 'none';
      say(`OK in ${ms} ms — asset ${j.asset?.version ?? '?'}, geometricError ${Math.round(root.geometricError ?? 0)}, `
        + `boundingVolume ${kind}, ${root.children?.length ?? 0} root children`
        + (root.transform ? ', placed via root transform' : ''), 'ok');
    } catch (e) { say(`Request failed: ${e}`, 'err'); }
    finally { setChecking(false); }
  }

  function preview(renderer: 'cesium' | '3dtrjs') {
    if (needUrl()) return;
    app.noteServedNow();
    app.previewIn(renderer, url, typeOfFormat(form.format), nameFor(form.src.trim()));
  }

  function bookmark() {
    const f = app.dataset();
    if (!f.src) return say('Enter a dataset path or URL first.', 'err');
    app.updateLib((l) => { l.bookmarks.push({ id: newId(), name: nameFor(f.src), addedAt: Date.now(), ...f }); });
    say('Bookmarked.', 'ok');
    app.showTab('library');
  }

  function hierarchy() {
    if (!base) return;
    // Prefer the viewer app's multi-tileset explorer when one is reachable; the server's own page is
    // the always-available single-tileset fallback.
    const target = viewerUrl ? `${viewerUrl}/hierarchy` : `${base}/hierarchy`;
    app.openTool(url ? `${target}?url=${encodeURIComponent(url)}` : target, 'Hierarchy graph');
  }

  return (
    <section>
      <Card>
        <Field label="Dataset — local path or URL">
          <UrlBar>
            <TextInput id="src" value={form.src} onChange={(e) => patchForm({ src: e.target.value })} placeholder="C:\data\scan.copc.laz   or   https://…/cloud.js" className="flex-1" />
            {/* Outside the Electrobun host (e.g. the bundle rendered in a plain browser for verification) the
                native dialog cannot exist — hide the buttons rather than offering an action that always fails. */}
            {pickerAvailable() && <>
              <Button id="browse-file" title="Pick a single-file dataset (.copc.laz, .rad, .lcc, .3tz…)" onClick={() => browse(false)}>File…</Button>
              <Button id="browse-dir" title="Pick a dataset folder (Potree cloud.js dir, streamed-SOG LOD dir, unpacked 3D Tiles)" onClick={() => browse(true)}>Folder…</Button>
            </>}
          </UrlBar>
        </Field>

        <Advanced summary="Advanced" hint="format, materialization, placement on the globe">
          <div className="mt-3.5 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Field label="Format"><Choice id="format" value={form.format} onChange={(v) => patchForm({ format: v })} options={FORMATS} /></Field>
            <Field label="Materialization"><Choice id="cache" value={form.cache} onChange={(v) => patchForm({ cache: v })} options={CACHES} /></Field>
          </div>
          {/* Only for a source that carries no georeference, so it stays folded: most sources place themselves. */}
          <Advanced id="manual-georef-local-tileset" summary="Manual georeference of a local tileset" hint="longitude, latitude, altitude, heading">
            <div className="mt-3.5 grid grid-cols-4 gap-3 max-[560px]:grid-cols-2">
              {PLACEMENT.map((k) => (
                <Field key={k} label={PLACEMENT_FIELDS[k].label}>
                  <TextInput id={k} value={form[k]} onChange={(e) => patchForm({ [k]: e.target.value })} placeholder={PLACEMENT_FIELDS[k].placeholder} />
                </Field>
              ))}
            </div>
            <Hint className="mt-3">
              For sources with no georeference: applied as a root ENU transform in the tileset
              itself, so every client gets it. Sources that carry their own georeference ignore these.
            </Hint>
          </Advanced>
        </Advanced>
      </Card>

      {/* The two things to do with a dataset, apart: a URL that converts on demand, or files on disk. Both stay
          mounted, so an export carries on while the stream tab is open. */}
      <Tabs id="flows" value={flow} onValueChange={(v) => setFlow(String(v))} className="gap-0">
        <TabsList id="flow-tabs" className="mb-3 h-auto gap-0.5 self-start rounded-md p-[3px]">
          {FLOWS.map(([name, label, sub]) => (
            <TabsTrigger key={name} value={name} data-flow={name} title={sub}
              className="h-[30px] flex-none rounded-sm border-0 px-3.5 text-[13px] font-medium text-muted-foreground hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-xs dark:data-active:border-0 dark:data-active:bg-background">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="stream" id="flow-stream" keepMounted>
        <Card>
          <FieldLabel className="mb-[9px] text-[13.5px] leading-normal text-foreground">Live-stream <span className="text-xs font-normal text-muted-foreground">— a URL for Cesium for Unreal/Unity, QGIS or CesiumJS, converted on demand while this app runs</span></FieldLabel>
          <UrlBar>
            <Code id="url" empty={!url}>{url || '—'}</Code>
            <Button id="copy" variant="default" onClick={copy}>Copy URL</Button>
          </UrlBar>
          <Actions>
            <Button id="preview" onClick={() => preview('cesium')}>Preview in Cesium</Button>
            <Button id="preview-3dtrjs" onClick={() => preview('3dtrjs')}>Preview in 3DTRjs</Button>
            <Button id="save" onClick={bookmark}>Bookmark</Button>
          </Actions>
          <Result id="result" message={message} />
          <Hint className="mt-3">
            Point cloud in Cesium for Unreal? Set the tileset's <em>Maximum Screen Space Error</em> to 1 or 2: its
            default, 16, suits meshes and loads far fewer points. Then turn on <em>Attenuation</em> under
            <em> Point Cloud Shading</em>, or every point stays 1 px.
          </Hint>
          <Advanced summary="Advanced" hint="tile threads, test, API playground, hierarchy">
            <div className="mt-3.5 mb-3 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
              <Field label={<>Tile threads <span className="text-xs font-normal text-muted-foreground">(experimental)</span></>} title={WORKERS_TITLE}>
                <Choice id="stream-workers" value={app.workers} onChange={app.setWorkers} options={WORKERS} />
              </Field>
            </div>
            <Actions>
              <Button id="check" disabled={checking} onClick={check}>Test endpoint</Button>
              <Button id="playground" variant="ghost" onClick={() => { if (base) app.openTool(`${base}/playground`, 'API playground'); }}>API playground</Button>
              <Button id="hierarchy" variant="ghost" onClick={hierarchy}>Hierarchy graph</Button>
            </Actions>
          </Advanced>
        </Card>
        </TabsContent>
        <TabsContent value="export" id="flow-export" keepMounted><ExportCard app={app} /></TabsContent>
      </Tabs>
    </section>
  );
}

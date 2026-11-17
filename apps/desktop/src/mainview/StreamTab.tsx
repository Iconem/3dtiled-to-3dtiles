/**
 * The tiled dataset (DatasetCard), shared by the Stream live and Export tabs, and the Stream live tab itself: a
 * paste-ready URL. Raw input that is not tiled yet has its own top-level tab (TilerCard), with its own input field.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AppModel } from './App';
import { Card } from './components/Card';
import { Actions, Advanced, Choice, Code, Field, FieldLabel, Hint, Result, TextInput, UrlBar, type Message } from './components/bits';
import { base, pickDataset, pickerAvailable, readClipboard, viewerUrl } from './host';
import { newId } from './library';
import { nameFor, PLACEMENT, typeOfFormat } from './urls';

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
// One file dialog, no folder dialog: a dataset that is a folder (Potree, a streamed SOG, an unpacked 3D Tiles tree,
// an OSGB tree) is opened by its entry file (cloud.js, metadata.json, lod-meta.json, tileset.json, metadata.xml),
// and most datasets are a URL anyway, hence Paste first. A folder path can still be typed or pasted.
// A label for the Windows dialog's type list (`label=ext,ext;…`, see pickWindows). Tiled sources only: raw input
// is picked in the "Tile raw input" tab.
const DATASET_FILE_TYPES = 'Tiled datasets=laz,rad,lcc,lcc2,json,js,xml,osgb,zip,3tz,slpk,nxs,nxz,glb,b3dm';

/** The dataset and its options: one card, shown above both the Stream live and the Export tab. */
export function DatasetCard({ app }: { app: AppModel }) {
  const { form, patchForm, say } = app;

  async function browse() {
    if (!pickerAvailable()) return say('The native picker needs the desktop app — paste a path instead.', 'err');
    try {
      const picked = await pickDataset({ directory: false, allowedFileTypes: DATASET_FILE_TYPES });
      const path = picked?.[0];
      if (!path) return;                                   // user cancelled — not an error
      patchForm({ src: path });
      say(`Selected ${path}`, 'ok');
    } catch (e) {
      say(`File picker failed: ${e}`, 'err');
    }
  }

  /** The clipboard's first line becomes the dataset: the host reads it, as a webview asks for a permission first. */
  async function paste() {
    try {
      const text = pickerAvailable() ? await readClipboard() : await navigator.clipboard.readText();
      // Windows "Copy as path" wraps the path in quotes
      const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.replace(/^"(.*)"$/, '$1') ?? '';
      if (!first) return say('The clipboard holds no text.', 'err');
      patchForm({ src: first });
      say(`Pasted ${first}`, 'ok');
    } catch (e) {
      say(`Could not read the clipboard (${e}): paste in the field with Ctrl+V.`, 'err');
    }
  }

  return (
      <Card>
        <Field label="Dataset — URL or local path">
          <UrlBar>
            <TextInput id="src" value={form.src} onChange={(e) => patchForm({ src: e.target.value })} placeholder="https://…/cloud.js   or   C:\data\scan.copc.laz" className="flex-1" />
            <Button id="paste-src" title="Replace the field with the dataset URL or path in the clipboard" onClick={paste}>Paste</Button>
            {/* Outside the Electrobun host (e.g. the bundle rendered in a plain browser for verification) the
                native dialog cannot exist — hide the button rather than offering an action that always fails. */}
            {pickerAvailable() && <Button id="browse-file" title="Pick a dataset file: .copc.laz, .rad, .lcc, .3tz, .slpk, .nxs…, or the entry file of a dataset that is a folder (Potree cloud.js or metadata.json, a streamed SOG's lod-meta.json, tileset.json, an OSGB metadata.xml). A raw file that is not tiled yet goes to the Tile raw input tab" onClick={browse}>File…</Button>}
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
  );
}

/** Stream live: a tileset URL converted on demand while this app runs. */
export function StreamTab({ app, message }: { app: AppModel; message: Message | null }) {
  const { form, url, say } = app;
  const [checking, setChecking] = useState(false);

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
    </section>
  );
}

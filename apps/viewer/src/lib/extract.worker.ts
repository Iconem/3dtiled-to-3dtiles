/// <reference lib="webworker" />
/**
 * extract.worker.ts — Crop & Extract run **in the browser**: the same walk, box test and writers as the tile server's
 * /extract (packages/core/extract-core.js), in a Web Worker so the viewer stays responsive.
 *
 * The page sends one job; the worker fetches the tileset and its tiles itself (tiles the viewer already downloaded
 * come back from the HTTP cache), and writes the result either straight to a file the user picked (File System Access
 * API: tile by tile, memory stays flat) or, where the browser has no such API, into memory, handed back as a Blob.
 *
 * What the browser does not do: COPC (PDAL, on the server). meshopt and Draco tiles are decoded (the Draco decoder,
 * 190 KB of wasm, is fetched at the first tile that needs it); KTX2 and WebP textures are copied as they are.
 */
import { Document, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, KHRTextureBasisu } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { extractLas, extractMeshDocument, extractSplats, extractTilesetJson, extractZip, type ExtractSink } from '../../../../packages/core/extract-core.js';
import type { BrowserExtractJob, WorkerReply } from './browserExtract';
import dracoWasmUrl from 'draco3dgltf/draco_decoder_gltf.wasm?url';
// splat-transform's WebP encoder (SOG output). The package does not export the file, hence the path.
import webpWasmUrl from '../../../../node_modules/@playcanvas/splat-transform/lib/webp.wasm?url';

declare const self: DedicatedWorkerGlobalScope;

/** Above this, an extract that cannot be streamed to disk is refused instead of exhausting the tab's memory. */
const MEMORY_LIMIT = 1024 * 1024 * 1024;

const post = (m: WorkerReply) => self.postMessage(m);
const controller = new AbortController();

async function fetchBytes(url: string): Promise<Uint8Array> {
  let r: Response;
  try { r = await fetch(url, { signal: controller.signal }); } catch (e) {
    if (controller.signal.aborted) throw e;
    // A browser gives no reason for a failed cross-origin request: say what it most often is.
    throw new Error(`Could not fetch ${new URL(url).host}: it is unreachable, or it does not allow requests from this page (CORS).`);
  }
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host} for ${new URL(url).pathname.split('/').pop()}`);
  return new Uint8Array(await r.arrayBuffer());
}

let io: WebIO | null = null;
async function webIo(): Promise<WebIO> {
  if (io) return io;
  await MeshoptDecoder.ready;
  io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  return io;
}

/** Does this GLB declare Draco geometry? Read off its JSON chunk, without parsing it. */
function usesDraco(glb: Uint8Array): boolean {
  if (glb.length < 20) return false;
  const jsonLength = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
  return new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)).includes('KHR_draco_mesh_compression');
}
let dracoReady: Promise<void> | null = null;
/** Reads a tile, with the Draco decoder added to the reader the first time a tile needs it. */
async function readGlb(glb: Uint8Array) {
  const gltf = await webIo();
  if (usesDraco(glb)) {
    dracoReady ??= (async () => {
      // the decoder alone (the package's entry also pulls the encoder); its wasm is handed over, not looked up
      const create = (await import('draco3dgltf/draco_decoder_gltf_nodejs.js')).default;
      const wasmBinary = await (await fetch(dracoWasmUrl)).arrayBuffer();
      gltf.registerDependencies({ 'draco3d.decoder': await create({ wasmBinary }) });
    })();
    await dracoReady;
  }
  return gltf.readBinary(glb);
}

/** Where the bytes go: the user's file, or memory up to MEMORY_LIMIT. */
async function openSink(handle: FileSystemFileHandle | null) {
  if (handle) {
    const stream = await handle.createWritable();
    return {
      sink: {
        write: (b: Uint8Array) => stream.write(b as unknown as BufferSource),
        rewrite: (position: number, b: Uint8Array) => stream.write({ type: 'write', position, data: b as unknown as BufferSource }),
      } as ExtractSink,
      close: async () => { await stream.close(); return null as Blob | null; },
      // abort() discards what was written: the browser only replaces the picked file on close().
      abort: () => stream.abort().catch(() => {}),
    };
  }
  const chunks: Uint8Array[] = []; let size = 0;
  return {
    sink: {
      write: (b: Uint8Array) => {
        size += b.length;
        if (size > MEMORY_LIMIT) throw new Error('Over 1 GB: this browser cannot stream a file to disk, so the extract is held in memory. Use Chrome or Edge, a smaller box or a larger max GE, or the tile server.');
        chunks.push(b.slice());
      },
      rewrite: (position: number, b: Uint8Array) => { if (position !== 0 || !chunks.length || chunks[0].length !== b.length) throw new Error('cannot rewrite the file start'); chunks[0] = b.slice(); },
    } as ExtractSink,
    close: async () => new Blob(chunks as BlobPart[], { type: 'application/octet-stream' }),
    abort: async () => { chunks.length = 0; },
  };
}

async function run(job: BrowserExtractJob, handle: FileSystemFileHandle | null) {
  let skipped = 0, firstSkip = '';
  const base = {
    url: job.tilesetUrl, bb: job.bbox as number[], maxGE: job.maxGE, initM: job.extractMatrix ?? undefined, signal: controller.signal,
    onProgress: (p: Record<string, number | string>) => post({ type: 'progress', progress: p }),
    onSkip: (_url: string, e: unknown) => { skipped++; if (!firstSkip) firstSkip = e instanceof Error ? e.message : String(e); },
  };
  const out = await openSink(handle);
  try {
    let stats: Record<string, number> = {};
    if (job.kind === 'las') {
      const r = await extractLas({ ...base, enu: !!job.enuFrame, deps: { fetchBytes, readGlb } }, out.sink);
      stats = { points: r.points, tiles: r.tiles };
    } else if (job.kind === 'zip') {
      stats = await extractZip({ ...base, deps: { fetchBytes } }, out.sink);
    } else if (job.kind === 'tileset') {
      const r = await extractTilesetJson({ ...base, deps: { fetchBytes } });
      await out.sink.write(new TextEncoder().encode(JSON.stringify(r.tileset)));
      stats = { tiles: r.tiles };
    } else if (job.kind === 'glb') {
      const gltf = await webIo();
      // A copied KTX2 or WebP texture needs its extension declared in the merged file.
      const declared = new Set<string>();
      const onTexture = (doc: unknown, mime: string) => {
        if (declared.has(mime)) return;
        declared.add(mime);
        if (mime === 'image/ktx2') (doc as Document).createExtension(KHRTextureBasisu).setRequired(true);
        else if (mime === 'image/webp') (doc as Document).createExtension(EXTTextureWebP).setRequired(true);
      };
      const r = await extractMeshDocument({ ...base, deps: { fetchBytes, readGlb, Document, onTexture } });
      if (!r.primitives) throw new Error(skipped ? `No mesh could be read (${skipped} tiles skipped: ${firstSkip}).` : 'No mesh in the box (is this a mesh source?).');
      await out.sink.write(await gltf.writeBinary(r.document as Document));
      stats = { primitives: r.primitives, tiles: r.tiles };
    } else if (job.kind === 'splat') {
      const splat = await import('@playcanvas/splat-transform');   // several megabytes: loaded only for a splat extract
      if (job.splatFormat === 'sog') splat.WebPCodec.wasmUrl = webpWasmUrl;   // it looks next to its own script otherwise
      const r = await extractSplats({ ...base, format: job.splatFormat, clip: job.splatClip !== false, deps: { fetchBytes, splat } });
      if (!r) throw new Error('No splat tiles in the box (is this a splat source?).');
      await out.sink.write(r.bytes);
      stats = { splats: r.splats, tiles: r.tiles, clipped: r.clipped };
    } else throw new Error(`"${job.kind}" is not made in the browser.`);
    const blob = await out.close();
    post({ type: 'done', stats, skipped, firstSkip, blob });
  } catch (e) {
    await out.abort();
    throw e;
  }
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { type: 'start'; job: BrowserExtractJob; handle: FileSystemFileHandle | null } | { type: 'cancel' };
  if (m.type === 'cancel') { controller.abort(new Error('cancelled')); return; }
  run(m.job, m.handle).catch((e) => post({ type: 'error', message: controller.signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e), cancelled: controller.signal.aborted }));
};

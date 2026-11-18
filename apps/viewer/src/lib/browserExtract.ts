/**
 * browserExtract.ts — Crop & Extract without a tile server: the page side of extract.worker.ts.
 *
 * The file is picked first (it needs the user's click), then the worker walks the tileset and writes into it. In a
 * browser without the File System Access API (Firefox, Safari) the extract is built in memory and downloaded, up to
 * 1 GB.
 */
import { forceExplicitHierarchy, type ExtractKind } from './extract';

export type BrowserExtractKind = Exclude<ExtractKind, 'copc'> | 'tileset';

export interface BrowserExtractJob {
  kind: BrowserExtractKind;
  tilesetUrl: string;
  bbox: [number, number, number, number, number, number];   // w, s, minH, e, n, maxH
  maxGE: number;
  enuFrame?: boolean;
  splatFormat?: string;
  splatClip?: boolean;
  extractMatrix?: number[] | null;
}
export type ExtractProgress = Record<string, number | string>;
export type WorkerReply =
  | { type: 'progress'; progress: ExtractProgress }
  | { type: 'done'; stats: Record<string, number>; skipped: number; firstSkip: string; blob: Blob | null }
  | { type: 'error'; message: string; cancelled: boolean };

export interface BrowserExtractResult { fileName: string; stats: Record<string, number>; skipped: number; firstSkip: string; streamed: boolean }

/** Splat outputs made in the browser: all four of the server's. */
export const BROWSER_SPLAT_FORMATS = ['spz', 'ply', 'glb', 'sog'];

type SavePicker = (o: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
const savePicker = (): SavePicker | null => (typeof window !== 'undefined' && (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker) || null;
/** Can this browser write an extract straight to disk (no size limit)? */
export const canStreamToDisk = () => !!savePicker();

function fileNameOf(job: BrowserExtractJob): string {
  if (job.kind === 'las') return 'crop.las';
  if (job.kind === 'glb') return 'crop.glb';
  if (job.kind === 'zip') return 'crop.zip';
  if (job.kind === 'tileset') return 'crop-tileset.json';
  return `crop.${BROWSER_SPLAT_FORMATS.includes(job.splatFormat || '') ? job.splatFormat : 'spz'}`;
}

type Done = Extract<WorkerReply, { type: 'done' }>;
interface RunOptions { onProgress?: (p: ExtractProgress) => void; signal?: AbortSignal }

/** One job on a fresh worker, written to `handle` or, without one, into memory. Null when cancelled. */
async function runWorker(job: BrowserExtractJob, handle: FileSystemFileHandle | null, o: RunOptions): Promise<Done | null> {
  // An octree /stream source is asked as an explicit tree, as the server's extract asks it: same tiles either way.
  const tilesetUrl = forceExplicitHierarchy(job.tilesetUrl);
  const worker = new Worker(new URL('./extract.worker.ts', import.meta.url), { type: 'module' });
  const cancel = () => worker.postMessage({ type: 'cancel' });
  o.signal?.addEventListener('abort', cancel);
  try {
    return await new Promise<Done | null>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const m = ev.data;
        if (m.type === 'progress') o.onProgress?.(m.progress);
        else if (m.type === 'done') resolve(m);
        else if (m.cancelled) resolve(null);
        else reject(new Error(m.message));
      };
      worker.onerror = (ev) => reject(new Error(ev.message || 'the extract worker failed to start'));
      const splatFormat = BROWSER_SPLAT_FORMATS.includes(job.splatFormat || '') ? job.splatFormat : 'spz';
      worker.postMessage({ type: 'start', job: { ...job, tilesetUrl, splatFormat }, handle });
    });
  } finally {
    o.signal?.removeEventListener('abort', cancel);
    worker.terminate();
  }
}

/**
 * Run one extract in the browser and save it: to a file the user picks where the browser can stream to disk, else
 * through the browser's downloads.
 * @returns the result, or null when the user closed the file dialog or cancelled
 */
export async function runBrowserExtract(job: BrowserExtractJob, o: RunOptions = {}): Promise<BrowserExtractResult | null> {
  const fileName = fileNameOf(job), ext = fileName.slice(fileName.lastIndexOf('.'));
  let handle: FileSystemFileHandle | null = null;
  const pick = savePicker();
  if (pick) {
    try { handle = await pick({ suggestedName: fileName, types: [{ description: `${ext.slice(1).toUpperCase()} file`, accept: { 'application/octet-stream': [ext] } }] }); }
    catch (e) { if ((e as Error)?.name === 'AbortError') return null; throw e; }
  }
  const done = await runWorker(job, handle, o);
  if (!done) return null;
  if (done.blob) {                                       // no file picked: hand the bytes to the browser's downloads
    const a = document.createElement('a');
    a.href = URL.createObjectURL(done.blob); a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  return { fileName: handle?.name ?? fileName, stats: done.stats, skipped: done.skipped, firstSkip: done.firstSkip, streamed: !!handle };
}

/**
 * Run one extract in the browser with no file dialog, for scripts and automated checks: into `handle` when given (any
 * FileSystemFileHandle, one of the origin's private file system included), else into memory, returned as a Blob.
 */
export async function extractToBlob(job: BrowserExtractJob, o: RunOptions & { handle?: FileSystemFileHandle } = {}) {
  const done = await runWorker(job, o.handle ?? null, o);
  return done && { blob: done.blob, stats: done.stats, skipped: done.skipped, firstSkip: done.firstSkip };
}
// Reachable from the console and from headless checks: `await __extractInBrowser({ kind: 'las', tilesetUrl, bbox, maxGE })`.
if (typeof window !== 'undefined') (window as unknown as { __extractInBrowser?: typeof extractToBlob }).__extractInBrowser = extractToBlob;

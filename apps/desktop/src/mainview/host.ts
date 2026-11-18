/**
 * What the view gets from outside itself: the RPC to the main process, and the query string.
 *
 * The ports and the docs/viewer URLs arrive in the query string (see src/bun/index.ts): the main
 * process may adopt an already-running server rather than starting one, and it resolves whether a
 * local viewer/docs is up — neither is knowable at build time.
 */
import { Electroview } from 'electrobun/view';
import type { DesktopRPC } from '../shared/rpc-schema';

/**
 * RPC to the main process, for the one thing a webview genuinely cannot do: open a native file
 * dialog and learn a real filesystem path.
 *
 * Construction is guarded because this same bundle is rendered in a plain browser during
 * verification (`vite preview`), where there is no Electrobun host to talk to. In that case
 * `pickerRpc` stays null and the Browse buttons hide themselves rather than throwing on click.
 */
type PickerRPC = ReturnType<typeof Electroview.defineRPC<DesktopRPC>>;

export let pickerRpc: PickerRPC | null = null;
try {
  // Electrobun answers a request within 1 s by default, or rejects it as timed out. A dialog waits for the user, and
  // the main process may be busy starting the servers, so the limit is generous here; the pickers lift it (Infinity).
  const rpc = Electroview.defineRPC<DesktopRPC>({ maxRequestTime: 30_000, handlers: { requests: {} } });
  // Constructing the view is what wires the transport; we keep the rpc handle, not the view.
  new Electroview({ rpc });
  pickerRpc = rpc;
} catch {
  pickerRpc = null;
}
export const pickerAvailable = () => Boolean(pickerRpc && (globalThis as { __electrobun?: unknown }).__electrobun);

/** A native file or folder dialog: the request is answered when the user closes it, however long that takes. */
export const pickDataset = (params: { directory: boolean; allowedFileTypes?: string }) =>
  pickerRpc!.request.pickDataset(params, { maxRequestTime: Infinity });

/** The clipboard's text, read by the host: a webview would first ask for a permission. */
export const readClipboard = () => pickerRpc!.request.readClipboard({});

const params = new URLSearchParams(location.search);
export const tilePort = params.get('tilePort');
export const staticPort = params.get('staticPort');
export const base = tilePort ? `http://127.0.0.1:${tilePort}` : '';
export const viewerUrl = params.get('viewerUrl') || '';
export const docsUrl = params.get('docsUrl') || '';

// The version is only the build day, so two builds of one day differ by their hash alone.
export const buildLabel = (version: string, hash: string | null) => (hash ? `${version} · ${hash.slice(0, 7)}` : version);

/** The release the installed app updates from: what the version in the footer links to. */
export const RELEASE_URL = 'https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/tag/desktop-latest';

/**
 * Tell the app's tile-server how many worker threads to build tiles on ('' = one thread, 'auto', or a count):
 * it applies to the tiles it streams and to the exports it runs. Resolves to the count in use, or null if the
 * server did not take it (an older or adopted server).
 */
export async function setServerWorkers(workers: string): Promise<number | null> {
  if (!base) return null;
  try {
    const r = await fetch(`${base}/workers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workers: workers || 0 }) });
    return r.ok ? ((await r.json()).workers as number) : null;
  } catch { return null; }
}

/** Open a page in the default browser: through the host when there is one, else a new tab. */
export function openExternal(url: string) {
  if (pickerRpc) void pickerRpc.request.openExternal({ url }).catch(() => {});
  else window.open(url, '_blank');
}

// ── window sizing ───────────────────────────────────────────────────────────────────────────────
//
// The window keeps its size whatever the page shows (a taller tab scrolls): only a preview asks the host for more
// room, and gives it back when it closes.

/** 3D needs more room than the launcher's form; closing the preview gives it back. */
export function fitWindowForPreview() {
  pickerRpc?.request.fitWindow({ cssWidth: 1280, cssHeight: 800, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }).catch(() => {});
}

/** The size the window had before the preview. */
export function restoreWindow() {
  pickerRpc?.request.fitWindow({ cssWidth: 0, cssHeight: 0, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, restore: true }).catch(() => {});
}

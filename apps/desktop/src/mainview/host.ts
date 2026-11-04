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

const params = new URLSearchParams(location.search);
export const tilePort = params.get('tilePort');
export const staticPort = params.get('staticPort');
export const base = tilePort ? `http://127.0.0.1:${tilePort}` : '';
export const viewerUrl = params.get('viewerUrl') || '';
export const docsUrl = params.get('docsUrl') || '';

// The version is only the build day, so two builds of one day differ by their hash alone.
export const buildLabel = (version: string, hash: string | null) => (hash ? `${version} · ${hash.slice(0, 7)}` : version);

/** Open a page in the default browser: through the host when there is one, else a new tab. */
export function openExternal(url: string) {
  if (pickerRpc) void pickerRpc.request.openExternal({ url }).catch(() => {});
  else window.open(url, '_blank');
}

// ── window sizing ───────────────────────────────────────────────────────────────────────────────
//
// Only the view can measure the content; only the host can resize the window. The conversion between
// them is the subtle part on Windows, so the measurements are logged — `hutch electrobun dev` prints
// them, which is how the CSS-px-vs-frame-px mismatch was pinned down in the first place.
let lastFit = '';

/** Forget the last size sent, so the next measurement is sent even if it is the same. */
export const resetFit = () => { lastFit = ''; };

/**
 * Ask the host for a window the size of the content column. `el` is the column, whose last child is
 * the footer; `overlayOpen` skips the request while a preview asked for its own size.
 */
export function fitWindowToContent(el: HTMLElement | null, overlayOpen: boolean) {
  if (!pickerAvailable()) return;                 // no host to resize (plain-browser preview)
  if (overlayOpen) return;                        // a preview asked for its own size
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const cssWidth = Math.ceil(rect.width + 24);    // the content, centred, + breathing room
  // What the content needs, not scrollHeight: the column is as tall as the window, and asking for that plus a margin
  // would grow the window at every call.
  const footer = el.querySelector('footer');
  if (!footer) return;
  const above = [...el.children].filter((c) => c !== footer && c.getClientRects().length).map((c) => c.getBoundingClientRect().bottom);
  if (!above.length) return;
  const cssHeight = Math.ceil(Math.max(...above) + window.scrollY + footer.getBoundingClientRect().height + 30);
  const key = `${cssWidth}x${cssHeight}`;
  if (key === lastFit) return;                    // don't spam the host on every tab switch
  lastFit = key;
  console.log(`[fit] css=${cssWidth}x${cssHeight} innerWidth=${window.innerWidth} `
    + `innerHeight=${window.innerHeight} dpr=${window.devicePixelRatio} scrollW=${document.documentElement.scrollWidth}`);
  pickerRpc!.request.fitWindow({
    cssWidth, cssHeight,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
  }).catch(() => { /* host declined — the layout still works, it just may need scrolling */ });
}

/** 3D needs more room than the launcher's form; closing the preview gives it back. */
export function fitWindowForPreview() {
  pickerRpc?.request.fitWindow({ cssWidth: 1280, cssHeight: 800, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }).catch(() => {});
}

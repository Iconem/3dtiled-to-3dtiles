/**
 * The webview ⇄ main-process RPC contract, shared by both sides so a rename can't silently break one.
 *
 * Type-only: both sides import it with `import type`, so nothing from here is emitted into either
 * bundle — which matters because the main process and the webview have different module resolution.
 */
import type { RPCSchema } from 'electrobun/main';

export interface DesktopRPC {
  bun: RPCSchema<{
    requests: {
      /**
       * Open the OS file/folder picker. Datasets are a FOLDER for tree formats (Potree's cloud.js
       * directory, a streamed-SOG LOD folder) and a FILE for single-file ones (.copc.laz, .rad,
       * .lcc), so the caller says which it wants rather than the dialog guessing.
       */
      pickDataset: {
        params: { directory: boolean; allowedFileTypes?: string };
        response: string[];
      };
      /**
       * Ask the host to grow the window so the layout needs less scrolling.
       *
       * Only the view can measure content; only the host can resize. The view also reports its
       * viewport, so the host can convert CSS px → frame px from the ratio it observes instead of
       * trusting `devicePixelRatio`.
       *
       * MEASURED CAVEAT — on Windows this cannot fully solve the width problem. The launcher runs
       * DPI-*unaware*, so Windows virtualizes it: the webview honestly reports `innerWidth: 1104,
       * devicePixelRatio: 1` for a 1120-px frame, while the compositor scales the result up by the
       * display factor and only ~1104/scale CSS px are ever on screen. Both sides' numbers agree
       * and both are wrong about what is visible, so the scale is simply not observable from in
       * here. That is why the layout stays inside a conservative fixed width and this call only
       * ever GROWS the window — anything cleverer would be guessing.
       */
      fitWindow: {
        params: { cssWidth: number; cssHeight: number; viewportWidth: number; viewportHeight: number };
        response: { width: number; height: number };
      };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
}

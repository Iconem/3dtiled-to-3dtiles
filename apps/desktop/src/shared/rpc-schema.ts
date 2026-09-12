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
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
}

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
       */
      /** Open a page in the default browser. */
      openExternal: {
        params: { url: string };
        response: boolean;
      };
      /** Open a folder in the OS file manager (after an export). */
      openFolder: {
        params: { path: string };
        response: boolean;
      };
      fitWindow: {
        params: { cssWidth: number; cssHeight: number; viewportWidth: number; viewportHeight: number };
        response: { width: number; height: number };
      };
      /**
       * Export → "Run in: CLI subprocess": run `node <args…>` from the repo root (no shell). args[0]
       * must be `packages/convert/cli.js` or `scripts/pack-3dtiles.mjs` — the main process rejects
       * anything else. `then` is an optional second step run only if the first exits 0 (convert →
       * pack). Rejects (throws) on a disallowed command.
       */
      runCli: {
        params: { args: string[]; then?: string[] };
        response: { id: string };
      };
      /** State of a runCli job; `tail` is the last ~200 output lines (`\r` progress redraws collapsed). */
      cliStatus: {
        params: { id: string };
        response: {
          state: 'running' | 'done' | 'failed' | 'cancelled';
          exitCode: number | null;
          tail: string[];
          startedAt: number;
          endedAt: number | null;
        } | null;
      };
      /** Kill a running runCli job (and, on Windows, its process tree). False if not running. */
      cancelCli: {
        params: { id: string };
        response: boolean;
      };
      /** The library file's content (mainview/library.ts), null before the first write. */
      readLibrary: {
        params: Record<string, never>;
        response: string | null;
      };
      writeLibrary: {
        params: { json: string };
        response: boolean;
      };
      /** The version of a downloaded update ready to apply, null when there is none. */
      updateStatus: {
        params: Record<string, never>;
        response: { version: string | null };
      };
      /** Stop the servers and restart into the downloaded update. */
      applyUpdate: {
        params: Record<string, never>;
        response: boolean;
      };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
}

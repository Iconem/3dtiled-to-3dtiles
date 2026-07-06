import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

// vite-plugin-cesium defaults to the RELATIVE path 'node_modules/cesium/Build', resolved against the
// dev server's cwd. That works for the root app (cesium lives right in its own node_modules) but not
// here: pnpm hoists cesium to the MONOREPO ROOT's node_modules, not apps/viewer/node_modules, so the
// relative default silently 404'd every Cesium static asset (Widgets/widgets.css, the skybox JPGs,
// etc.) — and because Vite's SPA fallback masked those 404s as 200+index.html, Cesium tried to decode
// that HTML as a WebGL texture and crashed its entire render loop ("InvalidStateError: the source
// image could not be decoded"). Fixed two ways: `appType: 'mpa'` below (so a REAL 404 surfaces instead
// of being masked) and pointing this plugin at cesium's actual resolved location.
const cesiumBuildRoot = path.dirname(fileURLToPath(new URL('../../node_modules/cesium/Build/package.json', import.meta.url)));

// The monorepo root, two levels up from apps/viewer — sample-data/ lives there, not under this package.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Standalone React viewer — see ../../README.md "Vision: towards a TiTiler for 3D" and
// C:\Users\jonathan\.claude\plans\cuddly-jingling-rabbit.md for the full port plan. Talks to the
// tile-server directly at http://localhost:3001 (CORS is already wide open there, no proxy needed).
export default defineConfig({
  // MPA (not SPA): without this, Vite answers any missing asset with 200 + index.html instead of a
  // real 404 (its default SPA client-side-routing fallback) — the root app's vite.config.mjs hit and
  // documented this exact bug for the tile-server's optional-resource probing. Here it silently broke
  // Cesium: some `/cesium/...` static asset 404s, Vite serves index.html (~650 B after HMR injection,
  // Content-Type text/html) instead, and Cesium's WebGL texture pipeline tries to decode that HTML as
  // an image, throwing "InvalidStateError: the source image could not be decoded" and crashing the
  // ENTIRE render loop (not just failing that one asset) — reproduced via a createImageBitmap patch
  // that caught the failing blob's real content-type/size.
  appType: 'mpa',
  plugins: [
    react(),
    cesium({ cesiumBuildRootPath: cesiumBuildRoot, cesiumBuildPath: path.join(cesiumBuildRoot, 'Cesium') + path.sep }),
    // This app is the dev/build entry point for the viewer + legacy vanilla-viewer (docs is its own
    // always-on process on :3002, linked to directly — see formats.ts's DOCS_URL — not proxied through
    // here). Its project root is apps/viewer/, not the monorepo root, so — unlike the OLD root-level
    // vite.config.mjs, where
    // `/sample-data/**` was served automatically by Vite's own default static handler because its
    // project root WAS the repo root — sample-data needs an explicit static passthrough here.
    {
      name: 'sample-data-static',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url || '';
          if (!url.startsWith('/sample-data/')) return next();
          const filePath = path.resolve(repoRoot, '.' + decodeURIComponent(url.split('?')[0]));
          if (!filePath.startsWith(repoRoot)) return next();
          try { await stat(filePath); }
          catch { return next(); }
          const ext = path.extname(filePath).toLowerCase();
          // Potree 1.x's tree descriptor is cloud.js — pure JSON with a .js extension. Vite's normal
          // module pipeline would append an HMR/sourcemap footer, corrupting JSON.parse tile-server-side
          // — that's why .js needs to be force-served as data here instead of falling through to Vite.
          const mime: Record<string, string> = {
            '.js': 'application/json', '.json': 'application/json', '.gltf': 'model/gltf+json',
            '.glb': 'model/gltf-binary', '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
            '.laz': 'application/octet-stream', '.las': 'application/octet-stream', '.bin': 'application/octet-stream',
            '.ply': 'application/octet-stream', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.ktx2': 'image/ktx2',
          };
          res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
          res.setHeader('Access-Control-Allow-Origin', '*');
          createReadStream(filePath).pipe(res);
        });
      },
    },
    {
      // Extension-less `/vanilla-viewer` (matching the plain `/docs` link's style) instead of forcing
      // `/vanilla-viewer.html` — `serve.json`'s `rewrites` covers the same alias for the production build.
      name: 'vanilla-viewer-alias',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/vanilla-viewer') req.url = '/vanilla-viewer.html';
          next();
        });
      },
    },
  ],
  server: {
    // This app's port — pairs with the tile-server middleware's 3001 and Fumadocs' own 3002 (both
    // always-on separate processes; `pnpm dev` boots all three concurrently, see root package.json's
    // `dev:app` script). Also folds in the legacy standalone page (`/vanilla-viewer`, was the
    // root-level vite.config.mjs on :3000).
    port: 3000,
    // Bind all interfaces (Vite defaults to localhost-only) so this is reachable from other devices
    // on the LAN at http://<this machine's LAN IP>:3000/ — the tile-server middleware already listens
    // on all interfaces by default (plain `.listen(PORT)`, no host arg), and formats.ts's MW/SDATA
    // bases are derived from window.location at runtime rather than hardcoded to 'localhost' for
    // exactly this reason (a hardcoded 'localhost' would resolve to the REMOTE device itself, not
    // this machine, breaking every tileset/sample-data fetch even once the page itself loaded).
    host: true,
    // Serve sample-data/output/** (repo root) too, same as the old root-level app — the built-in
    // presets point at `<origin>/sample-data/...`.
    fs: { allow: [repoRoot] },
    // Don't file-watch sample-data (~100k+ tile files — crawls on startup/every HMR).
    watch: { ignored: ['**/sample-data/**'] },
  },
  resolve: {
    dedupe: ['three'],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: { include: ['three', '3d-tiles-renderer', '@sparkjsdev/spark'] },
  // vanilla-viewer.html is the legacy standalone page (still the fallback/reference implementation —
  // see README) copied in from the repo root's viewer.html so it's served — and, via this entry,
  // included in `dist/` on build — by this app's own dev server instead of needing a separate one.
  build: {
    // Default esbuild target predates top-level await (vanilla-viewer.html's dynamic SparkJS/
    // GaussianSplat plugin loading uses it) — same fix as the root app's own vite.config.mjs.
    target: 'esnext',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'vanilla-viewer': fileURLToPath(new URL('./vanilla-viewer.html', import.meta.url)),
      },
    },
  },
});

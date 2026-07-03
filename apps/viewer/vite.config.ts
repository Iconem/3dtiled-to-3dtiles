import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
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
  ],
  server: { port: 3003 },
  resolve: {
    dedupe: ['three'],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  optimizeDeps: { include: ['three', '3d-tiles-renderer', '@sparkjsdev/spark'] },
});

import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

// Self-contained, offline-capable viewer dev/build. `vite-plugin-cesium` copies Cesium's
// Workers/Assets/ThirdParty/Widgets and sets CESIUM_BASE_URL; three / 3d-tiles-renderer /
// @sparkjsdev/spark / the 3DGS plugin resolve from node_modules (no CDN / esm.sh).
//   npm run dev      → http://localhost:3000/viewer.html  (serves sample-data/ too)
//   npm run build    → static bundle in dist/
export default defineConfig({
  // MPA (not SPA): disable the history fallback that rewrites every missing path to index.html.
  // The viewer is a static page accessed as /viewer.html (no client-side routing), and the
  // streaming adapters probe for optional resources (e.g. I3S `foo.bin` vs `foo.bin.gz`) — they
  // must get a real 404 for a missing file, not a 200 index.html masquerading as the resource.
  appType: 'mpa',
  plugins: [
    cesium(),
    // T1: serve sample-data/**/*.js files raw (no Vite module transform / HMR footer).
    // Potree 1.x stores its tree descriptor as cloud.js — pure JSON with a .js extension.
    // Vite would append an HMR/sourcemap footer, corrupting JSON.parse on the tile-server side.
    {
      name: 'raw-sample-data-js',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url || '';
          if (!url.includes('/sample-data/') || !/\.js(\?|$)/.test(url)) return next();
          const filePath = path.resolve('.' + decodeURIComponent(url.split('?')[0]));
          if (!filePath.startsWith(path.resolve('.'))) return next();
          try { await stat(filePath); }
          catch { return next(); }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          createReadStream(filePath).pipe(res);
        });
      },
    },
  ],
  server: {
    port: 3000,
    // Serve the whole repo (viewer.html + sample-data/output/** that the presets reference).
    fs: { allow: ['.'] },
    // …but DON'T file-watch sample-data: it holds ~100k+ tile files. Watching them makes the dev
    // server crawl on startup and every HMR. They're still served on demand — only watching is off.
    // Also ignore apps/** (the Fumadocs site, a separate Next.js app in this same monorepo) — its own
    // .next build output was otherwise triggering spurious page reloads here.
    watch: { ignored: ['**/sample-data/**', '**/apps/**'] },
  },
  resolve: {
    // `import … from 'three/addons/…'` → three's bundled examples/jsm.
    alias: { 'three/addons/': path.resolve('node_modules/three/examples/jsm/') + '/' },
    dedupe: ['three'],   // single THREE instance (replaces the esm.sh ?external=three trick)
  },
  optimizeDeps: { include: ['three', '3d-tiles-renderer', '@sparkjsdev/spark'] },
  build: {
    // Without this, `vite build` only bundles index.html (Rollup's implicit default entry) — the
    // actual app, viewer.html, silently never made it into dist/ (only its own redirect stub did).
    // Never caught before because `npm run dev` serves the whole repo tree directly, no build step.
    rollupOptions: { input: { index: 'index.html', viewer: 'viewer.html' } },
    // Default esbuild target predates top-level await (viewer.html's dynamic SparkJS/GaussianSplat
    // import uses it) — Cesium/WebGL2/splat rendering already needs a modern browser, so esnext costs
    // nothing real here.
    target: 'esnext',
  },
});

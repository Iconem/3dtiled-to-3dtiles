import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import path from 'node:path';

// Self-contained, offline-capable viewer dev/build. `vite-plugin-cesium` copies Cesium's
// Workers/Assets/ThirdParty/Widgets and sets CESIUM_BASE_URL; three / 3d-tiles-renderer /
// @sparkjsdev/spark / the 3DGS plugin resolve from node_modules (no CDN / esm.sh).
//   npm run dev      → http://localhost:3000/viewer.html  (serves sample-data/ too)
//   npm run build    → static bundle in dist/
export default defineConfig({
  plugins: [cesium()],
  server: {
    port: 3000,
    // Serve the whole repo (viewer.html + sample-data/output/** that the presets reference).
    fs: { allow: ['.'] },
  },
  resolve: {
    // `import … from 'three/addons/…'` → three's bundled examples/jsm.
    alias: { 'three/addons/': path.resolve('node_modules/three/examples/jsm/') + '/' },
    dedupe: ['three'],   // single THREE instance (replaces the esm.sh ?external=three trick)
  },
  optimizeDeps: { include: ['three', '3d-tiles-renderer', '@sparkjsdev/spark'] },
});

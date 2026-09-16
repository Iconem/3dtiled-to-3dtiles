// The viewer against a FROM-SOURCE 3DTilesRendererJS build (see scripts/build-3dtr-master.mjs).
//   node scripts/build-3dtr-master.mjs && npm run dev:3dtr-master
// `.mts`, not `.ts`: loaded as CommonJS, vite-plugin-cesium breaks.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config.ts';

const T = fileURLToPath(new URL('../../.local/3DTilesRendererJS/', import.meta.url)).replace(/\\/g, '/');
if (!existsSync(`${T}build/index.js`)) {
  throw new Error(`no 3DTilesRendererJS build at ${T}build — run: node scripts/build-3dtr-master.mjs`);
}

export default mergeConfig(
  // '3d-tiles-renderer' must not be pre-bundled from node_modules any more
  { ...base, optimizeDeps: { ...base.optimizeDeps, include: (base.optimizeDeps?.include ?? []).filter((d: string) => !d.startsWith('3d-tiles-renderer')) } },
  {
    resolve: {
      // Most specific first. Anchored regexes, so 3d-tiles-rendererjs-3dgs-plugin is left alone.
      alias: [
        { find: /^3d-tiles-renderer\/src\/(.*)$/, replacement: `${T}src/$1` },
        { find: /^3d-tiles-renderer\/core\/plugins$/, replacement: `${T}build/index.core-plugins.js` },
        { find: /^3d-tiles-renderer\/three\/plugins$/, replacement: `${T}build/index.three-plugins.js` },
        { find: /^3d-tiles-renderer\/plugins$/, replacement: `${T}build/index.plugins.js` },
        { find: /^3d-tiles-renderer\/r3f$/, replacement: `${T}build/index.r3f.js` },
        { find: /^3d-tiles-renderer\/core$/, replacement: `${T}build/index.core.js` },
        { find: /^3d-tiles-renderer\/three$/, replacement: `${T}build/index.three.js` },
        { find: /^3d-tiles-renderer$/, replacement: `${T}build/index.js` },
      ],
      // The clone has its own three / react / r3f in its node_modules: two copies of three break
      // everything (instanceof checks, shared state), so always resolve the viewer's.
      dedupe: ['three', 'react', 'react-dom', '@react-three/fiber'],
    },
    optimizeDeps: { exclude: ['3d-tiles-renderer'] },
  },
);

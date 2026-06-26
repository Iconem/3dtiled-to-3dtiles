/**
 * subtreeBuilder.js — thin re-export. The implicit-tiling / subtree machinery now lives in
 * `3dtiles-convert-core/tiling` (shared by COPC, Potree, and the live tile-server). Kept here so
 * existing imports (`./subtreeBuilder.js`) keep working.
 */
export { buildSubtreeBuffer, keyToCoords } from '../../core/index.js';

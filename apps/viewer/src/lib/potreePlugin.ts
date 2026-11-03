/**
 * 3d-tiles-renderer's PotreePlugin with the three local changes 0.5.4 does not have:
 *
 * - Aborted hierarchy chunks. PotreeLoader marks a chunk loaded before fetching it, so a request
 *   aborted by lib/staleLoads.ts left the chunk "loaded" with no entries, and it was never fetched
 *   again. A failed load now forgets the chunk.
 * - A node with no hierarchy entry (its chunk never finished loading) stays a leaf for now, where
 *   `_expandChildren` would throw.
 * - Linear colours as normalized uint16 (6 B/point) rather than float32 (12 B): lossless for 8-bit
 *   sRGB sources, where 8-bit linear would merge the darkest values.
 */
import { BufferAttribute } from 'three';
import { PotreePlugin as BasePotreePlugin } from '3d-tiles-renderer/plugins';

export class PotreePlugin extends (BasePotreePlugin as any) {
  constructor(options?: any) {
    super(options);
  }

  init(tiles: any) {
    super.init(tiles);
    const loader = this.loader;
    const loadNodeData = loader.loadNodeData.bind(loader);
    loader.loadNodeData = async (key: string, options: any) => {
      const chunks: Set<string> | null = loader._loadedChunks;
      const fresh = chunks && !chunks.has(key);
      try {
        return await loadNodeData(key, options);
      } catch (e) {
        if (fresh) chunks.delete(key);
        throw e;
      }
    };
    const parsePointData = loader.parsePointData.bind(loader);
    loader.parsePointData = (...args: any[]) => {
      const parsed = parsePointData(...args);
      const color = parsed.geometry.attributes.color;
      if (color?.array instanceof Float32Array) {
        const u16 = new Uint16Array(color.array.length);
        for (let i = 0; i < u16.length; i++) u16[i] = Math.round(color.array[i] * 65535);
        parsed.geometry.setAttribute('color', new BufferAttribute(u16, 3, true));
      }
      return parsed;
    };
  }

  _expandChildren(tile: any, key: string) {
    if (this.loader.hierarchy.has(key)) super._expandChildren(tile, key);
  }
}

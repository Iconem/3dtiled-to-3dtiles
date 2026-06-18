/**
 * lodWalker.js  (rad-to-3dtiles)
 *
 * Walks the SparkJS LoD tree to yield per-node topology.
 * Used when loading via SparkJS (Path B) rather than the pure-JS RADC path.
 *
 * Strategy A — SparkJS forEachNode (preferred if available):
 *   lodSplats.forEachNode((index, childStart, childCount, bounds, featureSize) => {})
 *   This is the API requested from the SparkJS team. Checked first.
 *
 * Strategy B — Read topology from extended packedArray:
 *   The extended SPZ LoD format appends child_count (uint16) + child_start (uint32)
 *   per splat. With standard PackedSplats at 4 words/splat (16 bytes), the extended
 *   format adds 6 bytes → padded to 8 bytes → 6 words total per splat.
 *
 *   Extended word layout (6 words = 24 bytes per splat):
 *     words[0..3]  standard 16-byte PackedSplats
 *     word[4] low16  child_count (uint16)
 *     word[4] hi16   padding
 *     word[5]        child_start (uint32)
 *
 * IMPORTANT: SparkJS utils.unpackSplat() returns a REUSED static object.
 * Callers must copy { center, scales, quaternion, color, opacity } values
 * immediately — do NOT store references to the returned object.
 */

const WORDS_STD = 4;  // 16 bytes standard PackedSplats
const WORDS_EXT = 6;  // 24 bytes extended LoD PackedSplats

/**
 * Walk the LoD tree. Calls callback(node) for each node in BFS order.
 *
 * @param {object}   lodSplats   PackedSplats with LoD data
 * @param {function} callback    async (node: NodeInfo) => void
 *
 * NodeInfo = {
 *   index:      number,  flat splat array index
 *   childStart: number,  first child's flat index
 *   childCount: number,  0 = leaf
 *   depth:      number,
 *   bounds:     null     (not in packedArray — comes from RAD header if needed)
 * }
 */
export async function walkLodTree(lodSplats, callback) {
  // Strategy A: SparkJS forEachNode
  if (typeof lodSplats.forEachNode === 'function') {
    console.log('[lodWalker] Using lodSplats.forEachNode()');
    const promises = [];
    lodSplats.forEachNode((index, childStart, childCount, bounds, featureSize) => {
      const r = callback({ index, childStart, childCount, depth: -1, bounds: bounds ?? null });
      if (r instanceof Promise) promises.push(r);
    });
    await Promise.all(promises);
    return;
  }

  // Strategy B: raw packedArray
  const pa = lodSplats.packedArray;
  if (!pa) throw new Error('lodSplats.packedArray not accessible');

  const totalSplats = lodSplats.numSplats ?? lodSplats.splatCount ?? (pa.length / WORDS_STD);
  const isExtended  = pa.length >= totalSplats * WORDS_EXT;

  if (!isExtended) {
    throw new Error(
      `[lodWalker] packedArray length ${pa.length} < expected ${totalSplats * WORDS_EXT} ` +
      `for extended LoD format. Request forEachNode from SparkJS team.`
    );
  }

  console.log('[lodWalker] Reading topology from extended packedArray');
  const queue = [{ index: 0, depth: 0 }];
  while (queue.length) {
    const { index, depth } = queue.shift();
    const base       = index * WORDS_EXT;
    const childCount = pa[base + 4] & 0xFFFF;
    const childStart = pa[base + 5];

    await callback({ index, childStart, childCount, depth, bounds: null });
    for (let c = 0; c < childCount; c++) {
      queue.push({ index: childStart + c, depth: depth + 1 });
    }
  }
}

/**
 * Collect all nodes into a flat array (BFS order).
 */
export async function collectNodes(lodSplats) {
  const nodes = [];
  await walkLodTree(lodSplats, n => nodes.push({ ...n }));
  return nodes;
}

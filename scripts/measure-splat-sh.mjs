#!/usr/bin/env node
// What spherical harmonics cost in a splat tile: for one source, the same tiles asked of a running tile server at
// sh=0..3, their size as sent (the SPZ payload is gzip inside the GLB) and the time to build them.
//
//   node scripts/measure-splat-sh.mjs <format> <source url> [tiles=4] [server=http://localhost:3001]
//
// The tiles are the first `tiles` with content in tileset order, so the first is the coarsest. Each degree gets its own
// decode of the source (the server keeps chunks with and without harmonics apart), and times include it.
const [fmt, src, nArg = '4', server = 'http://localhost:3001'] = process.argv.slice(2);
if (!fmt || !src) { console.error('usage: measure-splat-sh.mjs <format> <source url> [tiles] [server]'); process.exit(1); }
const N = Number(nArg);

const tilesetUrl = (sh) => `${server}/stream/tileset.json?format=${fmt}&url=${encodeURIComponent(src)}${sh ? `&sh=${sh}` : ''}`;
function contentUris(node, out = []) {
  const uri = node.content?.uri;
  if (uri && /\.glb/.test(uri)) out.push(uri);
  for (const c of node.children ?? []) contentUris(c, out);
  return out;
}
function glbInfo(buf) {
  const jsonLen = buf.readUInt32LE(12), json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const attrs = Object.keys(json.meshes?.[0]?.primitives?.[0]?.attributes ?? {});
  const degree = attrs.filter((a) => /SH_DEGREE_(\d)_COEF_0$/.test(a)).length;
  return { count: json.accessors?.[0]?.count ?? 0, degree };
}

const rows = [];
for (const sh of [0, 1, 2, 3]) {
  const ts = await (await fetch(tilesetUrl(sh))).json();
  const uris = contentUris(ts.root).slice(0, N);
  let bytes = 0, splats = 0, degree = 0;
  const t0 = performance.now();
  for (const uri of uris) {
    const r = await fetch(new URL(uri, tilesetUrl(sh)));
    if (!r.ok) throw new Error(`${r.status} for ${uri}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const info = glbInfo(buf);
    bytes += buf.length; splats += info.count; degree = Math.max(degree, info.degree);
  }
  rows.push({ sh, degree, tiles: uris.length, splats, bytes, ms: performance.now() - t0 });
}
const base = rows[0];
console.log(`${fmt}  ${src}\n`);
console.log('asked  in tile  tiles   splats      bytes   B/splat   size   time');
for (const r of rows) {
  console.log(`${String(r.sh).padStart(5)}  ${String(r.degree).padStart(7)}  ${String(r.tiles).padStart(5)}  ${String(r.splats).padStart(7)}  ${String(r.bytes).padStart(9)}  ${(r.bytes / r.splats).toFixed(1).padStart(8)}  ${(r.bytes / base.bytes).toFixed(2).padStart(4)}x  ${(r.ms / base.ms).toFixed(2).padStart(4)}x`);
}

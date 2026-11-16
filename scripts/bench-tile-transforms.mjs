// Timings of the per-tile glTF transforms, on real tiles. Run from the repo root:
//   node scripts/bench-tile-transforms.mjs meshopt <copc url> [tiles=40]
//       what EXT_meshopt costs and saves on point tiles, beside building the tile and gzip/brotli of the raw one
//   node scripts/bench-tile-transforms.mjs decompress <glb url or path> [runs=5]
//       the tile is first encoded to Draco + KTX2, then decoded with each texture output (jpg, webp, png, ktx2)
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { compressGlb, decompressGlb, decompressTile, glbNeedsDecode, tilePool, tileWorkerCount } from '../packages/core/index.js';

const [mode, src, nArg] = process.argv.slice(2);
const ms = (f) => { const t = performance.now(); const r = f(); return r?.then ? r.then(v => [v, performance.now() - t]) : [r, performance.now() - t]; };
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const r1 = (x) => +x.toFixed(1);

if (mode === 'meshopt') {
  const { copcTileset, copcTile } = await import('../packages/tile-server/copc-live.js');
  const n = +(nArg || 40);
  const ts = await copcTileset(src, { hierarchy: 'eager', tiling: 'explicit' });
  const keys = []; (function walk(t) { const u = t.content?.uri; if (u) keys.push(/tile\/([^.]+)\.glb/.exec(u)[1]); (t.children || []).forEach(walk); })(ts.root);
  const pick = keys.filter((_, i) => i % Math.max(1, Math.floor(keys.length / n)) === 0).slice(0, n);
  await compressGlb(await copcTile(src, pick[0]), { meshopt: true });   // warm the encoder
  const rows = [];
  for (const k of pick) {
    const [glb, build] = await ms(() => copcTile(src, k));
    if (!glb) continue;
    const [{ glb: mo }, enc] = await ms(() => compressGlb(glb, { meshopt: true }));
    const [gz, tgz] = ms(() => zlib.gzipSync(glb, { level: 6 }));
    const [br, tbr] = ms(() => zlib.brotliCompressSync(glb, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
    const [mogz, tmogz] = ms(() => zlib.gzipSync(mo, { level: 6 }));
    rows.push({ raw: glb.length, build, enc, mo: mo.length, gz: gz.length, tgz, br: br.length, tbr, mogz: mogz.length, tmogz });
  }
  const raw = sum(rows.map(r => r.raw)), pct = (k) => r1(100 * sum(rows.map(r => r[k])) / raw);
  console.log(JSON.stringify({
    tiles: rows.length, of: keys.length, rawMB: r1(raw / 1e6), medianTileKB: Math.round(med(rows.map(r => r.raw)) / 1e3),
    ms_median: { build: r1(med(rows.map(r => r.build))), meshopt: r1(med(rows.map(r => r.enc))), gzip6: r1(med(rows.map(r => r.tgz))), brotli5: r1(med(rows.map(r => r.tbr))), gzipOfMeshopt: r1(med(rows.map(r => r.tmogz))) },
    ms_total: { build: Math.round(sum(rows.map(r => r.build))), meshopt: Math.round(sum(rows.map(r => r.enc))), gzip6: Math.round(sum(rows.map(r => r.tgz))), brotli5: Math.round(sum(rows.map(r => r.tbr))) },
    meshoptOverBuild: r1(sum(rows.map(r => r.enc)) / sum(rows.map(r => r.build))),
    size_pct_of_raw: { meshopt: pct('mo'), gzip6: pct('gz'), brotli5: pct('br'), meshoptThenGzip: pct('mogz') },
    meshopt_ms_per_MB_raw: r1(sum(rows.map(r => r.enc)) / (raw / 1e6)),
  }, null, 1));
} else if (mode === 'decompress') {
  const runs = +(nArg || 5);
  const bytes = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : readFileSync(src);
  const [{ glb: packed, encoded }, tEnc] = await ms(() => compressGlb(bytes, { draco: true, ktx: true }));
  console.log(JSON.stringify({ sourceKB: Math.round(bytes.length / 1e3), packedKB: Math.round(packed.length / 1e3), encoded, encode_ms: Math.round(tEnc) }));
  await decompressGlb(packed, { texFormat: 'jpg' }); await decompressGlb(packed, { texFormat: 'webp' });   // warm
  for (const opts of [{ texFormat: 'jpg' }, { texFormat: 'webp' }, { texFormat: 'png' }, { ktx: false }, { texFormat: 'ktx2' }]) {
    const all = [], st = { read: [], transcode: [], encode: [], write: [] }; let out;
    for (let i = 0; i < runs; i++) {
      const [r, t] = await ms(() => decompressGlb(packed, opts)); out = r; all.push(t);
      for (const k in st) st[k].push(r.timings?.[k] ?? 0);
    }
    console.log(JSON.stringify({ opts, total_ms: r1(med(all)), read: r1(med(st.read)), transcode: r1(med(st.transcode)), encode: r1(med(st.encode)), write: r1(med(st.write)), outKB: Math.round(out.glb.length / 1e3), textures: out.decoded.ktx }));
  }
  // a tile with nothing to decode, and many tiles at once on this thread against the tile workers
  const plain = (await decompressGlb(packed, { texFormat: 'jpg' })).glb;
  const [, tPlain] = await ms(() => decompressTile(plain, {}));
  console.log(JSON.stringify({ nothingToDecode: !glbNeedsDecode(plain, {}), untouched_ms: +tPlain.toFixed(3) }));
  const many = 16;
  for (const w of ['0', 'auto']) {
    process.env.TILED_WORKERS = w;
    if (tilePool()) await decompressTile(packed, { texFormat: 'jpg' });   // spawn the pool and warm one decoder
    let lag = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); lag = Math.max(lag, n - last - 20); last = n; }, 20);
    const [, t] = await ms(() => Promise.all(Array.from({ length: many }, () => decompressTile(packed, { texFormat: 'jpg' }))));
    clearInterval(iv);
    console.log(JSON.stringify({ workers: tileWorkerCount(), tiles: many, wall_ms: Math.round(t), tiles_per_s: r1(many / (t / 1000)), max_loop_lag_ms: Math.round(lag) }));
  }
} else { console.log('usage: bench-tile-transforms.mjs meshopt <copc url> [tiles] | decompress <glb> [runs]'); }
process.exit(0);

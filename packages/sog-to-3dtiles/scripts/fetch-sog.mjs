#!/usr/bin/env node
/**
 * fetch-sog.mjs — download a full PlayCanvas Streamed SOG dataset (lod-meta.json +
 * every chunk's meta.json + its WebP textures + optional environment) to a local dir.
 *
 *   node scripts/fetch-sog.mjs <baseUrl> <outDir>
 * e.g. node scripts/fetch-sog.mjs https://code.playcanvas.com/examples_data/example_skatepark_02/ ../sample-data/input/sog/skatepark
 */
import fs from 'fs/promises';
import path from 'path';

const [baseUrl, outDir] = process.argv.slice(2);
if (!baseUrl || !outDir) { console.error('usage: fetch-sog.mjs <baseUrl> <outDir>'); process.exit(1); }
const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';

let n = 0;
async function get(rel) {
  const url = base + rel;
  const dest = path.join(outDir, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(dest, buf);
  if (++n % 25 === 0) process.stdout.write(`\r  ${n} files`);
  return buf;
}

const meta = JSON.parse((await get('lod-meta.json')).toString('utf8'));
console.log(`  ${meta.filenames.length} chunks, ${meta.lodLevels} LOD levels`);

// Each chunk: its meta.json + every file it references (in the same chunk dir).
for (const chunkMetaRel of meta.filenames) {
  const chunkMeta = JSON.parse((await get(chunkMetaRel)).toString('utf8'));
  const dir = path.posix.dirname(chunkMetaRel);
  const files = new Set();
  for (const k of Object.keys(chunkMeta)) {
    const f = chunkMeta[k]?.files;
    if (Array.isArray(f)) for (const name of f) files.add(name);
  }
  for (const f of files) await get(path.posix.join(dir, f));
}

// Optional environment (may be a bundled .sog or an unbundled meta.json).
if (meta.environment) {
  try {
    if (meta.environment.endsWith('.sog')) {
      await get(meta.environment);                       // bundled — single file
    } else {
      const envMeta = JSON.parse((await get(meta.environment)).toString('utf8'));
      const dir = path.posix.dirname(meta.environment);
      for (const k of Object.keys(envMeta)) {
        const f = envMeta[k]?.files;
        if (Array.isArray(f)) for (const name of f) await get(path.posix.join(dir, name));
      }
    }
  } catch (e) { console.warn('\n  env fetch skipped:', e.message); }
}

process.stdout.write(`\r  ${n} files downloaded\n`);
console.log(`Done → ${outDir}`);

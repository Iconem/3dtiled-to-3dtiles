/**
 * fetch-source.js — resolve a convert() input that may be a LOCAL path or a REMOTE URL.
 *
 * Shared by the CLI / JS API (this package) and the live tile-server middleware, so "local file,
 * remote static file, or remote server endpoint" works uniformly everywhere. For directory formats
 * we mirror the sibling files each converter reads (Potree 2.0, LCC, SOG); single-file formats
 * (COPC/RAD/SLPK) download the one file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const isRemote = s => /^https?:\/\//i.test(s);

async function fetchTo(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
const tryFetch = (url, dest) => fetchTo(url, dest).catch(() => {});

// ── Potree 1.x full-tree mirror ─────────────────────────────────────────────
// Potree 1.x datasets have per-node files (hundreds to thousands).  We walk the
// same tree structure that potree1.js reads offline, but over HTTP, writing each
// file to `dir` so the offline converter can then run against it as a local path.
//
// Two layouts:
//   inline  (v1.4): cloud.js has `hierarchy: [[name,n], …]`; data files are flat
//                   under `<octreeDir>/<name>.<ext>`.
//   hrc     (v1.7): `hierarchyStepSize` controls chunk depth; hierarchy in
//                   `<octreeDir>/r/<5-char-dirs>/<name>.hrc` (5 B/node); data
//                   files alongside each chunk dir.
async function mirrorPotree1(base, dir) {
  // 1. cloud.js
  const cloudUrl = base + 'cloud.js';
  const cloudBuf = await (async () => { const r = await fetch(cloudUrl); if (!r.ok) throw new Error(`fetch ${cloudUrl} → ${r.status}`); return Buffer.from(await r.arrayBuffer()); })();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'cloud.js'), cloudBuf);

  // 2. Parse cloud.js leniently (may have a trailing HMR footer from dev-servers).
  const text = cloudBuf.toString('utf8');
  let cloud;
  try { cloud = JSON.parse(text); }
  catch {
    const s = text.indexOf('{'); let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc=false; else if (c==='\\') esc=true; else if (c==='"') inStr=false; }
      else if (c==='"') inStr=true; else if (c==='{') depth++;
      else if (c==='}' && --depth===0) { cloud=JSON.parse(text.slice(s,i+1)); break; }
    }
  }
  if (!cloud) throw new Error('Potree 1.x cloud.js: could not parse JSON');

  const octreeDir = cloud.octreeDir || 'data';
  const stepSize  = cloud.hierarchyStepSize ?? 5;
  const isLaz     = typeof cloud.pointAttributes === 'string' && /LAZ/i.test(cloud.pointAttributes);
  const inline    = Array.isArray(cloud.hierarchy);
  const ext       = isLaz ? 'laz' : 'bin';

  const tryGet = (rel) => tryFetch(base + rel, path.join(dir, rel));

  if (inline) {
    // v1.4: all node names in cloud.js; data files are flat
    for (const [name] of cloud.hierarchy) {
      await tryGet(`${octreeDir}/${name}.${ext}`);
    }
  } else {
    // v1.7: chunk-dir layout; walk .hrc files to discover the full tree
    const chunkDirs = (name) => {
      const idx = name.substring(1), parts = Math.floor(idx.length / stepSize);
      const segs = ['r'];
      for (let i = 0; i < parts; i++) segs.push(idx.substr(i * stepSize, stepSize));
      return segs;
    };
    const hrcRel  = (name) => [octreeDir, ...chunkDirs(name), `${name}.hrc`].join('/');
    const nodeRel = (name) => [octreeDir, ...chunkDirs(name), `${name}.${ext}`].join('/');

    async function walkHrc(name) {
      const rel = hrcRel(name);
      await tryGet(rel);
      let buf; try { buf = await fs.readFile(path.join(dir, rel)); } catch { return; }
      const depthBase = name.length;
      const queue = [name]; let rec = 0; const boundary = [];
      while (queue.length && rec * 5 < buf.length) {
        const nm = queue.shift();
        const mask = buf.readUInt8(rec * 5);
        rec++;
        // Every listed node, whatever count it records: PotreeConverter writes 0 for a leaf whose file holds its points.
        await tryGet(nodeRel(nm));
        const depthInChunk = nm.length - depthBase;
        for (let c = 0; c < 8; c++) {
          if (!((mask >> c) & 1)) continue;
          const cn = nm + c;
          if (depthInChunk + 1 >= stepSize) boundary.push(cn);
          else queue.push(cn);
        }
      }
      for (const b of boundary) await walkHrc(b);
    }
    await walkHrc('r');
  }
  return dir;
}

/**
 * Download a remote dataset into `dir`, returning the local input path to hand to a converter.
 * @param {string} src  remote URL (the index file for directory formats; the file for single-file formats)
 * @param {string} fmt  resolved format id
 * @param {string} dir  destination directory
 */
export async function mirrorRemote(src, fmt, dir) {
  const clean = src.split('?')[0];
  const base = clean.slice(0, clean.lastIndexOf('/') + 1);
  const name = clean.slice(clean.lastIndexOf('/') + 1) || 'input';
  const get = (rel) => fetchTo(base + rel, path.join(dir, rel));

  if (fmt === 'potree') {
    if (/cloud\.js(\?|$)/i.test(clean)) {
      // Potree 1.x: walk cloud.js + .hrc hierarchy + all per-node data files.
      // Can be hundreds–thousands of files; caching means subsequent requests are instant.
      console.log(`[fetch-source] Potree 1.x: mirroring full tree from ${base} …`);
      await mirrorPotree1(base, dir);
      return dir;
    }
    // Potree 2.0: exactly 3 files.
    await get('metadata.json'); await get('hierarchy.bin'); await get('octree.bin');
    return dir;
  }
  if (fmt === 'lcc') {                                      // meta.lcc (+ index.bin, data.bin, optional shcoef.bin)
    await get(name);
    for (const f of ['index.bin', 'data.bin', 'shcoef.bin']) await tryFetch(base + f, path.join(dir, f));
    return dir;
  }
  if (fmt === 'sog') {                                      // lod-meta.json + per-chunk meta.json + the files each chunk references
    const r = await fetch(base + name); if (!r.ok) throw new Error(`fetch ${base + name} → ${r.status}`);
    const lod = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'lod-meta.json'), JSON.stringify(lod));
    if (lod.environment) await tryFetch(base + lod.environment, path.join(dir, lod.environment));
    for (const cm of lod.filenames || []) {
      await get(cm);
      const cj = JSON.parse(await fs.readFile(path.join(dir, cm), 'utf8'));
      const cdir = path.posix.dirname(cm);
      for (const k of Object.keys(cj)) {
        const files = cj[k]?.files;
        if (Array.isArray(files)) for (const fn of files) await get(path.posix.join(cdir, fn));
      }
    }
    return path.join(dir, 'lod-meta.json');
  }
  await get(name);                                          // single-file: copc / rad / i3s-slpk
  return path.join(dir, name);
}

/**
 * Normalise a convert() input to a local path. Local paths (incl. file://) pass through; remote URLs
 * are mirrored into a temp dir keyed by URL+format. Returns { input, format, cleanup }.
 */
export async function resolveSource(src, fmt) {
  if (!isRemote(src)) return { input: src.startsWith('file://') ? fileURLToPath(src) : src, format: fmt, cleanup: null };
  const key = crypto.createHash('sha1').update(`${fmt}|${src}`).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), '3dtiles-convert-src', key);
  const input = await mirrorRemote(src, fmt, dir);
  return { input, format: fmt, cleanup: dir };
}

/**
 * 3dtiles-convert — the meta-converter. Detects any supported input and dispatches to the
 * matching converter, producing 3D Tiles. CLI (cli.js) and JS/TS API (this module) share this.
 *
 * Each converter is an `packages/<fmt>-to-3dtiles` workspace package exporting a uniform
 * `convert(input, outDir, opts)`. Dispatch is **in-process** (`import` the module) by default;
 * it falls back to spawning the CLI only when the caller passes format-specific CLI flags
 * (`opts.extraArgs`) that the in-process options object doesn't model.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectFormat, detectFormatByName } from '3dtiles-convert-core';
import { isRemote, resolveSource } from './fetch-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// format → { module: bare workspace name (in-process), script: CLI path (child-process fallback) }.
const REGISTRY = {
  rad:    { module: 'rad-to-3dtiles',    script: 'packages/rad-to-3dtiles/src/index.js' },
  sog:    { module: 'sog-to-3dtiles',    script: 'packages/sog-to-3dtiles/src/index.js' },
  lcc:    { module: 'lcc-to-3dtiles',    script: 'packages/lcc-to-3dtiles/src/index.js' },
  lcc2:   { module: 'lcc-to-3dtiles',    script: 'packages/lcc-to-3dtiles/src/index.js' },   // same package, told apart by the *.lcc2 manifest
  copc:   { module: 'copc-to-3dtiles',   script: 'packages/copc-to-3dtiles/src/index.js' },
  potree: { module: 'potree-to-3dtiles', script: 'packages/potree-to-3dtiles/src/index.js' },
  i3s:    { module: 'i3s-to-3dtiles',    script: 'packages/i3s-to-3dtiles/src/index.js' },
  nexus:  { module: 'nexus-to-3dtiles',  script: 'packages/nexus-to-3dtiles/src/index.js' },   // .nxs / .nxz (one file)
};

/**
 * Unpack a self-contained 3D Tiles package (.3tz ZIP / .3dtiles SQLite) into a plain tileset
 * directory (tileset.json + tile files). This is the meta-converter's "package → 3D Tiles" path:
 * the content is already 3D Tiles, so converting just means extracting the container.
 */
async function unpackPackage(input, outDir) {
  const lower = input.toLowerCase();
  await fs.mkdir(outDir, { recursive: true });
  const writeEntry = async (key, bytes) => {
    if (key === '@3dtilesIndex1@' || !bytes?.length) return false;   // .3tz index entry — not a tile
    const dest = path.join(outDir, key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, Buffer.from(bytes));
    return true;
  };

  let count = 0;
  if (lower.endsWith('.3tz')) {
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await fs.readFile(input)));
    for (const [name, bytes] of Object.entries(files)) { if (await writeEntry(name, bytes)) count++; }
  } else if (lower.endsWith('.3dtiles')) {
    const { default: initSqlJs } = await import('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(await fs.readFile(input)));
    const r = db.exec('SELECT key, content FROM media');
    if (r.length) for (const [key, content] of r[0].values) { if (await writeEntry(key, content)) count++; }
    db.close();
  } else {
    throw new Error(`Not a package file: ${input}`);
  }
  console.log(`[package] unpacked ${count} entries → ${outDir}`);
  return { format: 'package', outDir, tiles: count };
}

/** Map JS options → the underlying converter's CLI flags (only those it understands). */
function optsToFlags(fmt, opts = {}) {
  const f = [];
  if (opts.scale != null)   f.push(`--scale=${opts.scale}`);
  if (opts.geScale != null) f.push(`--ge-scale=${opts.geScale}`);
  if (opts.geLayer != null) f.push(`--ge-layer=${opts.geLayer}`);
  if (opts.centroidsOnly)   f.push('--centroids-only');
  if (Array.isArray(opts.extraArgs)) f.push(...opts.extraArgs);
  return f;
}

/**
 * Convert any supported input to 3D Tiles.
 * @param {string} input   path to the source (file or dataset dir)
 * @param {string} outDir  output directory (tileset.json + tiles/)
 * @param {object} [opts]  { format?, scale?, geScale?, geLayer?, centroidsOnly?, extraArgs?, onLog? }
 * @returns {Promise<{format:string, outDir:string}>}
 */
export async function convert(input, outDir, opts = {}) {
  // Resolve format first — remote URLs can't stat sibling files, so detect by basename for those.
  const format = opts.format
    || (isRemote(input) ? detectFormatByName(input) : await detectFormat(input));
  if (!format) throw new Error(`Could not detect input format for "${input}". Pass { format } explicitly.`);
  // A virtual point cloud indexes files that are converted one by one; as a whole it is served, not converted.
  if (format === 'vpc') throw new Error('A .vpc is not converted as a whole: serve it (`3dtiled serve <url>.vpc`, or /stream/tileset.json?format=vpc&url=…), or convert each COPC file it lists.');

  // Remote input → download (with the sibling files the format needs) to a temp dir, then convert locally.
  if (isRemote(input)) {
    // onSourceFailure may throw to stop on a file it cannot read; onSourceProgress(done, total) follows the download.
    const { input: localInput } = await resolveSource(input, format, {
      ...(opts.onSourceFailure && { onFailure: opts.onSourceFailure }), onProgress: opts.onSourceProgress,
    });
    opts.onSourceDone?.();
    input = localInput;
  }

  // Self-contained packages (.3tz / .3dtiles) → unpack to a plain tileset dir (no geometry convert).
  if (format === 'package') return unpackPackage(input, outDir);

  const entry = REGISTRY[format];
  if (!entry) throw new Error(`No converter registered for format "${format}".`);

  // In-process dispatch (preferred). Fall back to child-process only when the caller passed
  // format-specific CLI flags (extraArgs) that the in-process options object doesn't model.
  const needsCli = Array.isArray(opts.extraArgs) && opts.extraArgs.length > 0;
  if (entry.module && !needsCli) {
    const mod = await import(entry.module);
    if (typeof mod.convert !== 'function') throw new Error(`Converter "${entry.module}" does not export convert().`);
    const r = await mod.convert(input, outDir, opts);
    return { format, outDir, ...(r && typeof r === 'object' ? r : {}) };
  }
  // child-process dispatch to the standalone converter (legacy / extraArgs path)
  const script = path.join(root, entry.script);
  const args = [script, input, outDir, ...optsToFlags(format, opts)];
  await new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, args, { stdio: opts.onLog ? 'pipe' : 'inherit' });
    if (opts.onLog && cp.stdout) cp.stdout.on('data', d => opts.onLog(String(d)));
    if (opts.onLog && cp.stderr) cp.stderr.on('data', d => opts.onLog(String(d)));
    cp.on('error', reject);
    cp.on('exit', code => code === 0 ? resolve() : reject(new Error(`${format} converter exited ${code}`)));
  });
  return { format, outDir };
}

export { detectFormat };
export const supportedFormats = [...Object.keys(REGISTRY), 'package'];

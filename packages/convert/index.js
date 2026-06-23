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
import path from 'path';
import { fileURLToPath } from 'url';
import { detectFormat } from '3dtiles-convert-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// format → { module: bare workspace name (in-process), script: CLI path (child-process fallback) }.
const REGISTRY = {
  rad:    { module: 'rad-to-3dtiles',    script: 'packages/rad-to-3dtiles/src/index.js' },
  sog:    { module: 'sog-to-3dtiles',    script: 'packages/sog-to-3dtiles/src/index.js' },
  lcc:    { module: 'lcc-to-3dtiles',    script: 'packages/lcc-to-3dtiles/src/index.js' },
  copc:   { module: 'copc-to-3dtiles',   script: 'packages/copc-to-3dtiles/src/index.js' },
  potree: { module: 'potree-to-3dtiles', script: 'packages/potree-to-3dtiles/src/index.js' },
  i3s:    { module: 'i3s-to-3dtiles',    script: 'packages/i3s-to-3dtiles/src/index.js' },
};

/** Map JS options → the underlying converter's CLI flags (only those it understands). */
function optsToFlags(fmt, opts = {}) {
  const f = [];
  if (opts.scale != null)   f.push(`--scale=${opts.scale}`);
  if (opts.geScale != null) f.push(`--ge-scale=${opts.geScale}`);
  if (opts.geLayer != null) f.push(`--ge-layer=${opts.geLayer}`);
  if (Array.isArray(opts.extraArgs)) f.push(...opts.extraArgs);
  return f;
}

/**
 * Convert any supported input to 3D Tiles.
 * @param {string} input   path to the source (file or dataset dir)
 * @param {string} outDir  output directory (tileset.json + tiles/)
 * @param {object} [opts]  { format?, scale?, geScale?, geLayer?, extraArgs?, onLog? }
 * @returns {Promise<{format:string, outDir:string}>}
 */
export async function convert(input, outDir, opts = {}) {
  const format = opts.format || await detectFormat(input);
  if (!format) throw new Error(`Could not detect input format for "${input}". Pass { format } explicitly.`);
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
export const supportedFormats = Object.keys(REGISTRY);

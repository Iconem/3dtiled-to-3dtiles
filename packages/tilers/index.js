/**
 * index.js (tilers) — the **one-stop tiler**: raw, untiled input (a LAS, a splat PLY) → the right third-party tiler →
 * an output this repo already streams (a COPC, a Potree 2 folder, a streamed SOG).
 *
 * This package finds a tool on the machine, fetches it when its authors publish a binary, checks the download's hash,
 * builds the tool's command line from validated options, and runs it. The tools and their options are in tools.js.
 *
 *   listTools()                          the manifest, as plain data (for a form)
 *   detectTool(id)                       where the tool is, or that it is missing and whether it can be fetched
 *   installTool(id)                      download, verify, unpack into the tools folder
 *   planRun(id, input, outDir, options)  the commands a run would execute, without running them
 *   runTool(id, input, outDir, options)  run them; resolves with what was written and how to stream it
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { TOOLS, toolById } from './tools.js';

export { TOOLS, toolById };

const isWin = process.platform === 'win32';
const platformKey = `${process.platform}-${process.arch}`;

/** Where downloaded tools live: TILED_TOOLS_DIR, else the app's data folder. One folder per tool and version. */
export function toolsDir() {
  if (process.env.TILED_TOOLS_DIR) return process.env.TILED_TOOLS_DIR;
  if (isWin && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, '3D Tiled', 'tools');
  return path.join(os.homedir(), '.cache', '3dtiled', 'tools');
}

/** The manifest without its functions: what a form needs. */
export function listTools() {
  return TOOLS.map((t) => ({
    id: t.id, name: t.name, summary: t.summary, homepage: t.homepage, licence: t.licence, inputs: t.inputs,
    output: { format: t.output.format, label: t.output.label },
    delivery: t.provide.bundled ? 'bundled' : t.provide.download ? 'download' : 'detect',
    version: t.provide.download?.version ?? null,
    downloadable: !!t.provide.download?.[platformKey],
    downloadBytes: t.provide.download?.[platformKey]?.bytes ?? null,
    options: t.options,
  }));
}

/** The tools that take this file, by its extension, in manifest order. */
export function toolsFor(input) {
  const ext = /\.copc\.laz$/i.test(input) ? 'copc.laz' : path.extname(input).slice(1).toLowerCase();
  return TOOLS.filter((t) => t.inputs.includes(ext)).map((t) => t.id);
}

// ── finding a tool ────────────────────────────────────────────────────────────────────────────────────────────────

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** `name` on PATH (with PATHEXT on Windows), or null. */
export function onPath(name, env = process.env) {
  const exts = isWin ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) { const p = path.join(dir, name + ext); if (isFile(p)) return p; if (isWin && isFile(p.toLowerCase())) return p.toLowerCase(); }
  }
  return null;
}

const versionKey = (name) => (name.match(/\d+/g) || []).map((n) => n.padStart(4, '0')).join('.');
/**
 * QGIS and OSGeo4W installs on this machine, newest first: QGIS ships PDAL and untwine, so a user who has QGIS has
 * both tools already. Windows layout: `C:\Program Files\QGIS <version>` and `C:\OSGeo4W*`, each an OSGeo4W tree
 * (`bin`, `apps/qgis`, `share`).
 */
export function qgisRoots(env = process.env) {
  if (!isWin) return [];
  const roots = [];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)) {
    let names = []; try { names = fs.readdirSync(base); } catch { /* no such folder */ }
    for (const n of names) if (/^QGIS /i.test(n)) roots.push(path.join(base, n));
  }
  roots.sort((a, b) => (versionKey(path.basename(b)) < versionKey(path.basename(a)) ? -1 : 1));
  const drive = (env.SystemDrive || 'C:') + path.sep;
  let top = []; try { top = fs.readdirSync(drive); } catch { /* unreadable */ }
  for (const n of top) if (/^OSGeo4W/i.test(n)) roots.push(path.join(drive, n));
  return [...new Set(roots)];
}

// An executable inside a QGIS / OSGeo4W tree needs that tree's DLLs and data: its `bin` on PATH, PROJ and GDAL data.
function osgeoEnv(root) {
  const share = path.join(root, 'share');
  return { PATH: [path.join(root, 'bin'), path.join(root, 'apps', 'qgis', 'bin'), process.env.PATH || process.env.Path || ''].join(path.delimiter),
           PROJ_DATA: path.join(share, 'proj'), PROJ_LIB: path.join(share, 'proj'), GDAL_DATA: path.join(share, 'gdal') };
}

const require_ = createRequire(import.meta.url);

// A script of one of our own dependencies ({ package, script }): the package is found through its entry point (its
// `exports` need not list the script), then the script inside it.
function bundledScript({ package: name, script }) {
  let dir;
  try { dir = path.dirname(require_.resolve(name)); } catch { return null; }
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (isFile(pkg)) { try { if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === name) { const f = path.join(dir, script); return isFile(f) ? f : null; } } catch { /* keep walking */ } }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}

/**
 * Where a tool is.
 * @returns {{id:string, status:'ready'|'missing', source?:string, exe?:string[], env?:object, version?:string|null,
 *            downloadable:boolean, hint?:string}}
 *   `exe`: the argv prefix that runs it. `source`: bundled, env, downloaded, path, qgis, pixi.
 */
export function detectTool(id) {
  const tool = toolById(id);
  if (!tool) throw new Error(`unknown tool "${id}" (known: ${TOOLS.map((t) => t.id).join(', ')})`);
  const p = tool.provide, dl = p.download?.[platformKey];
  const found = (source, exe, extra = {}) => ({ id, status: 'ready', source, exe, version: null, downloadable: !!dl, ...extra });

  if (p.bundled) {
    const script = bundledScript(p.bundled);
    return script ? found('bundled', [process.execPath, script]) : { id, status: 'missing', downloadable: false, hint: `${p.bundled.package} is not installed: run pnpm install` };
  }
  if (p.env && process.env[p.env]) {
    if (isFile(process.env[p.env])) return found('env', [process.env[p.env]], { hint: `from ${p.env}` });
    return { id, status: 'missing', downloadable: !!dl, hint: `${p.env} points to ${process.env[p.env]}, which is not a file` };
  }
  if (dl) {
    const exe = path.join(toolsDir(), id, p.download.version, dl.exe);
    if (isFile(exe)) return found('downloaded', [exe], { version: p.download.version });
  }
  for (const name of p.path ?? []) { const exe = onPath(name); if (exe) return found('path', [exe]); }
  for (const root of p.qgis ? qgisRoots() : []) {
    for (const rel of p.qgis) { const exe = path.join(root, rel); if (isFile(exe)) return found('qgis', [exe], { env: osgeoEnv(root), hint: `in ${path.basename(root)}` }); }
  }
  if (p.pixi) { const exe = path.join(os.homedir(), '.pixi', 'bin', p.pixi + (isWin ? '.exe' : '')); if (isFile(exe)) return found('pixi', [exe]); }
  const hint = dl ? `not installed: ${tool.name} ${p.download.version} can be downloaded (${(dl.bytes / 1e6).toFixed(0)} MB) from its release page`
    : p.qgis ? `not found: install QGIS (it ships ${tool.name}), or put it on PATH${p.env ? `, or set ${p.env}` : ''}`
    : `not found: put it on PATH${p.env ? ` or set ${p.env}` : ''}${p.download ? ` (no download is published for ${platformKey})` : ''}`;
  return { id, status: 'missing', downloadable: !!dl, hint };
}

// ── fetching a tool ───────────────────────────────────────────────────────────────────────────────────────────────

/** Every file of a ZIP held in memory → { name: bytes }. STORED and DEFLATE entries, no ZIP64: release archives. */
export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a ZIP archive');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`"${name}" uses ZIP compression method ${method}`);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return files;
}

/**
 * Download a tool's release asset, check it against the pinned SHA-256, unpack it into the tools folder.
 * The folder is written under a temporary name and renamed at the end, so an interrupted install leaves nothing
 * that looks installed. A tool already there is left alone.
 * @param {string} id
 * @param {{log?:(line:string)=>void, fetch?:typeof fetch, force?:boolean}} [o]
 */
export async function installTool(id, o = {}) {
  const tool = toolById(id), log = o.log ?? (() => {});
  if (!tool) throw new Error(`unknown tool "${id}"`);
  const dl = tool.provide.download?.[platformKey];
  if (!dl) throw new Error(`${tool.name} has no download for ${platformKey}: ${detectTool(id).hint ?? 'install it yourself'}`);
  const version = tool.provide.download.version, dir = path.join(toolsDir(), id, version), exe = path.join(dir, dl.exe);
  if (isFile(exe) && !o.force) { log(`${tool.name} ${version} is already installed in ${dir}`); return { id, version, dir, exe, downloaded: false }; }

  log(`Downloading ${tool.name} ${version} (${(dl.bytes / 1e6).toFixed(0)} MB) from ${new URL(dl.url).host}…`);
  log(`  ${dl.url}`);
  const r = await (o.fetch ?? fetch)(dl.url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${dl.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== dl.sha256) throw new Error(`${tool.name}: the download does not match its pinned SHA-256 (got ${sha}, expected ${dl.sha256}). Nothing was installed.`);
  log(`  SHA-256 ${sha.slice(0, 16)}… matches`);

  const files = unzip(buf), names = Object.keys(files);
  // A release zip often wraps everything in one folder: drop it, so that the executable is where the manifest says.
  const top = names[0].split('/')[0], wrapped = names.every((n) => n.startsWith(top + '/'));
  const tmp = `${dir}.tmp-${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  for (const name of names) {
    const rel = wrapped ? name.slice(top.length + 1) : name;
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error(`unsafe path in the archive: ${name}`);
    const dest = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, files[name]);
    if (!isWin) await fsp.chmod(dest, 0o755).catch(() => {});
  }
  if (!isFile(path.join(tmp, dl.exe))) { await fsp.rm(tmp, { recursive: true, force: true }); throw new Error(`${dl.exe} is not in the archive (${names.slice(0, 5).join(', ')}…)`); }
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  await fsp.rename(tmp, dir);
  log(`  installed in ${dir} (${names.length} files). Licence: ${tool.licence}, ${tool.homepage}`);
  return { id, version, dir, exe, downloaded: true };
}

// ── options and commands ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The options a run uses: every option of the tool, given or defaulted, checked against its declaration. An option
 * the tool does not declare, or a value outside its range, is an error: nothing reaches a command line unchecked.
 */
export function resolveOptions(tool, given = {}) {
  const known = new Set(tool.options.map((o) => o.key));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new Error(`${tool.id} has no option "${k}" (it has: ${[...known].join(', ')})`);
  const out = {};
  for (const o of tool.options) {
    let v = given[o.key];
    if (v === undefined || v === null || v === '') { out[o.key] = o.default; continue; }
    if (o.type === 'bool') v = v === true || v === 'true' || v === '1' || v === 1;
    else if (o.type === 'int' || o.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v) || (o.type === 'int' && !Number.isInteger(v))) throw new Error(`${o.key}: ${o.type === 'int' ? 'a whole number' : 'a number'} is expected`);
      if ((o.min != null && v < o.min) || (o.max != null && v > o.max)) throw new Error(`${o.key}: between ${o.min} and ${o.max} (got ${v})`);
    } else if (o.type === 'enum') {
      v = String(v);
      if (!o.values.includes(v)) throw new Error(`${o.key}: one of ${o.values.join(', ')} (got ${v})`);
    } else {
      v = String(v);
      // free text ends up as a command-line argument: no control characters, and it must not look like another flag
      if (/[\0-\x1f]/.test(v) || v.trim().startsWith('-')) throw new Error(`${o.key}: not a valid value`);
      v = v.trim();
    }
    out[o.key] = v;
  }
  return out;
}

/**
 * What a run would do: the detected tool, the validated options, and the commands in order.
 * @returns {{tool:object, found:object, options:object, steps:{cmd:string[], label:string}[], output:{format:string, path:string}, tmpDir:string}}
 */
export function planRun(id, input, outDir, given = {}, found = detectTool(id)) {
  const tool = toolById(id);
  if (!tool) throw new Error(`unknown tool "${id}"`);
  if (found.status !== 'ready') throw new Error(`${tool.name} is not available: ${found.hint}`);
  const inAbs = path.resolve(input), outAbs = path.resolve(outDir);
  const ext = path.extname(inAbs).slice(1).toLowerCase();
  if (!tool.inputs.includes(ext)) throw new Error(`${tool.name} takes ${tool.inputs.map((e) => '.' + e).join(', ')}, not .${ext}`);
  const ctx = { exe: found.exe, input: inAbs, outDir: outAbs, tmpDir: path.join(outAbs, '.tiler-tmp'), name: path.basename(inAbs, path.extname(inAbs)), opt: resolveOptions(tool, given) };
  const out = tool.output.path(ctx);
  return { tool, found, options: ctx.opt, steps: tool.steps(ctx), output: { format: tool.output.format, path: out, proof: tool.output.proof?.(ctx) ?? out }, tmpDir: ctx.tmpDir };
}

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
export const commandLine = (cmd) => cmd.map(quote).join(' ');

/**
 * Run a tool on an input.
 * @param {{log?:(line:string)=>void, stdio?:'inherit'|'pipe', onOutput?:(chunk:string)=>void, signal?:AbortSignal, overwrite?:boolean}} [o]
 * @returns {Promise<{tool:string, format:string, output:string, outDir:string, seconds:number}>} what to stream afterwards
 */
export async function runTool(id, input, outDir, given = {}, o = {}) {
  const log = o.log ?? ((l) => console.log(l));
  if (!fs.existsSync(input)) throw new Error(`no such input: ${input}`);
  const plan = planRun(id, input, outDir, given);
  const outAbs = path.resolve(outDir);
  const existing = fs.existsSync(outAbs) ? fs.readdirSync(outAbs) : [];
  if (existing.length && !o.overwrite) throw new Error(`the output folder is not empty: ${outAbs} (choose another, or pass --overwrite)`);
  await fsp.mkdir(plan.tmpDir, { recursive: true });
  log(`${plan.tool.name} (${plan.found.source}${plan.found.hint ? `, ${plan.found.hint}` : ''}) → ${plan.tool.output.label}`);
  const t0 = Date.now();
  try {
    for (const [i, step] of plan.steps.entries()) {
      log(`[${i + 1}/${plan.steps.length}] ${step.label}`);
      log(`$ ${commandLine(step.cmd)}`);
      const code = await new Promise((resolve, reject) => {
        const child = spawn(step.cmd[0], step.cmd.slice(1), { env: { ...process.env, ...(plan.found.env ?? {}) }, stdio: o.onOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], windowsHide: true });
        if (o.onOutput) { child.stdout.on('data', (d) => o.onOutput(String(d))); child.stderr.on('data', (d) => o.onOutput(String(d))); }
        const stop = () => { try { child.kill(); } catch { /* gone */ } };
        o.signal?.addEventListener('abort', stop, { once: true });
        child.once('error', (e) => reject(new Error(`could not start ${step.cmd[0]}: ${e.message}`)));
        child.once('close', (c) => { o.signal?.removeEventListener('abort', stop); resolve(c); });
      });
      if (o.signal?.aborted) throw new Error('cancelled');
      if (code !== 0) throw new Error(`${plan.tool.name} exited with code ${code} at step ${i + 1} (${step.label})`);
    }
  } finally {
    await fsp.rm(plan.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!fs.existsSync(plan.output.proof)) throw new Error(`${plan.tool.name} finished but did not write ${plan.output.proof}`);
  return { tool: id, format: plan.output.format, output: plan.output.path, outDir: outAbs, seconds: (Date.now() - t0) / 1000 };
}

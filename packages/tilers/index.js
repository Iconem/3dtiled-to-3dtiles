/**
 * index.js (tilers) — the **one-stop tiler**: raw, untiled input (a LAS, an OBJ, a splat PLY, a folder of them) → the
 * right third-party tiler → an output this repo opens (a COPC, a Potree folder, a streamed SOG, a 3D Tiles tileset).
 *
 * This package finds a tool on the machine, fetches it when its authors publish a binary, checks the download's hash,
 * builds the tool's command line from validated options, and runs it. The tools and their options are in tools.js.
 *
 *   listTools()                          the manifest, as plain data (for a form)
 *   describeInput(path)                  what a path is: a file or a folder, its extensions, which kind of PLY
 *   toolsFor(path)                       the tools that take it
 *   detectTool(id)                       where the tool is, or what is missing and whether it can be fetched
 *   installTool(id)                      download, verify, unpack into the tools folder (and its runtime, if any)
 *   planRun(id, input, outDir, options)  the commands a run would execute, without running them
 *   runTool(id, input, outDir, options)  run them; resolves with what was written and how to open it
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { TOOLS, RUNTIMES, toolById } from './tools.js';

export { TOOLS, RUNTIMES, toolById };

const isWin = process.platform === 'win32';
const platformKey = `${process.platform}-${process.arch}`;
/** The file a finished run leaves in its output folder: what was run, on what, with which options. */
export const RUN_MARKER = '.3dtiled-tiler.json';

/** Where downloaded tools live: TILED_TOOLS_DIR, else the app's data folder. One folder per tool and version. */
export function toolsDir() {
  if (process.env.TILED_TOOLS_DIR) return process.env.TILED_TOOLS_DIR;
  if (isWin && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, '3D Tiled', 'tools');
  return path.join(os.homedir(), '.cache', '3dtiled', 'tools');
}

const deliveryOf = (p) => (p.bundled ? 'bundled' : p.uv ? 'uv' : p.cargo ? 'cargo' : p.download ? 'download' : 'detect');

/** The manifest without its functions: what a form needs. */
export function listTools() {
  return TOOLS.map((t) => ({
    id: t.id, name: t.name, kind: t.kind, summary: t.summary, homepage: t.homepage, licence: t.licence,
    inputs: t.inputs, dir: t.dir ?? false, ply: t.ply ?? null,
    output: { format: t.output.format, label: t.output.label },
    delivery: deliveryOf(t.provide),
    version: t.provide.download?.version ?? t.provide.uv?.version ?? t.provide.cargo?.version ?? null,
    needs: t.provide.needs ? { runtime: t.provide.needs.runtime, name: RUNTIMES[t.provide.needs.runtime].name, min: t.provide.needs.min ?? null } : null,
    downloadable: !!t.provide.download?.[platformKey] || !!t.provide.uv || !!t.provide.cargo,
    downloadBytes: t.provide.download?.[platformKey]?.bytes ?? t.provide.uv?.approxBytes ?? t.provide.cargo?.bytes ?? null,
    options: t.options,
  }));
}

// ── what the input is ─────────────────────────────────────────────────────────────────────────────────────────────

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const extOf = (name) => (/\.copc\.laz$/i.test(name) ? 'copc.laz' : path.extname(name).slice(1).toLowerCase());

/**
 * Which kind of PLY a file is, from its header: `splats` (the properties 3DGS trainers write), `mesh` (it has
 * faces), else `points`. null when the header cannot be read.
 */
export function sniffPly(file) {
  let head;
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString('latin1', 0, n); } catch { return null; }
  if (!head.startsWith('ply')) return null;
  const end = head.indexOf('end_header');
  if (end >= 0) head = head.slice(0, end);
  if (/property\s+\w+\s+f_dc_0\b/.test(head) || /property\s+\w+\s+scale_0\b/.test(head)) return 'splats';
  const faces = head.match(/element\s+face\s+(\d+)/);
  return faces && Number(faces[1]) > 0 ? 'mesh' : 'points';
}

/**
 * What a path is, for choosing a tool.
 * @returns {{path:string, exists:boolean, dir:boolean, ext:string, exts:string[], ply:('points'|'splats'|'mesh'|null)}}
 *   a file: its extension (`exts` is that one). A folder: the extensions found in it, three levels deep at most.
 *   A path that does not exist is described from its name alone.
 */
export function describeInput(input) {
  const abs = path.resolve(input);
  if (isDirectory(abs)) {
    const exts = new Set();
    let seen = 0;
    const walk = (dir, depth) => {
      let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
      for (const e of entries) {
        if (++seen > 20000) return;
        if (e.isDirectory()) { if (depth < 3 && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); } else { const x = extOf(e.name); if (x) exts.add(x); }
      }
    };
    walk(abs, 0);
    return { path: abs, exists: true, dir: true, ext: '', exts: [...exts].sort(), ply: null };
  }
  const ext = extOf(abs), exists = isFile(abs);
  return { path: abs, exists, dir: false, ext, exts: ext ? [ext] : [], ply: ext === 'ply' && exists ? sniffPly(abs) : null };
}

const accepts = (tool, d) => (d.dir
  ? !!tool.dir && d.exts.some((e) => tool.inputs.includes(e))
  : tool.dir !== 'only' && tool.inputs.includes(d.ext) && (d.ext !== 'ply' || !d.ply || !tool.ply || tool.ply === d.ply));

/** The tools that take this file or folder, in manifest order. */
export function toolsFor(input) {
  const d = typeof input === 'string' ? describeInput(input) : input;
  return TOOLS.filter((t) => accepts(t, d)).map((t) => t.id);
}

// ── finding a tool ────────────────────────────────────────────────────────────────────────────────────────────────

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
  try { dir = path.dirname(require_.resolve(`${name}/package.json`)); }
  catch { try { dir = path.dirname(require_.resolve(name)); } catch { return null; } }
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (isFile(pkg)) { try { if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === name) { const f = path.join(dir, script); return isFile(f) ? f : null; } } catch { /* keep walking */ } }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
const exeName = (name) => name + (isWin ? '.exe' : '');

// The major version an executable reports (`java -version` → 25), or null. Asked once per path.
const majors = new Map();
function majorOf(rt, exe) {
  if (!rt.version) return null;
  if (!majors.has(exe)) {
    let major = null;
    try { const r = spawnSync(exe, rt.version.args, { encoding: 'utf8', timeout: 20000, windowsHide: true }); const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(rt.version.major); major = m ? Number(m[1]) : null; } catch { /* not runnable */ }
    majors.set(exe, major);
  }
  return majors.get(exe);
}

/**
 * Where a runtime is (RUNTIMES): its environment variable, the copy this app downloaded, JAVA_HOME, PATH. With `min`,
 * a found one that reports an older major version is passed over.
 * @returns {{id:string, status:'ready'|'missing', source?:string, exe?:string[], version?:string|null, downloadable:boolean, bytes:number|null, hint?:string}}
 */
export function detectRuntime(id, min = null) {
  const rt = RUNTIMES[id];
  if (!rt) throw new Error(`unknown runtime "${id}"`);
  const dl = rt.download?.[platformKey], base = { id, downloadable: !!dl, bytes: dl?.bytes ?? null };
  const fits = (exe) => !min || !rt.version || (majorOf(rt, exe) ?? 0) >= min;
  const found = (source, exe, version = null) => ({ ...base, status: 'ready', source, exe: [exe], version });
  const tooOld = [];
  const tryExe = (source, exe) => { if (!exe || !isFile(exe)) return null; if (fits(exe)) return found(source, exe); tooOld.push(`${exe} is version ${majorOf(rt, exe) ?? '?'}`); return null; };
  const hit = tryExe('env', rt.env && process.env[rt.env])
    ?? (dl && isFile(path.join(toolsDir(), id, rt.download.version, dl.exe)) ? found('downloaded', path.join(toolsDir(), id, rt.download.version, dl.exe), rt.download.version) : null)
    ?? (rt.javaHome && process.env.JAVA_HOME ? tryExe('JAVA_HOME', path.join(process.env.JAVA_HOME, 'bin', exeName('java'))) : null)
    ?? (rt.path ?? []).reduce((r, name) => r ?? tryExe('path', onPath(name)), null);
  if (hit) return hit;
  const why = `${rt.name}${min ? ` ${min} or newer` : ''} is not on this machine${tooOld.length ? ` (${tooOld.join('; ')})` : ''}`;
  return { ...base, status: 'missing', hint: dl ? `${why}: version ${rt.download.version} can be downloaded (${mb(dl.bytes)})` : `${why}: install it${rt.env ? `, or set ${rt.env}` : ''}` };
}

// The folder of a downloaded tool: two tools that are one binary (`provide.dir`) share it.
const installDir = (tool) => path.join(toolsDir(), tool.provide.dir ?? tool.id, tool.provide.download?.version ?? tool.provide.uv?.version ?? tool.provide.cargo?.version ?? '0');
const UV_DONE = '.installed';

/**
 * The machine's Rust build tool, for a tool published as source only: `cargo` on PATH or in ~/.cargo/bin, as an argv
 * prefix, or null. On Windows the MSVC toolchain is asked for when rustup has it: the GNU one needs MinGW's dlltool,
 * which a plain Rust install does not bring.
 */
let cargoFound;
export function findCargo() {
  if (cargoFound !== undefined) return cargoFound;
  const exe = onPath('cargo') ?? [path.join(os.homedir(), '.cargo', 'bin', exeName('cargo'))].find(isFile) ?? null;
  if (!exe) return (cargoFound = null);
  let toolchain = null;
  if (isWin) {
    try {
      const r = spawnSync(onPath('rustup') ?? path.join(path.dirname(exe), exeName('rustup')), ['toolchain', 'list'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      toolchain = (r.stdout ?? '').split(/\r?\n/).map((l) => l.split(' ')[0]).find((l) => /-msvc$/.test(l)) ?? null;
    } catch { /* no rustup: cargo's default toolchain */ }
  }
  return (cargoFound = toolchain ? [exe, `+${toolchain}`] : [exe]);
}

// The tool's own program, without its runtime: { source, file, env?, hint? } or null.
function locateOwn(tool) {
  const p = tool.provide, dl = p.download?.[platformKey];
  if (p.bundled) { const script = bundledScript(p.bundled); return script ? { source: 'bundled', file: script, exe: [process.execPath, script] } : null; }
  if (p.env && process.env[p.env]) return isFile(process.env[p.env]) ? { source: 'env', file: process.env[p.env], hint: `from ${p.env}` } : { broken: `${p.env} points to ${process.env[p.env]}, which is not a file` };
  if (dl) { const file = path.join(installDir(tool), dl.exe); if (isFile(file)) return { source: 'downloaded', file, version: p.download.version }; }
  if (p.uv) { const dir = installDir(tool), file = path.join(dir, 'bin', exeName(p.uv.bin)); if (isFile(file) && isFile(path.join(dir, UV_DONE))) return { source: 'downloaded', file, version: p.uv.version }; }
  if (p.cargo) { const file = path.join(installDir(tool), 'bin', exeName(p.cargo.bin)); if (isFile(file)) return { source: 'built', file, version: p.cargo.version }; }
  for (const name of p.path ?? []) { const file = onPath(name); if (file) return { source: 'path', file }; }
  for (const root of p.qgis ? qgisRoots() : []) {
    for (const rel of p.qgis) { const file = path.join(root, rel); if (isFile(file)) return { source: 'qgis', file, env: osgeoEnv(root), hint: `in ${path.basename(root)}` }; }
  }
  if (p.pixi) { const file = path.join(os.homedir(), '.pixi', 'bin', exeName(p.pixi)); if (isFile(file)) return { source: 'pixi', file }; }
  return null;
}

/**
 * Where a tool is.
 * @returns {{id:string, status:'ready'|'missing', source?:string, exe?:string[], env?:object, version?:string|null,
 *            downloadable:boolean, downloadBytes:number, missing:string[], hint?:string}}
 *   `exe`: the argv prefix that runs it. `source`: bundled, env, downloaded, path, qgis, pixi.
 *   When missing: `missing` names what a download would fetch (the tool, its runtime), `downloadBytes` their size,
 *   and `downloadable` whether all of it can be fetched.
 */
export function detectTool(id) {
  const tool = toolById(id);
  if (!tool) throw new Error(`unknown tool "${id}" (known: ${TOOLS.map((t) => t.id).join(', ')})`);
  const p = tool.provide, dl = p.download?.[platformKey];
  const own = locateOwn(tool);
  if (own?.broken) return { id, status: 'missing', downloadable: false, downloadBytes: 0, missing: [], hint: own.broken };
  const rt = p.needs ? detectRuntime(p.needs.runtime, p.needs.min) : null;
  if (own && (!rt || rt.status === 'ready')) {
    const exe = p.command ? p.command({ runtime: rt?.exe ?? [], file: own.file }) : own.exe ?? [own.file];
    const hint = [own.hint, rt ? `${RUNTIMES[rt.id].name}: ${rt.source === 'downloaded' ? 'downloaded by this app' : rt.exe[0]}` : null].filter(Boolean).join('; ');
    return { id, status: 'ready', source: own.source, exe, version: own.version ?? null, downloadable: !!dl || !!p.uv || !!p.cargo, downloadBytes: 0, missing: [], ...(own.env ? { env: own.env } : {}), ...(hint ? { hint } : {}) };
  }
  // what is missing, and whether a download would bring it
  const parts = [];
  if (!own) {
    if (p.bundled) return { id, status: 'missing', downloadable: false, downloadBytes: 0, missing: [], hint: `${p.bundled.package} is not installed: run pnpm install` };
    if (p.uv) {
      const uv = detectRuntime('uv');
      parts.push({ name: `${tool.name} ${p.uv.version} with its own Python`, bytes: p.uv.approxBytes, ok: true });
      if (uv.status !== 'ready') parts.push({ name: `${RUNTIMES.uv.name} ${RUNTIMES.uv.download.version}`, bytes: uv.bytes ?? 0, ok: uv.downloadable });
    } else if (p.cargo) {
      parts.push({ name: `the source of ${tool.name} ${p.cargo.version}, built here with cargo`, bytes: p.cargo.bytes, ok: !!findCargo(),
        why: `it is published as source only and needs the Rust toolchain to build: install it from https://rustup.rs${p.env ? `, or set ${p.env} to a built binary` : ''}` });
    } else parts.push({ name: dl ? `${tool.name} ${p.download.version}` : tool.name, bytes: dl?.bytes ?? 0, ok: !!dl });
  }
  if (rt && rt.status !== 'ready') parts.push({ name: `${RUNTIMES[rt.id].name} ${RUNTIMES[rt.id].download?.version ?? ''}`.trim(), bytes: rt.bytes ?? 0, ok: rt.downloadable, why: rt.hint });
  const downloadable = parts.every((x) => x.ok), downloadBytes = parts.reduce((n, x) => n + x.bytes, 0);
  const hint = downloadable
    ? `not installed: ${parts.map((x) => `${x.name} (${p.uv && x === parts[0] ? 'about ' : ''}${mb(x.bytes)})`).join(' and ')} can be downloaded`
    : !own && p.cargo ? `not installed: ${parts[0].why}`
    : !own && p.qgis ? `not found: install QGIS (it ships ${tool.name}), or put it on PATH${p.env ? `, or set ${p.env}` : ''}`
    : !own ? `not found: put it on PATH${p.env ? ` or set ${p.env}` : ''}${p.download ? ` (no download is published for ${platformKey})` : ''}`
    : rt.hint;
  return { id, status: 'missing', downloadable, downloadBytes, missing: parts.map((x) => x.name), hint };
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
 * One release asset → `dir`: downloaded to a file beside it while its SHA-256 is computed, compared with the pinned
 * one, then unpacked (a zip) or put in place (a program that is the asset itself). `dir` is written under a temporary
 * name and renamed at the end, so an interrupted install leaves nothing that looks installed.
 */
async function fetchAsset({ name, version, dl, dir, log, fetch: fetch_ = fetch }) {
  log(`Downloading ${name} ${version} (${mb(dl.bytes)}) from ${new URL(dl.url).host}…`);
  log(`  ${dl.url}`);
  const r = await fetch_(dl.url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${dl.url}`);
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  const part = `${dir}.download-${process.pid}`, tmp = `${dir}.tmp-${process.pid}`;
  const hash = createHash('sha256'), out = await fsp.open(part, 'w');
  let got = 0, said = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk); await out.write(chunk); got += chunk.length;
      if (dl.bytes > 40e6 && got - said >= dl.bytes / 10) { said = got; log(`  ${Math.min(99, Math.round(100 * got / dl.bytes))} %`); }
    }
  } finally { await out.close(); }
  try {
    const sha = hash.digest('hex');
    if (sha !== dl.sha256) throw new Error(`${name}: the download does not match its pinned SHA-256 (got ${sha}, expected ${dl.sha256}). Nothing was installed.`);
    log(`  SHA-256 ${sha.slice(0, 16)}… matches`);
    await fsp.rm(tmp, { recursive: true, force: true });
    let count = 1;
    if (dl.archive === 'file') {
      await fsp.mkdir(tmp, { recursive: true });
      await fsp.rename(part, path.join(tmp, dl.exe));
    } else {
      // some archives made on Windows name their entries with backslashes (Nexus): the same path either way
      const files = Object.fromEntries(Object.entries(unzip(await fsp.readFile(part))).map(([n, b]) => [n.replace(/\\/g, '/'), b]).filter(([n]) => !n.endsWith('/')));
      const names = Object.keys(files);
      // A release zip often wraps everything in one folder: drop it, so that the executable is where the manifest says.
      const top = names[0].split('/')[0], wrapped = names.every((n) => n.startsWith(top + '/'));
      for (const n of names) {
        const rel = wrapped ? n.slice(top.length + 1) : n;
        if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error(`unsafe path in the archive: ${n}`);
        const dest = path.join(tmp, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, files[n]);
        if (!isWin) await fsp.chmod(dest, 0o755).catch(() => {});
      }
      if (!isFile(path.join(tmp, dl.exe))) throw new Error(`${dl.exe} is not in the archive (${names.slice(0, 5).join(', ')}…)`);
      count = names.length;
    }
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
    return count;
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
    await fsp.rmdir(path.dirname(dir)).catch(() => {});      // the tool's folder, if this attempt made it and it is empty
    throw e;
  } finally { await fsp.rm(part, { force: true }).catch(() => {}); }
}

// A command of an install (uv), its output passed on line by line. Resolves with the exit code.
function runLogged(cmd, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const say = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(`  ${l}`); };
    child.stdout.on('data', say); child.stderr.on('data', say);
    child.once('error', (e) => reject(new Error(`could not start ${cmd[0]}: ${e.message}`)));
    child.once('close', resolve);
  });
}

/** Download a runtime (RUNTIMES) that is not on the machine. One already there is left alone. */
export async function installRuntime(id, min = null, o = {}) {
  const rt = RUNTIMES[id], log = o.log ?? (() => {}), found = detectRuntime(id, min);
  if (found.status === 'ready' && !o.force) return { id, exe: found.exe[0], downloaded: false };
  const dl = rt.download?.[platformKey];
  if (!dl) throw new Error(`${rt.name} has no download for ${platformKey}: ${found.hint}`);
  const dir = path.join(toolsDir(), id, rt.download.version);
  const count = await fetchAsset({ name: rt.name, version: rt.download.version, dl, dir, log, fetch: o.fetch });
  log(`  installed in ${dir} (${count} files). Licence: ${rt.licence}, ${rt.homepage}`);
  return { id, exe: path.join(dir, dl.exe), downloaded: true };
}

/**
 * Get a tool that is not on the machine: its release asset, checked against the pinned SHA-256 and unpacked into the
 * tools folder; the runtime it needs, the same way; or, for a Python tool, a pinned version installed by uv into a
 * private environment there. A tool already there is left alone.
 * @param {string} id
 * @param {{log?:(line:string)=>void, fetch?:typeof fetch, force?:boolean}} [o]
 */
export async function installTool(id, o = {}) {
  const tool = toolById(id), log = o.log ?? (() => {});
  if (!tool) throw new Error(`unknown tool "${id}"`);
  const p = tool.provide, dl = p.download?.[platformKey];
  if (!dl && !p.uv && !p.cargo) throw new Error(`${tool.name} has no download for ${platformKey}: ${detectTool(id).hint ?? 'install it yourself'}`);
  const version = p.download?.version ?? p.uv?.version ?? p.cargo.version, dir = installDir(tool);
  let downloaded = false;
  if (p.needs) downloaded = (await installRuntime(p.needs.runtime, p.needs.min, { log, fetch: o.fetch })).downloaded;

  const own = locateOwn(tool);
  if (own && !own.broken && !o.force) {
    if (!downloaded) log(`${tool.name} ${version} is already installed in ${dir}`);
    return { id, version, dir, exe: own.file, downloaded };
  }
  if (p.uv) {
    const uv = await installRuntime('uv', null, { log, fetch: o.fetch });
    log(`Installing ${p.uv.spec} with uv, into a private environment with its own Python ${p.uv.python}…`);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    // Everything uv writes stays in this folder: the environment, the Python it downloads, its cache, the launcher.
    const env = { ...process.env, UV_TOOL_DIR: path.join(dir, 'env'), UV_TOOL_BIN_DIR: path.join(dir, 'bin'), UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'),
                  UV_CACHE_DIR: path.join(dir, 'cache'), UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1' };
    const code = await runLogged([uv.exe, 'tool', 'install', '--managed-python', '--python', p.uv.python, '--force', p.uv.spec], env, log);
    const exe = path.join(dir, 'bin', exeName(p.uv.bin));
    if (code !== 0 || !isFile(exe)) { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); throw new Error(`uv could not install ${p.uv.spec} (exit code ${code}). Nothing was installed.`); }
    await fsp.rm(path.join(dir, 'cache'), { recursive: true, force: true }).catch(() => {});
    await fsp.writeFile(path.join(dir, UV_DONE), `${p.uv.spec}\n`);
    log(`  installed in ${dir}. Licence: ${tool.licence}, ${tool.homepage}`);
    return { id, version, dir, exe, downloaded: true };
  }
  if (p.cargo) {
    const cargo = findCargo();
    if (!cargo) throw new Error(`${tool.name} is published as source only and needs the Rust toolchain to build: install it from https://rustup.rs, then run this again.`);
    const src = `${dir}.src`, target = `${dir}.build`, exe = path.join(dir, 'bin', exeName(p.cargo.bin));
    try {
      // the source archive, hash-checked like a binary; its build tree stays outside the install folder
      await fetchAsset({ name: `the source of ${tool.name}`, version, dl: { ...p.cargo, exe: p.cargo.manifest }, dir: src, log, fetch: o.fetch });
      log(`Building ${p.cargo.bin} with ${path.basename(cargo[0])}${cargo[1] ? ` ${cargo[1]}` : ''} (a few minutes the first time: it compiles its dependencies)…`);
      const code = await runLogged([...cargo, 'build', '--release', '--locked', '--manifest-path', path.join(src, p.cargo.manifest), '--target-dir', target], { ...process.env, CARGO_TERM_COLOR: 'never' }, log);
      const built = path.join(target, 'release', exeName(p.cargo.bin));
      if (code !== 0 || !isFile(built)) throw new Error(`cargo could not build ${p.cargo.bin} (exit code ${code}). Nothing was installed.`);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(exe), { recursive: true });
      await fsp.copyFile(built, exe);
    } finally {
      await fsp.rm(src, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    log(`  installed in ${dir}. Licence: ${tool.licence}, ${tool.homepage}`);
    return { id, version, dir, exe, downloaded: true };
  }
  const count = await fetchAsset({ name: tool.name, version, dl, dir, log, fetch: o.fetch });
  log(`  installed in ${dir} (${count} file${count > 1 ? 's' : ''}). Licence: ${tool.licence}, ${tool.homepage}`);
  return { id, version, dir, exe: path.join(dir, dl.exe), downloaded: true };
}

// ── options and commands ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The options a run uses: every option of the tool, given or defaulted, checked against its declaration. An option
 * the tool does not declare, or a value outside its range, is an error: nothing reaches a command line unchecked.
 * `partial`: a required option left empty is not an error (for a form that is still being filled).
 */
export function resolveOptions(tool, given = {}, partial = false) {
  const known = new Set(tool.options.map((o) => o.key));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new Error(`${tool.id} has no option "${k}" (it has: ${[...known].join(', ')})`);
  const out = {};
  for (const o of tool.options) {
    let v = given[o.key];
    if (v === undefined || v === null || v === '') {
      if (o.required && !partial) throw new Error(`${o.key}: ${tool.name} needs it (${o.label}${o.placeholder ? `, e.g. ${o.placeholder}` : ''})`);
      out[o.key] = o.default; continue;
    }
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
      // (a proj4 string starts with "+", which no tool here reads as a flag)
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
  const d = describeInput(input), outAbs = path.resolve(outDir), list = tool.inputs.map((e) => '.' + e).join(', ');
  if (d.dir && !tool.dir) throw new Error(`${tool.name} takes one file (${list}), not a folder`);
  if (!d.dir && tool.dir === 'only') throw new Error(`${tool.name} takes a folder of ${list} files, not a file`);
  if (d.dir && !d.exts.some((e) => tool.inputs.includes(e))) throw new Error(`${tool.name} takes ${list}: none in ${d.path}`);
  if (!d.dir && !tool.inputs.includes(d.ext)) throw new Error(`${tool.name} takes ${list}, not .${d.ext}`);
  if (!d.dir && d.ext === 'ply' && d.ply && tool.ply && tool.ply !== d.ply) throw new Error(`${tool.name} reads a PLY of ${tool.ply}; this one holds ${d.ply === 'mesh' ? 'a mesh' : d.ply}`);
  if (outAbs === d.path || (d.dir && outAbs.startsWith(d.path + path.sep))) throw new Error('the output folder is inside the input folder: choose another');
  const ext = d.dir ? tool.inputs.find((e) => d.exts.includes(e)) : d.ext;
  const ctx = { exe: found.exe, input: d.path, isDir: d.dir, ext, outDir: outAbs, tmpDir: path.join(outAbs, '.tiler-tmp'),
                name: d.dir ? path.basename(d.path) : path.basename(d.path, path.extname(d.path)), opt: resolveOptions(tool, given) };
  const out = tool.output.path(ctx);
  return { tool, found, options: ctx.opt, steps: tool.steps(ctx), output: { format: tool.output.format, path: out, proof: tool.output.proof?.(ctx) ?? out }, tmpDir: ctx.tmpDir };
}

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
export const commandLine = (cmd) => cmd.map(quote).join(' ');
/** A step as one line: its command, or the file operation this package does itself. */
export const stepLine = (step) => (step.cmd ? commandLine(step.cmd) : step.copy ? `copy ${commandLine(step.copy)}` : `move ${commandLine(step.move)}`);

/**
 * Run a tool on an input.
 * @param {{log?:(line:string)=>void, onOutput?:(chunk:string)=>void, signal?:AbortSignal, overwrite?:boolean}} [o]
 * @returns {Promise<{tool:string, kind:string, format:string, output:string, outDir:string, seconds:number}>} what to open afterwards
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
      log(`$ ${stepLine(step)}`);
      if (step.copy) { await fsp.copyFile(step.copy[0], step.copy[1]); continue; }
      if (step.move) {
        if (!fs.existsSync(step.move[0])) throw new Error(`${plan.tool.name} did not write ${step.move[0]}`);
        await fsp.rename(step.move[0], step.move[1]).catch(async () => { await fsp.copyFile(step.move[0], step.move[1]); await fsp.rm(step.move[0], { force: true }); });
        continue;
      }
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
  const result = { tool: id, kind: plan.tool.kind, format: plan.output.format, output: plan.output.path, outDir: outAbs, seconds: (Date.now() - t0) / 1000 };
  // What made this folder: a record for whoever finds it later, and what lets the tile-server serve it (tilers-live.js).
  await fsp.writeFile(path.join(outAbs, RUN_MARKER), JSON.stringify({ ...result, input: path.resolve(input), options: plan.options, version: plan.found.version ?? null,
    commands: plan.steps.map(stepLine), finished: new Date().toISOString() }, null, 2));
  return result;
}

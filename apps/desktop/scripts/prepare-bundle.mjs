#!/usr/bin/env node
/**
 * Prepares what a distributable needs on a machine with neither this repo nor Node: a production copy of
 * the tile-server and converters, and the Node runtime that runs them, in apps/desktop/bundle/repo.
 * `DESKTOP_BUNDLE_MAP=<absolute path of bundle/copy-map.json> hutch electrobun build` then copies that folder into the app (electrobun.config.ts).
 *
 * The layout stays the repo's, as the server and the two CLI scripts import each other by relative path.
 * Run with the Node to ship: its binary is the one copied, and the native dependencies are built for it.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = path.resolve(desktop, '../..');
const out = path.join(desktop, 'bundle', 'repo');

fs.rmSync(path.join(desktop, 'bundle'), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });

for (const f of ['package.json', '.npmrc', 'pnpm-lock.yaml', 'LICENSE']) fs.copyFileSync(path.join(repo, f), path.join(out, f));
// the patches package.json names (pnpm.patchedDependencies): the install below applies them, and fails without them
fs.cpSync(path.join(repo, 'patches'), path.join(out, 'patches'), { recursive: true });
for (const f of ['static-server.mjs', 'pack-3dtiles.mjs', 'cesium-harness.html']) fs.copyFileSync(path.join(repo, 'scripts', f), path.join(out, 'scripts', f));
fs.cpSync(path.join(repo, 'packages'), path.join(out, 'packages'), {
  recursive: true,
  filter: (src) => {
    const name = path.basename(src);
    return name !== 'node_modules' && !name.endsWith('.test.js') && !name.endsWith('.test.mjs');
  },
});
// Only the packages: the viewer's and docs' dependencies stay out, and with them most of the size.
fs.writeFileSync(path.join(out, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
execSync('pnpm install --prod --no-frozen-lockfile', { cwd: out, stdio: 'inherit' });

// pnpm links workspace packages into packages/*/node_modules, and links do not survive the app's packaging.
// Each becomes a stub whose `main` points at the real package: a copy would load shared modules twice.
const modules = path.join(out, 'node_modules');
(function unlink(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.name === '.bin') { fs.rmSync(p, { recursive: true, force: true }); continue; }
    if (!e.isSymbolicLink()) { if (e.isDirectory()) unlink(p); continue; }
    const real = fs.realpathSync(p), pkg = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p);
    const main = path.relative(p, path.join(real, pkg.main ?? 'index.js')).replaceAll('\\', '/');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: pkg.name, main }));
  }
})(out);

// Files Node never loads. Packages stay whole: the largest (cesium, playcanvas, webgpu) are real dependencies
// of 3d-tiles-tools and splat-transform, and a missing one would only show on the converter that needs it.
(function strip(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) strip(p);
    else if (/\.(map|ts|mts|cts|md|markdown)$/i.test(e.name)) fs.rmSync(p);
  }
})(modules);

fs.mkdirSync(path.join(out, 'runtime'));
fs.copyFileSync(process.execPath, path.join(out, 'runtime', path.basename(process.execPath)));

// When and from what this build was made: the app compares it with the release's own (stable-win-x64-build.json) before
// it calls that release an update, as two builds of one day share a version.
let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), commit }));

// Electrobun's build.copy takes files, not folders, so the config reads this map (electrobun.config.ts).
const copy = {};
let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const rel = path.relative(out, p).replaceAll('\\', '/');
    copy[`bundle/repo/${rel}`] = `3dtiled/${rel}`;
    files++; bytes += fs.statSync(p).size;
  }
})(out);
fs.writeFileSync(path.join(desktop, 'bundle', 'copy-map.json'), JSON.stringify(copy));
console.log(`[prepare-bundle] ${files} files, ${(bytes / 1e6).toFixed(0)} MB, Node ${process.version}, in ${out}`);

// The deck as a static site, and optionally as a PDF on a GitHub release, in one step:
//   node scripts/publish.mjs [--base /docs/slides/] [--port 4180] [--pdf] [--release] [--serve]
// 1. `pnpm build`: `open-slide build` for the sub-path the site is served from (SLIDES_BASE, read by
//    open-slide.config.ts), then an index.html on every route (static-routes.mjs) -> dist/;
// 2. --pdf: dist/ served under --base by a small static server (as the docs image serves it), every
//    deck printed to dist/pdf/<deck>.pdf (export-pdf.mjs);
// 3. --release: those PDFs uploaded to the `slides` release of jo-chemla/3dtiled-to-3dtiles (created
//    if missing, as a prerelease that never takes the Latest badge), replacing the previous upload.
//    Needs `gh` logged in with write access. The PDFs are never committed;
// 4. --serve: keep serving dist/, to try the static site as it will be online.
// What stays dev-only: the inspector, comments and inline edits, which write back to the slide sources.
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('--base', '/docs/slides/').replace(/\/?$/, '/').replace(/^\/?/, '/');
const out = join(root, 'dist');
const wantRelease = process.argv.includes('--release');
const wantPdf = wantRelease || process.argv.includes('--pdf');
const serve = process.argv.includes('--serve');
const port = Number(arg('--port', '4180'));
const REPO = 'jo-chemla/3dtiled-to-3dtiles';
const TAG = 'slides';

const run = (cmd, args, env = {}) => {
  // gh is a real executable: no shell, so arguments with spaces stay whole on Windows. pnpm needs one there.
  const shell = process.platform === 'win32' && cmd !== 'gh';
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
};

run('pnpm', ['build'], { SLIDES_BASE: base });
console.log(`static site: ${out} (served under ${base})`);
if (!wantPdf && !serve) process.exit(0);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.pdf': 'application/pdf',
};
// Like a static host: files as they are, a directory's index.html, else 404.
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(base)) return res.writeHead(404).end();
  let file = join(out, path.slice(base.length));
  if (!file.startsWith(out)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((ok) => server.listen(port, 'localhost', ok));
const url = `http://localhost:${port}${base}`;
console.log(`serving ${url}`);

if (wantPdf) {
  // Asynchronous: the export's page loads are answered by this same process.
  const code = await new Promise((ok) =>
    spawn('node', ['scripts/export-pdf.mjs', url.replace(/\/$/, ''), join(out, 'pdf')], { cwd: root, stdio: 'inherit' }).on('exit', ok),
  );
  if (code !== 0) {
    server.close();
    process.exit(code ?? 1);
  }
}

if (wantRelease) {
  const pdfs = readdirSync(join(out, 'pdf'))
    .filter((f) => f.endsWith('.pdf'))
    .map((f) => join(out, 'pdf', f));
  const exists = spawnSync('gh', ['release', 'view', TAG, '-R', REPO], { cwd: root, stdio: 'ignore' }).status === 0;
  if (!exists) {
    run('gh', ['release', 'create', TAG, '-R', REPO, '--title', 'Slides: the 3dtiled deck as PDF', '--notes',
      'The open-slide deck in slides/, printed to PDF by `pnpm pdf --release` in slides/. Live at https://docs.3dtiled.iconem.com/docs/slides/',
      '--prerelease', '--latest=false']);
  }
  run('gh', ['release', 'upload', TAG, ...pdfs, '-R', REPO, '--clobber']);
  console.log(`uploaded to https://github.com/${REPO}/releases/tag/${TAG}`);
}

if (serve) console.log('Ctrl+C to stop');
else server.close();

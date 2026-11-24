// Tiny static file server for verification screenshots.
//   node scripts/static-server.mjs [port] [rootDir] [urlPrefix]
// Defaults: port 3009, rootDir ./scripts, no prefix. With a prefix (e.g. /3dtiled-to-3dtiles) it
// emulates a GitHub Pages project deployment: /prefix/a/b → rootDir/a/b, with /index.html fallback
// for directory URLs (the docs export uses trailingSlash).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const port = Number(process.argv[2]) || 3009;
// Started by the desktop app, it leaves with the app (see the same watch in packages/tile-server/server.js).
const parentPid = Number(process.env.TILED_PARENT_PID);
if (parentPid) setInterval(() => { try { process.kill(parentPid, 0); } catch { process.exit(0); } }, 5000).unref();
const root = path.resolve(process.argv[3] || path.join(process.cwd(), 'scripts'));
const prefix = process.argv[4] || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let f = path.join(root, p || 'index.html');
  // Range answered (bytes=a-b, a-, -n), as a real host does: the tile server refuses hosts that ignore it
  const serve = (file) => fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); res.end('nf: ' + file); return; }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      const a = m[1] === '' ? Math.max(0, d.length - Number(m[2])) : Number(m[1]);
      const b = m[1] === '' || m[2] === '' ? d.length - 1 : Math.min(Number(m[2]), d.length - 1);
      if (a > b || a >= d.length) { res.writeHead(416, { 'Content-Range': `bytes */${d.length}` }); res.end(); return; }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${d.length}`, 'Content-Length': b - a + 1 });
      res.end(req.method === 'HEAD' ? undefined : d.subarray(a, b + 1)); return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': d.length });
    res.end(req.method === 'HEAD' ? undefined : d);
  });
  fs.stat(f, (e, st) => {
    if (!e && st.isDirectory()) f = path.join(f, 'index.html');
    else if (e && !path.extname(f)) f = f + '.html';          // extensionless → .html (Pages behavior)
    serve(f);
  });
}).listen(port, process.env.HOST || undefined, () => console.log(`static on ${port} root=${root} prefix=${prefix || '(none)'}`));

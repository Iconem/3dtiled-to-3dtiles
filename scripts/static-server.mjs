// Tiny static file server for verification screenshots.
//   node scripts/static-server.mjs [port] [rootDir] [urlPrefix]
// Defaults: port 3009, rootDir ./scripts, no prefix. With a prefix (e.g. /3dtiled-to-3dtiles) it
// emulates a GitHub Pages project deployment: /prefix/a/b → rootDir/a/b, with /index.html fallback
// for directory URLs (the docs export uses trailingSlash).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const port = Number(process.argv[2]) || 3009;
const root = path.resolve(process.argv[3] || path.join(process.cwd(), 'scripts'));
const prefix = process.argv[4] || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let f = path.join(root, p || 'index.html');
  const serve = (file) => fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); res.end('nf: ' + file); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(d);
  });
  fs.stat(f, (e, st) => {
    if (!e && st.isDirectory()) f = path.join(f, 'index.html');
    else if (e && !path.extname(f)) f = f + '.html';          // extensionless → .html (Pages behavior)
    serve(f);
  });
}).listen(port, process.env.HOST || undefined, () => console.log(`static on ${port} root=${root} prefix=${prefix || '(none)'}`));

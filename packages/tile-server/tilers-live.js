/**
 * tilers-live.js — what the one-stop tiler (packages/tilers) needs from the tile-server: which tools exist and where
 * they are, what a path is, and the files of a folder a tiler wrote.
 *
 *   GET /tilers[?input=<path>]   → { tools: [{ id, name, kind, inputs, output, options, …, found: { status, source,
 *                                    hint, missing, downloadable, downloadBytes } }], toolsDir, platform,
 *                                    input?: { exists, dir, ext, exts, ply }, for?: [ids that take that input] }
 *   GET /tilers/files/<key>/<path>  → a file of a tiler's output folder, served as a static host would, so that a
 *                                    3D Tiles tileset a tool wrote opens in a viewer without a second server.
 *                                    <key> is the folder's absolute path in base64url (`outputKey`).
 *
 * Running a tool is not done here: the desktop app runs packages/tilers/cli.js in a subprocess.
 *
 * Both routes name or read paths of this machine, so they have the same gate as /export: the server must be started
 * with TILED_ALLOW_EXPORT=1 (the desktop app does) and only loopback clients are answered. `files` serves a folder
 * only if a tiler run finished in it (it holds the run's record, `.3dtiled-tiler.json`), never an arbitrary folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CORS } from '../core/index.js';
import { listTools, detectTool, describeInput, toolsFor, toolsDir, RUN_MARKER } from '../tilers/index.js';

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); };

/** The `<key>` of a folder in /tilers/files/<key>/…: its absolute path, base64url. */
export const outputKey = (dir) => Buffer.from(path.resolve(dir), 'utf8').toString('base64url');

const TYPES = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.b3dm': 'application/octet-stream', '.pnts': 'application/octet-stream',
  '.i3dm': 'application/octet-stream', '.cmpt': 'application/octet-stream', '.subtree': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ktx2': 'image/ktx2' };

function serveFile(req, res, u) {
  const rest = u.pathname.slice('/tilers/files/'.length), cut = rest.indexOf('/');
  if (cut < 0) return json(res, 404, { error: 'usage: /tilers/files/<key>/<path>' });
  let dir, rel;
  try { dir = Buffer.from(rest.slice(0, cut), 'base64url').toString('utf8'); rel = decodeURIComponent(rest.slice(cut + 1)); } catch { return json(res, 400, { error: 'bad path' }); }
  if (!path.isAbsolute(dir) || !fs.existsSync(path.join(dir, RUN_MARKER))) return json(res, 404, { error: 'not the output folder of a tiler run' });
  const file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(path.resolve(dir) + path.sep)) return json(res, 403, { error: 'outside the folder' });
  if (path.basename(file).startsWith('.')) return json(res, 404, { error: 'no such file' });
  let stat; try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'no such file' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'no such file' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', ...CORS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export async function handleTilers(req, res, u) {
  if (u.pathname !== '/tilers' && !u.pathname.startsWith('/tilers/')) return false;
  if (process.env.TILED_ALLOW_EXPORT !== '1') { json(res, 403, { error: 'the tilers are disabled — start the tile-server with TILED_ALLOW_EXPORT=1 (the desktop app does)', enabled: false }); return true; }
  if (!isLoopback(req)) { json(res, 403, { error: 'the tilers only answer loopback clients' }); return true; }
  if (u.pathname.startsWith('/tilers/files/')) { serveFile(req, res, u); return true; }
  if (u.pathname !== '/tilers') { json(res, 404, { error: 'no such route' }); return true; }
  const tools = listTools().map((t) => {
    const d = detectTool(t.id);
    return { ...t, found: { status: d.status, source: d.source ?? null, hint: d.hint ?? null, path: d.exe?.[d.exe.length - 1] ?? null,
      missing: d.missing ?? [], downloadable: d.downloadable, downloadBytes: d.downloadBytes ?? 0 } };
  });
  const input = u.searchParams.get('input');
  const described = input ? describeInput(input) : null;
  json(res, 200, { tools, toolsDir: toolsDir(), platform: `${process.platform}-${process.arch}`, ...(described ? { input: described, for: toolsFor(described) } : {}) });
  return true;
}

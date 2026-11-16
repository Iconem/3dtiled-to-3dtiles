/**
 * tilers-live.js — `GET /tilers`: the third-party tilers the one-stop tiler knows (packages/tilers), each with its
 * options and whether it is on this machine. Read-only: what a form needs to offer a tool and say where it will come
 * from. Running a tool is not done here: the desktop app runs packages/tilers/cli.js in a subprocess.
 *
 *   GET /tilers[?input=<path>]   → { tools: [{ id, name, inputs, output, options, …, found: { status, source, hint } }],
 *                                    toolsDir, platform, for?: [ids that take that input] }
 *
 * It names paths of this machine (where QGIS is, the tools folder), so it has the same gate as /export: the server
 * must be started with TILED_ALLOW_EXPORT=1 (the desktop app does) and only loopback clients are answered.
 */
import { CORS } from '../core/index.js';
import { listTools, detectTool, toolsFor, toolsDir } from '../tilers/index.js';

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); };

export async function handleTilers(req, res, u) {
  if (u.pathname !== '/tilers') return false;
  if (process.env.TILED_ALLOW_EXPORT !== '1') { json(res, 403, { error: 'the tilers are disabled — start the tile-server with TILED_ALLOW_EXPORT=1 (the desktop app does)', enabled: false }); return true; }
  if (!isLoopback(req)) { json(res, 403, { error: 'the tilers only answer loopback clients' }); return true; }
  const tools = listTools().map((t) => {
    const d = detectTool(t.id);
    return { ...t, found: { status: d.status, source: d.source ?? null, hint: d.hint ?? null, path: d.exe?.[d.exe.length - 1] ?? null } };
  });
  const input = u.searchParams.get('input');
  json(res, 200, { tools, toolsDir: toolsDir(), platform: `${process.platform}-${process.arch}`, ...(input ? { for: toolsFor(input) } : {}) });
  return true;
}

/**
 * mock-iconem-api.mjs — a stand-in for the Iconem platform API, faithful to the contract read from
 * iconem/Backend, so `scripts/iconem-share-links.mjs` can be exercised end to end without a real
 * account and without creating a single real public link.
 *
 * What it enforces, because each is a way the real script could silently go wrong:
 *  - login sets `jwt` (httpOnly) + `XSRF-TOKEN` cookies; no jwt cookie → 403 on everything else
 *  - any non-GET without a matching `X-XSRF-TOKEN` header → 403 (the real API degrades to `guest`)
 *  - collections are capped at 100 rows per page, so paging must actually be implemented
 *  - share names are NOT unique server-side: every POST mints a new token (idempotency is the client's job)
 *  - `las` rows mix las/laz/copc; `shares` listings include revoked links
 *
 *   node scripts/mock-iconem-api.mjs [port]      → prints the base URL, then serves until killed
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] || 0);
const XSRF = 'xsrf-' + crypto.randomBytes(6).toString('hex');
const JWT = 'jwt-' + crypto.randomBytes(6).toString('hex');

// 2 projects; project p1 has 130 pointclouds in one scene to force a second page.
const shares = new Map();                         // assetKey → [share]
const db = {
  projects: [{ id: 'p1', name: 'MesAynak', type: 'owned' }, { id: 'p2', name: 'Angkor', type: 'linked' }],
  scenes: { p1: [{ id: 's1', name: 'survey' }], p2: [{ id: 's2', name: 'temples' }] },
  pointcloud: {
    s1: Array.from({ length: 130 }, (_, i) => ({ id: `pc${i}`, name: `MesAynak_d${2010 + (i % 14)}_${i}`, is_uploaded: true })),
    s2: [{ id: 'pcX', name: 'Bayon_potree', is_uploaded: true }, { id: 'pcDel', name: 'deleted', is_uploaded: true, deleted_at: '2025-01-01' }],
  },
  tiles: { s1: [], s2: [{ id: 't1', name: 'Bayon_mesh', is_uploaded: true }, { id: 't2', name: 'pending', is_uploaded: false }] },
  las: { s1: [{ id: 'l1', name: 'raw', file_format: 'laz', is_uploaded: true }, { id: 'l2', name: 'copc_2024', file_format: 'copc', is_uploaded: true }], s2: [] },
};
// one pre-existing live link and one revoked link with the target name, to test reuse vs recreate
// (shaped like the backend's formatShareForClient output, which always carries `url`)
shares.set('pointcloud/pc0', [{ token: 'existing-live', name: 'single-meta-tileset', is_revoked: false, url: 'https://api.iconem.test/s/existing-live/cloud.js' }]);
shares.set('tiles/t1', [{ token: 'old-revoked', name: 'single-meta-tileset', is_revoked: true, url: 'https://api.iconem.test/s/old-revoked/t1.json' }]);
// a malformed row with the target name but no url, to prove the script refuses to write it
shares.set('pointcloud/pcX', [{ token: 'no-url', name: 'single-meta-tileset', is_revoked: false }]);

const keyOf = { pointcloud: 'pointclouds', tiles: 'tiles', las: 'las' };
const fileOf = (type, id) => (type === 'pointcloud' ? 'cloud.js' : type === 'tiles' ? `${id}.json` : `${id}.copc.laz`);
let posts = 0;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
  const body = await new Promise((r) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => r(s ? JSON.parse(s) : {})); });

  if (req.method === 'GET' && u.pathname === '/__stats') return send(200, { posts, shares: Object.fromEntries(shares) });
  if (req.method === 'POST' && u.pathname === '/user/login') {
    if (body.email !== 'test@iconem.test' || body.password !== 'pw') return send(401, { error: 'bad credentials' });
    return send(200, { id: 'u1', email: body.email, role: 'admin' }, {
      'Set-Cookie': [`jwt=${JWT}; HttpOnly; Path=/`, `XSRF-TOKEN=${XSRF}; Path=/`],
    });
  }
  if (cookies.jwt !== JWT) return send(403, { error: 'guest' });
  if (req.method !== 'GET' && req.headers['x-xsrf-token'] !== XSRF) return send(403, { error: 'xsrf → guest' });

  const page = (rows) => {
    const limit = Math.min(100, Number(u.searchParams.get('limit') ?? 20)), offset = Number(u.searchParams.get('offset') ?? 0);
    return rows.slice(offset, offset + limit);
  };
  const path = u.pathname.replace(/^\/project\/linked\//, '/project/');
  let m;
  if (path === '/project') return send(200, { projects: page(db.projects), count: db.projects.length });
  if ((m = path.match(/^\/project\/([^/]+)\/scene$/))) return send(200, { scenes: page(db.scenes[m[1]] ?? []) });
  if ((m = path.match(/^\/project\/[^/]+\/scene\/([^/]+)\/(pointcloud|tiles|las)$/))) {
    const rows = db[m[2]][m[1]] ?? [];
    return send(200, { [keyOf[m[2]]]: page(rows), count: rows.length });
  }
  if ((m = path.match(/^\/project\/[^/]+\/scene\/[^/]+\/(pointcloud|tiles|las)\/([^/]+)\/share$/))) {
    const k = `${m[1]}/${m[2]}`;
    if (req.method === 'GET') return send(200, { shares: shares.get(k) ?? [] });
    if (req.method === 'POST') {
      posts++;
      const token = crypto.randomBytes(8).toString('base64url');
      const share = { token, name: body.name ?? null, is_revoked: false, created_at: new Date().toISOString(),
        url: `https://api.iconem.test/s/${token}/${fileOf(m[1], m[2])}` };
      shares.set(k, [share, ...(shares.get(k) ?? [])]);
      return send(201, share);
    }
  }
  send(404, { error: `no route ${req.method} ${u.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));

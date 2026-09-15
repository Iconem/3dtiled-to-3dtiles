/**
 * iconem-share-links.mjs — enumerate Iconem platform assets and ensure each has ONE public share link
 * named `single-meta-tileset`, then write a manifest the tile-server's /aggregate can mosaic.
 *
 *   ICONEM_EMAIL=… ICONEM_PASSWORD=… node scripts/iconem-share-links.mjs            # dry run (default)
 *   ICONEM_EMAIL=… ICONEM_PASSWORD=… node scripts/iconem-share-links.mjs --apply    # create missing links
 *     [--types=pointcloud,tiles]  [--include-copc]  [--name=single-meta-tileset]
 *     [--api=https://api.iconem.com/api]  [--out=.local/aggregate-sets/iconem.json]
 *
 * The API contract comes from reading iconem/Backend (share.route.js, share.schema.js, share.model.js,
 * authentication.js) and iconem/Frontend (ShareLinksSection.js), not from guessing:
 *
 *   auth    POST /user/login {email,password} → cookies `jwt` (httpOnly) + `XSRF-TOKEN`.
 *           Every non-GET must echo XSRF-TOKEN in `X-XSRF-TOKEN`, or the request silently continues as
 *           `guest` and fails 403 — which looks like a permissions problem but is an auth one.
 *   assets  GET /project → /project[/linked]/:pid/scene → …/scene/:sid/{pointcloud|tiles|las}
 *   shares  GET  …/:asset/:id/share  → { shares: [...] }   (revoked + expired rows INCLUDED)
 *           POST …/:asset/:id/share  { name } → 201 { token, url, … }
 *
 * WHY THE SAFEGUARDS
 *  - Credentials come ONLY from env vars. Never argv (shell history, process listings), never a file
 *    in the repo. There is no API key / PAT on this platform, so these are a real account password.
 *  - Dry run by default. Every share is PUBLIC to whoever holds the URL, and creating them is an
 *    outward-facing action; `--apply` has to be a deliberate choice.
 *  - Idempotent by name. The backend has no uniqueness on share names and every POST mints a new
 *    token, so re-running without this check would pile up duplicate live public links.
 *  - COPC is opt-in (`--include-copc`) because a `las` share's SAS scope is the WHOLE PROJECT blob
 *    container: the link for one .copc.laz grants read+list on every blob in that project. It also
 *    needs an `admin` account — the `las` share routes are missing from the expert permission list.
 *  - The manifest is written under .local/ (gitignored). Share URLs are bearer credentials.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

const API = opt('api', process.env.ICONEM_API || 'https://api.iconem.com/api').replace(/\/$/, '');
const NAME = opt('name', 'single-meta-tileset');
const APPLY = flag('apply');
const INCLUDE_COPC = flag('include-copc');
const TYPES = new Set(opt('types', 'pointcloud,tiles').split(',').map((s) => s.trim()).filter(Boolean));
if (INCLUDE_COPC) TYPES.add('las');
const OUT = opt('out', '.local/aggregate-sets/iconem.json');
const PAGE = 100;                                  // backend caps `limit` at 100

const email = process.env.ICONEM_EMAIL, password = process.env.ICONEM_PASSWORD;
if (!email || !password) {
  console.error('Set ICONEM_EMAIL and ICONEM_PASSWORD in the environment (never pass them as arguments).');
  process.exit(2);
}

// ── session: a tiny cookie jar is all the auth this API needs ────────────────────────────────────
const jar = new Map();
function absorbCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function api(method, route, body) {
  const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  if (method !== 'GET' && jar.has('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = decodeURIComponent(jar.get('XSRF-TOKEN'));
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  absorbCookies(res);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Page through a collection route; the payload key varies (`projects`, `tiles`, `las`, …). */
async function all(route, key) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const sep = route.includes('?') ? '&' : '?';
    const page = await api('GET', `${route}${sep}limit=${PAGE}&offset=${offset}`);
    // The payload key is only partly confirmed from the backend source (`projects` in particular was
    // inferred). A wrong key must not quietly read as "zero datasets", so fall back to the first
    // array-valued field and say so.
    let rows = page?.[key];
    if (!Array.isArray(rows)) {
      const guess = Array.isArray(page) ? page : Object.values(page ?? {}).find(Array.isArray);
      if (guess && offset === 0) console.warn(`  note: ${route} has no "${key}" field — using the first array in the response`);
      rows = guess ?? [];
    }
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const liveShare = (s) => s.name === NAME && !s.is_revoked && (!s.expires_at || new Date(s.expires_at) > new Date());

const ASSETS = {
  pointcloud: { key: 'pointclouds', keep: (a) => a.is_uploaded !== false && !a.deleted_at },
  tiles: { key: 'tiles', keep: (a) => a.is_uploaded !== false && !a.deleted_at },
  // `las` also holds plain .las/.laz; only COPC is streamable by range request.
  las: { key: 'las', keep: (a) => a.file_format === 'copc' && a.is_uploaded !== false && !a.deleted_at },
};

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
try {
  await api('POST', '/user/login', { email, password });
} catch (e) {
  // A failed login is the most common way this script fails; it should read as one line, not a stack.
  console.error(`Login to ${API} failed: ${e.message}`);
  process.exit(1);
}
if (!jar.has('jwt')) {
  console.error(`Login to ${API} returned no "jwt" cookie — wrong API base URL, or an unverified email address.`);
  process.exit(1);
}
console.log(`logged in to ${API} · mode=${APPLY ? 'APPLY (creating links)' : 'dry-run'} · types=${[...TYPES]} · name="${NAME}"`);

const projects = await all('/project?showOwned=true&showLinked=true&showPublic=false', 'projects');
const entries = [], counts = { reused: 0, created: 0, wouldCreate: 0, failed: 0 };

for (const p of projects) {
  const base = `/project/${p.type === 'linked' ? 'linked/' : ''}${p.id}`;
  let scenes;
  try { scenes = await all(`${base}/scene`, 'scenes'); }
  catch (e) { console.warn(`  skip project ${p.name}: ${e.message}`); continue; }

  for (const s of scenes) {
    for (const type of TYPES) {
      const { key, keep } = ASSETS[type];
      let assets;
      try { assets = (await all(`${base}/scene/${s.id}/${type}`, key)).filter(keep); }
      catch (e) { console.warn(`  skip ${type} in ${p.name}/${s.name}: ${e.message}`); continue; }

      for (const a of assets) {
        const route = `${base}/scene/${s.id}/${type}/${a.id}/share`;
        const label = `${p.name} / ${s.name} / ${a.name}`;
        try {
          const { shares = [] } = await api('GET', route);
          let share = shares.find(liveShare);
          const wasCreated = !share && APPLY;
          if (!share && APPLY) share = await api('POST', route, { name: NAME });
          else if (!share) { counts.wouldCreate++; console.log(`  would create  [${type}] ${label}`); continue; }
          // The backend's formatShareForClient always adds `url`; if a response ever lacks it, skip the
          // entry loudly rather than writing `url: undefined` into a manifest that /aggregate then serves.
          // Counted only as a failure — never also as reused/created.
          if (!share?.url) {
            counts.failed++;
            console.warn(`  FAILED [${type}] ${label}: share ${share?.token ?? '?'} has no url field`);
            continue;
          }
          if (wasCreated) counts.created++; else counts.reused++;
          entries.push({
            type, format: type === 'pointcloud' ? 'potree' : type === 'las' ? 'copc' : '3dtiles',
            url: share.url, name: a.name, project: p.name, scene: s.name,
          });
          console.log(`  ${wasCreated ? 'created' : 'reused '}       [${type}] ${label}`);
        } catch (e) {
          counts.failed++;
          console.warn(`  FAILED [${type}] ${label}: ${e.message}`);
        }
      }
    }
  }
}

// The manifest is exactly the shape /aggregate's local sets read: { label, entries: [{url, format}] }.
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ label: `Iconem — ${NAME} (${entries.length} datasets)`, generatedAt: new Date().toISOString(), entries }, null, 2));
console.log(`\n${projects.length} projects · reused ${counts.reused} · created ${counts.created} · would-create ${counts.wouldCreate} · failed ${counts.failed}`);
console.log(`manifest → ${OUT}  (gitignored — share URLs are bearer credentials)`);
if (!APPLY && counts.wouldCreate) console.log('Dry run only. Re-run with --apply to create the missing links.');

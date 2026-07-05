/**
 * homepage-live.js — the tile-server's own `/`, `/openapi.json`, and `/playground` (+ `/docs` alias).
 *
 * A minimal, titiler-style landing page (https://developmentseed.org/titiler/) — a title, a one-line
 * description, and a link list — plus a self-contained interactive API reference (Scalar, the modern
 * successor to Swagger UI: FastAPI itself now ships it as an alternative to Swagger UI's own `/docs`)
 * driven by openapi.json. No build step, no new runtime dependency: Scalar is loaded from its own CDN
 * as a single script tag, the same pattern this repo already uses for the Draco/KTX2 decoders.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.join(__dirname, 'openapi.json');

// Deployment-specific links — deliberately NOT hardcoded to any real domain (this repo's own
// docker-compose.yml stays reverse-proxy-agnostic for the same reason). Set these in your own
// deployment's environment; omitted links are simply left out of the homepage instead of pointing
// at a guessed/wrong URL. REPO_URL defaults to the actual public GitHub repo, which isn't sensitive.
const REPO_URL   = process.env.REPO_URL   || 'https://github.com/jo-chemla/3dtiled-to-3dtiles';
const DOCS_URL   = process.env.DOCS_URL   || '';
const VIEWER_URL = process.env.VIEWER_URL || '';

const CORS_HTML = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html; charset=utf-8' };
const CORS_JSON = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHomepage(origin) {
  // Hoppscotch's own documented deep-link import format (distinct from the plain https://hoppscotch.io
  // app URL) — opens the app with this spec already imported, no manual "paste URL into the Import
  // dialog" step. Needs an ABSOLUTE openapi.json URL since Hoppscotch is a different origin; built from
  // the incoming request's own Host header rather than hardcoded, so it's correct behind any reverse
  // proxy/port without a deployment-specific env var for this one link.
  const hoppscotchUrl = `https://hoppscotch.io/import?url=${encodeURIComponent(`${origin}/openapi.json`)}`;

  const links = [
    { href: '/playground', label: 'Playground', desc: 'Try every endpoint interactively' },
    { href: '/openapi.json', label: 'OpenAPI JSON', desc: 'Machine-readable API spec' },
    { href: hoppscotchUrl, label: 'Open in Hoppscotch', desc: 'Import this spec into Hoppscotch' },
    DOCS_URL && { href: DOCS_URL, label: 'Docs', desc: 'Architecture, format support, self-hosting' },
    { href: REPO_URL, label: 'GitHub', desc: 'Source code' },
    VIEWER_URL && { href: VIEWER_URL, label: 'Demo viewer', desc: 'Load a real tileset through this server' },
  ].filter(Boolean);

  const items = links.map((l) => `
    <li>
      <a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>
      <span class="desc">${escapeHtml(l.desc)}</span>
    </li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3dtiled tile-server</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px;
         margin: 10vh auto 4rem; padding: 0 1.5rem; background: #0b0f14; color: #d7dee6; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  p.tagline { color: #8a97a5; margin-top: 0; }
  ul { list-style: none; padding: 0; margin-top: 2rem; border-top: 1px solid #1e2530; }
  li { display: flex; justify-content: space-between; align-items: baseline;
       padding: 0.9rem 0; border-bottom: 1px solid #1e2530; }
  a { color: #6cb6ff; text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  .desc { color: #6b7684; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>3dtiled tile-server</h1>
  <p class="tagline">A "TiTiler for 3D" — live &lt;format&gt; → OGC 3D Tiles middleware.</p>
  <ul>${items}</ul>
</body>
</html>`;
}

// theme: 'default' — 'purple'/'deepSpace' (this playground's previous default) both carry a heavy
// gradient/starfield background; the full theme list is 'alternate' | 'default' | 'moon' | 'purple' |
// 'solarized' | 'bluePlanet' | 'saturn' | 'kepler' | 'mars' | 'deepSpace' | 'laserwave' | 'none' — swap
// this if 'default' still isn't neutral enough for you ('alternate'/'solarized' are the other flat ones;
// 'none' strips ALL theme CSS, unstyled browser default).
// agent.disabled: true — removes the "Ask AI" button entirely (a Scalar-hosted feature, on by default
// on localhost for a 10-message free trial; unnecessary here and would otherwise need an Agent key in
// production anyway).
const SCALAR_CONFIG = {
  layout: 'modern',
  defaultOpenAllTags: true,
  theme: 'default',
  hideClientButton: false,
  showSidebar: true,
  showDeveloperTools: 'localhost',
  showToolbar: 'localhost',
  operationTitleSource: 'summary',
  persistAuth: false,
  isEditable: false,
  hideModels: false,
  documentDownloadType: 'both',
  hideTestRequestButton: false,
  hideSearch: false,
  showOperationId: false,
  hideDarkModeToggle: false,
  withDefaultFonts: true,
  defaultOpenFirstTag: true,
  expandAllModelSections: false,
  expandAllResponses: false,
  expandAllSchemaProperties: false,
  orderSchemaPropertiesBy: 'alpha',
  orderRequiredPropertiesFirst: true,
  modelsSectionLabel: 'Models',
  agent: { disabled: true },
};

function renderPlayground() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3dtiled tile-server — playground</title>
</head>
<body style="margin:0">
  <script id="api-reference" data-url="/openapi.json" data-configuration='${escapeHtml(JSON.stringify(SCALAR_CONFIG))}'></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

export async function handleHomepage(req, res, u) {
  if (u.pathname === '/') {
    // `u.protocol` reflects the literal `http://localhost:${PORT}` base server.js parses `req.url`
    // against (see server.js), NOT the real client-facing scheme — behind Traefik/any TLS-terminating
    // reverse proxy this process only ever sees plain HTTP. Prefer the standard forwarded-proto header.
    const proto = req.headers['x-forwarded-proto'] || u.protocol.replace(':', '');
    const origin = `${proto}://${req.headers.host}`;
    res.writeHead(200, CORS_HTML); res.end(renderHomepage(origin)); return true;
  }
  if (u.pathname === '/openapi.json') {
    try {
      const spec = await fs.readFile(OPENAPI_PATH, 'utf8');
      res.writeHead(200, CORS_JSON); res.end(spec);
    } catch {
      res.writeHead(500, CORS_JSON); res.end(JSON.stringify({ error: 'openapi.json not found' }));
    }
    return true;
  }
  // /docs kept as an alias — the route FastAPI itself uses for the exact same purpose, muscle-memory
  // for anyone coming from that ecosystem. Distinct from apps/docs (the separate Fumadocs project site).
  if (u.pathname === '/playground' || u.pathname === '/docs') {
    res.writeHead(200, CORS_HTML); res.end(renderPlayground()); return true;
  }
  return false;
}

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

// Custom Scalar theme matching apps/docs' Fumadocs "vitepress" preset (apps/docs/src/app/global.css),
// used with `theme: 'none'` (see SCALAR_CONFIG below) — 'none' ships no color/font preset of its own,
// so every `--scalar-*` variable here is load-bearing. Mirrors apps/docs/src/app/docs/api-reference/
// scalar-fumadocs-theme.css (same product, same palette) — duplicated rather than shared since this
// package and apps/docs don't share a build step; keep the two in sync by hand if either changes.
const SCALAR_FUMADOCS_THEME_CSS = `
:root {
  --scalar-font: 'Inter', ui-sans-serif, system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji',
    'Segoe UI Symbol', 'Noto Color Emoji';
  --scalar-font-code: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    'Liberation Mono', 'Courier New', monospace;
  --scalar-radius: 0.375rem;
  --scalar-radius-lg: 0.5rem;
  --scalar-radius-xl: 0.75rem;
  --scalar-heading-1: 24px; --scalar-page-description: 16px; --scalar-heading-2: 20px;
  --scalar-heading-3: 16px; --scalar-heading-4: 16px; --scalar-heading-5: 16px; --scalar-heading-6: 16px;
  --scalar-paragraph: 16px; --scalar-small: 14px; --scalar-mini: 13px; --scalar-micro: 12px;
  --scalar-bold: 600; --scalar-semibold: 500; --scalar-regular: 400;
  --scalar-font-size-1: 21px; --scalar-font-size-2: 16px; --scalar-font-size-3: 14px;
  --scalar-font-size-4: 13px; --scalar-font-size-5: 12px; --scalar-font-size-6: 12px; --scalar-font-size-7: 10px;
  --scalar-line-height-1: 32px; --scalar-line-height-2: 24px; --scalar-line-height-3: 20px;
  --scalar-line-height-4: 18px; --scalar-line-height-5: 16px;
  --scalar-font-normal: 400; --scalar-font-medium: 500; --scalar-font-bold: 700;
  --scalar-text-decoration: underline; --scalar-text-decoration-hover: underline;
  --scalar-link-font-weight: inherit;
  --scalar-sidebar-indent: 20px; --scalar-sidebar-padding: 12px; --scalar-border-width: 1px;
}
.light-mode {
  color-scheme: light;
  --scalar-background-1: hsl(0, 0%, 100%);
  --scalar-background-2: hsl(240, 6%, 97%);
  --scalar-background-3: hsl(0, 0%, 94.1%);
  --scalar-background-accent: hsla(226, 55%, 45%, 0.1);
  --scalar-color-1: hsl(240, 6%, 25%);
  --scalar-color-2: hsl(240, 6%, 50%);
  --scalar-color-3: hsl(240, 6%, 50%);
  --scalar-color-accent: hsl(226, 55%, 45%);
  --scalar-border-color: hsl(0, 0%, 89.8%);
  --scalar-button-1: hsl(226, 55%, 45%);
  --scalar-button-1-color: hsl(0, 0%, 98%);
  --scalar-button-1-hover: hsl(226, 55%, 38%);
  --scalar-link-color: hsl(226, 55%, 45%);
  --scalar-link-color-hover: hsl(226, 55%, 38%);
  --scalar-scrollbar-color: rgba(0, 0, 0, 0.18);
  --scalar-scrollbar-color-active: rgba(0, 0, 0, 0.36);
  --scalar-shadow-1: 0 1px 3px 0 rgba(0, 0, 0, 0.11);
  --scalar-shadow-2: rgba(0, 0, 0, 0.08) 0px 13px 20px 0px, rgba(0, 0, 0, 0.08) 0px 3px 8px 0px, hsl(0, 0%, 89.8%) 0px 0 0 0.5px;
}
.dark-mode {
  color-scheme: dark;
  --scalar-background-1: hsl(240, 7%, 11%);
  --scalar-background-2: hsl(0, 0%, 13%);
  --scalar-background-3: hsl(0, 0%, 15%);
  --scalar-background-accent: hsla(234, 100%, 83%, 0.1);
  --scalar-color-1: hsl(60, 100%, 98%);
  --scalar-color-2: hsl(240, 4%, 65%);
  --scalar-color-3: hsl(240, 4%, 65%);
  --scalar-color-accent: hsl(234, 100%, 83%);
  --scalar-border-color: hsl(240, 4%, 19%);
  --scalar-button-1: hsl(234, 100%, 83%);
  --scalar-button-1-color: hsl(240, 7%, 11%);
  --scalar-button-1-hover: hsl(234, 100%, 76%);
  --scalar-link-color: hsl(234, 100%, 83%);
  --scalar-link-color-hover: hsl(234, 100%, 90%);
  --scalar-scrollbar-color: rgba(255, 255, 255, 0.18);
  --scalar-scrollbar-color-active: rgba(255, 255, 255, 0.36);
  --scalar-shadow-1: 0 1px 3px 0 rgb(0, 0, 0, 0.1);
  --scalar-shadow-2: 0 0 0 0.5px var(--scalar-border-color), rgba(15, 15, 15, 0.2) 0px 3px 6px, rgba(15, 15, 15, 0.4) 0px 9px 24px;
}
.light-mode, .dark-mode {
  --scalar-sidebar-background-1: var(--scalar-background-1);
  --scalar-sidebar-border-color: var(--scalar-border-color);
  --scalar-sidebar-color-1: var(--scalar-color-1);
  --scalar-sidebar-color-2: var(--scalar-color-2);
  --scalar-sidebar-color-active: var(--scalar-color-accent);
  --scalar-sidebar-item-hover-background: var(--scalar-background-3);
  --scalar-sidebar-item-hover-color: var(--scalar-color-1);
  --scalar-sidebar-item-active-background: var(--scalar-background-accent);
  --scalar-sidebar-search-background: var(--scalar-background-2);
  --scalar-sidebar-search-border-color: var(--scalar-border-color);
  --scalar-sidebar-search-color: var(--scalar-color-2);
  --scalar-tooltip-background: var(--scalar-background-3);
  --scalar-tooltip-color: var(--scalar-color-1);
}`;

// Shared link data for both the homepage's own list AND the top nav bar (both pages show the SAME
// nav now — see renderHomepage/renderPlayground). Scalar's own `navigation.header`/`navigation.sidebar`
// config keys — the obvious first thing to reach for — turned out to be a paid scalar.com-hosted
// "Docs" product feature: confirmed by downloading the ACTUAL @scalar/api-reference CDN bundle and
// grepping its source for the schema scalar.com's docs describe (`type:"link"`, `type:"spacer"`,
// `newTab`) — zero matches, while other real config keys (`hideClientButton`) DO appear verbatim. A
// plain nav bar in our own markup, outside Scalar's DOM, sidesteps the whole question and doesn't
// depend on any undocumented/paid-tier Scalar internals. `nav: true` marks the subset shown in the
// top bar (kept short on purpose — OpenAPI JSON/Hoppscotch stay on the homepage's full list only).
function buildLinks(origin) {
  // Scalar's own hosted API client (client.scalar.com) — a separate product from the @scalar/
  // api-reference viewer this playground embeds, useful as a full-screen alternative UI over the SAME
  // openapi.json. Built from the incoming request's own origin (never hardcoded — see REPO_URL/
  // DOCS_URL/VIEWER_URL's own comment on why real deployment domains never get committed here).
  const scalarClientUrl = `https://client.scalar.com/?url=${encodeURIComponent(`${origin}/openapi.json`)}&integration=html&utm_source=api-reference&utm_medium=button&utm_campaign=sidebar`;
  return [
    { href: '/', label: 'Home', desc: 'Endpoint list', nav: true },
    { href: '/playground', label: 'Playground', desc: 'Try every endpoint interactively', nav: true },
    DOCS_URL && { href: DOCS_URL, label: 'Docs', desc: 'Architecture, format support, self-hosting', nav: true },
    VIEWER_URL && { href: VIEWER_URL, label: 'Demo viewer', desc: 'Load a real tileset through this server', nav: true },
    { href: scalarClientUrl, label: 'OpenAPI Client', desc: "Try requests in Scalar's own full client (client.scalar.com)", nav: false },
    { href: REPO_URL, label: 'GitHub', desc: 'Source code', nav: true },
    { href: '/openapi.json', label: 'OpenAPI JSON', desc: 'Machine-readable API spec', nav: false },
    // Hoppscotch has no documented deep-link auto-import — the actual flow is manual: open Hoppscotch,
    // Import → "Import from OpenAPI" tab → "Import from URL" → paste this server's /openapi.json.
    // (Verified: no working ?url= import parameter exists; an earlier version of this link assumed
    // one that doesn't actually import anything.)
    { href: 'https://hoppscotch.io', label: 'Open Hoppscotch', desc: `Import → Import from OpenAPI → Import from URL → paste ${origin}/openapi.json`, nav: false },
  ].filter(Boolean);
}

// Shared top nav — same markup on both the homepage and the playground now, colors read straight
// from Scalar's OWN theme (--scalar-* custom properties) instead of a hardcoded palette. Scalar
// toggles a "dark-mode"/"light-mode" class on the body element itself (confirmed in its own bundle
// source); this page sets that class itself too (see renderHomepage/renderPlayground) so the same
// variables cascade in correctly even on the homepage, which never loads Scalar's JS. The literal
// fallback (after the comma) only matters for the ~0-frame gap before the theme CSS finishes loading.
const TOPNAV_CSS = `
  #topnav { display: flex; gap: 1.25rem; align-items: center; padding: 0.6rem 1.25rem;
            background: var(--scalar-background-1, #0f0f0f);
            border-bottom: 1px solid var(--scalar-border-color, #2d2d2d);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.85rem; }
  #topnav a { color: var(--scalar-color-2, #a4a4a4); text-decoration: none; }
  #topnav a:hover { color: var(--scalar-color-accent, #3ea6ff); text-decoration: underline; }
  #topnav strong { color: var(--scalar-color-1, #e7e7e7); margin-right: 0.5rem; }`;

function renderTopNav(origin) {
  const navLinks = buildLinks(origin).filter((l) => l.nav);
  const nav = navLinks.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join('');
  return `<nav id="topnav"><strong>3dtiled tile-server</strong>${nav}</nav>`;
}

function renderHomepage(origin) {
  const links = buildLinks(origin).filter((l) => l.href !== '/'); // homepage IS "/" — no self-link

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
<!-- Just the SAME --scalar-* theme variables the playground uses (SCALAR_CONFIG.theme: 'none' +
     SCALAR_FUMADOCS_THEME_CSS below), not the whole @scalar/api-reference JS bundle the playground
     loads — this page has no Scalar UI to render, it only wants its markup below to genuinely match,
     instead of a hand-picked palette that silently drifts out of sync if the theme ever changes. -->
<style>${SCALAR_FUMADOCS_THEME_CSS}</style>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0 0 4rem;
         background: var(--scalar-background-1, #0b0f14); color: var(--scalar-color-1, #d7dee6); }
  main { max-width: 640px; margin: 6vh auto 0; padding: 0 1.5rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  p.tagline { color: var(--scalar-color-2, #8a97a5); margin-top: 0; }
  ul { list-style: none; padding: 0; margin-top: 2rem; border-top: 1px solid var(--scalar-border-color, #1e2530); }
  li { display: flex; justify-content: space-between; align-items: baseline;
       padding: 0.9rem 0; border-bottom: 1px solid var(--scalar-border-color, #1e2530); }
  a { color: var(--scalar-color-accent, #6cb6ff); text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  .desc { color: var(--scalar-color-3, #6b7684); font-size: 0.85rem; text-align: right; }
  ${TOPNAV_CSS}
</style>
</head>
<body class="dark-mode">
  ${renderTopNav(origin)}
  <main>
    <h1>3dtiled tile-server</h1>
    <p class="tagline">A "TiTiler for 3D" — live &lt;format&gt; → OGC 3D Tiles middleware.</p>
    <ul>${items}</ul>
  </main>
</body>
</html>`;
}

// theme: 'none' — ships NO color/font preset of its own, so SCALAR_FUMADOCS_THEME_CSS above supplies
// every `--scalar-*` variable instead, matching apps/docs' Fumadocs "vitepress" theme (see that
// constant's own comment). The built-in presets ('alternate' | 'default' | 'moon' | 'purple' |
// 'solarized' | 'bluePlanet' | 'saturn' | 'kepler' | 'mars' | 'deepSpace' | 'laserwave') are no longer
// used here on purpose — this playground and the embedded docs page should read as the same product.
// agent.disabled: true — removes the "Ask AI" button entirely (a Scalar-hosted feature, on by default
// on localhost for a 10-message free trial; unnecessary here and would otherwise need an Agent key in
// production anyway).
const SCALAR_CONFIG = {
  layout: 'modern',
  defaultOpenAllTags: true,
  theme: 'none',
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

function renderPlayground(origin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3dtiled tile-server — playground</title>
<style>${SCALAR_FUMADOCS_THEME_CSS}</style>
<style>
  body { margin: 0; }
  ${TOPNAV_CSS}
</style>
</head>
<body>
  ${renderTopNav(origin)}
  <script id="api-reference" data-url="/openapi.json" data-configuration='${escapeHtml(JSON.stringify(SCALAR_CONFIG))}'></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

export async function handleHomepage(req, res, u) {
  // `u.protocol` reflects the literal `http://localhost:${PORT}` base server.js parses `req.url`
  // against (see server.js), NOT the real client-facing scheme — behind Traefik/any TLS-terminating
  // reverse proxy this process only ever sees plain HTTP. Prefer the standard forwarded-proto header.
  const proto = req.headers['x-forwarded-proto'] || u.protocol.replace(':', '');
  const origin = `${proto}://${req.headers.host}`;

  if (u.pathname === '/') {
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
    res.writeHead(200, CORS_HTML); res.end(renderPlayground(origin)); return true;
  }
  return false;
}

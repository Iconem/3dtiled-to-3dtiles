import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// Static export for GitHub Pages: DOCS_STATIC_EXPORT=1 next build → apps/docs/out, deployable to any
// static host. basePath defaults to the GitHub Pages project path (override with DOCS_BASE_PATH, e.g.
// '' for a custom domain). Dev/server mode (no env) is unchanged.
const isExport = process.env.DOCS_STATIC_EXPORT === '1';
const basePath = process.env.DOCS_BASE_PATH ?? (isExport ? '/3dtiled-to-3dtiles' : undefined);

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // In DEV, NOT `basePath: '/docs'` — this app's OWN content routes already live under /docs (see
  // src/app/docs/[[...slug]]/page.tsx + src/lib/shared.ts's `docsRoute`), so a Next basePath would stack
  // a SECOND /docs on top of that (https://…/docs/docs/…, and /docs/docs/references 404ing) instead of
  // just fixing the asset-path problem it was added for. That problem — Next emitting root-absolute
  // /_next/... and /api/... references that don't carry the /docs prefix the viewer's proxy is keyed on
  // — is fixed on the OTHER side instead: apps/viewer/vite.config.ts proxies those specific root paths
  // (_next, api/search, og, llms*) to this same dev server, verbatim, no rewrite needed.
  // In EXPORT mode the basePath is the Pages project prefix — no proxy involved, so no stacking.
  ...(isExport ? { output: 'export', basePath, trailingSlash: true } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath ?? '' },
  images: { unoptimized: true },
};

export default withMDX(config);

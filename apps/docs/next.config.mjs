import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // NOT `basePath: '/docs'` — this app's OWN content routes already live under /docs (see
  // src/app/docs/[[...slug]]/page.tsx + src/lib/shared.ts's `docsRoute`), so a Next basePath would stack
  // a SECOND /docs on top of that (https://…/docs/docs/…, and /docs/docs/references 404ing) instead of
  // just fixing the asset-path problem it was added for. That problem — Next emitting root-absolute
  // /_next/... and /api/... references that don't carry the /docs prefix the viewer's proxy is keyed on
  // — is fixed on the OTHER side instead: apps/viewer/vite.config.ts proxies those specific root paths
  // (_next, api/search, og, llms*) to this same dev server, verbatim, no rewrite needed.
  images: { unoptimized: true },
};

export default withMDX(config);

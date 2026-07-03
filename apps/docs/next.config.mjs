import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Served behind apps/viewer's dev-server proxy at /docs (see apps/viewer/vite.config.ts) — without
  // this, Next emits absolute /_next/... and /api/... asset/route references that don't carry the
  // /docs prefix the proxy is keyed on, 404ing every JS/CSS chunk and the search API in the browser
  // even though the initial HTML page itself proxies through fine.
  basePath: '/docs',
  images: { unoptimized: true },
};

export default withMDX(config);

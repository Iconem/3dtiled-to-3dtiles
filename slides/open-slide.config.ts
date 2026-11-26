import type { OpenSlideConfig } from '@open-slide/core';

// SLIDES_BASE: the sub-path the site is served from. The docs image serves the build at /docs/slides/
// (Dockerfile, docs stage), and the dev server runs there too, so links match; "/" only when asked for.
const openSlideConfig: OpenSlideConfig = {
  base: process.env.SLIDES_BASE ?? '/docs/slides/',
  // Off the viewer (3000), tile-server (3001) and docs (3002).
  port: 3210,
};

export default openSlideConfig;

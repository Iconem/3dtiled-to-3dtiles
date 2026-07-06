import type { BaseLayoutProps, LinkItemType } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

// Cross-links to the tile-server + viewer apps in this same monorepo — the same link set as the
// tile-server's own top nav (packages/tile-server/homepage-live.js's renderTopNav), so all three
// apps in the stack share one consistent navbar. Never hardcoded to a real deployment domain (see
// that file's own REPO_URL/DOCS_URL/VIEWER_URL comment on why) — set via env, links are simply
// omitted when the corresponding URL isn't configured.
const TILE_SERVER_URL = process.env.TILE_SERVER_URL || '';
const VIEWER_URL = process.env.VIEWER_URL || '';

const links: LinkItemType[] = ([
  TILE_SERVER_URL && { type: 'main', text: 'Playground', url: `${TILE_SERVER_URL}/playground`, external: true },
  VIEWER_URL && { type: 'main', text: 'Demo viewer', url: VIEWER_URL, external: true },
  TILE_SERVER_URL && { type: 'main', text: 'OpenAPI JSON', url: `${TILE_SERVER_URL}/openapi.json`, external: true },
] as (LinkItemType | false)[]).filter(Boolean) as LinkItemType[];

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: appName,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links,
  };
}

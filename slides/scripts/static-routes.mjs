// Static hosting (the docs image's `serve`, GitHub Pages) has no rewrite to the single-page app: a deep
// link like <base>/s/3dtiled would 404. The app's own index.html goes to every route the app has (its
// assets are absolute, under the build's base): each deck, its presenter window (s/<deck>/presenter,
// synced to the audience window over a BroadcastChannel, no server), the themes and assets pages.
//   node scripts/static-routes.mjs [dist]
import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.argv[2] ?? join(root, 'dist');
const decks = readdirSync(join(root, 'slides')).filter((d) => existsSync(join(root, 'slides', d, 'index.tsx')));
const routes = [...decks.flatMap((d) => [join('s', d), join('s', d, 'presenter')]), 'themes', 'assets'];
for (const route of routes) {
  mkdirSync(join(dist, route), { recursive: true });
  copyFileSync(join(dist, 'index.html'), join(dist, route, 'index.html'));
}
console.log(`index.html copied to ${routes.length} routes (${decks.length} decks, their presenter windows, themes, assets)`);

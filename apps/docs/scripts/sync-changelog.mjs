// Copies the repo's CHANGELOG.md into the docs as content/docs/changelog.mdx, escaped for MDX.
// Runs before `dev` and `build` (package.json pre-scripts) so the site always carries the current
// changelog; the output is committed too, so a checkout without a build step still has it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url));
const out = fileURLToPath(new URL('../content/docs/changelog.mdx', import.meta.url));

// MDX reads `<`, `{` and `}` outside code as JSX/expressions; the changelog uses them as text
// (`<url>`, `{label, entries}`). Escape them everywhere except inside fenced blocks and inline code.
function escapeMdx(md) {
  const parts = md.split(/(```[\s\S]*?```)/);
  return parts.map((p, i) => i % 2 ? p : p.split(/(`[^`\n]*`)/).map((q, j) => j % 2 ? q
    : q.replace(/</g, '&lt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')).join('')).join('');
}

let md = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
md = md.replace(/^# Changelog\s*\n/, '');            // the page title comes from the frontmatter
const body = escapeMdx(md);
writeFileSync(out, `---\ntitle: Changelog\ndescription: Every notable change, newest first (mirrors CHANGELOG.md at the repository root)\n---\n\n${body}`);
console.log(`[docs] changelog.mdx synced from CHANGELOG.md (${(body.length / 1024).toFixed(0)} KB)`);

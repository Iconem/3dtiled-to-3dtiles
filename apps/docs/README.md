# docs

The Fumadocs site for **3dtiled-to-3dtiles** — a work-in-progress migration of `README.md` +
`docs-references/*.md` into a real table-of-contents. Content is currently a first-pass, close-to-
verbatim chunking (see `content/docs/guide/*.md`, one file per README `##` section, and
`content/docs/references/*.md`, one per `docs-references/` file) — not yet rewritten for the docs-site
format, and not yet the canonical source (the root `README.md` still is, until this catches up).

Run development server from the repo root: `pnpm --filter docs dev` (port 3002 — see
`.claude/launch.json` / `package.json`'s `dev` script). Or from this directory:

```bash
pnpm dev
```

Open http://localhost:3002 with your browser to see the result.

**Next steps for whoever picks this up:** reorganize `content/docs/guide/*` (currently one page per
README `##` heading, in README's original order — some are probably too granular, others could merge),
add cross-links between guide pages and the matching reference notes, and decide whether
`docs-references/*.md` stays a mirror of `content/docs/references/*.md` or whether the latter becomes
the source of truth going forward.

## Explore

In the project, you can see:

- `lib/source.ts`: Code for content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) provides the interface to access your content.
- `lib/layout.shared.tsx`: Shared options for layouts, optional but preferred to keep.

| Route                     | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `app/(home)`              | The route group for your landing page and other pages. |
| `app/docs`                | The documentation layout and pages.                    |
| `app/api/search/route.ts` | The Route Handler for search.                          |

### Fumadocs MDX

A `source.config.ts` config file has been included, you can customise different options like frontmatter schema.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs

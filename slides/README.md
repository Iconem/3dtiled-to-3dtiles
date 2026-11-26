# 3dtiled slides

The 3dtiled deck, written as React pages with [open-slide](https://open-slide.dev): `slides/3dtiled/index.tsx`, its
screenshots in `slides/3dtiled/assets/`. Each page is a fixed 1920 × 1080 canvas; speaker notes are the `notes` export.

- Live: https://docs.3dtiled.iconem.com/docs/slides/s/3dtiled/
- PDF: https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/download/slides/3dtiled.pdf

This folder is its own pnpm root with its own lockfile, outside the repository's workspace: install and run everything
from here.

## Run

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3210/docs/slides/ (the editor, with the inspector, comments and inline edits). The deck is
served under `/docs/slides/` in dev too, as online; `SLIDES_BASE=/ pnpm dev` serves it at the root instead.

## Present

Open the deck and press **F** for full screen, **P** for the presenter window (current and next slide, notes, timer,
kept in step with the audience window in the same browser). Arrows, Space or Page Down move on; **O** shows every page,
**B** / **W** blank the screen, **L** is a laser pointer, **?** lists the keys, Esc leaves.

## Export

| Command | What it does |
| --- | --- |
| `pnpm build` | Static site in `dist/`, built for `/docs/slides/`, with an `index.html` on every route (`scripts/static-routes.mjs`). |
| `pnpm static` | Builds, then serves `dist/` at http://localhost:4180/docs/slides/ as it will be online. |
| `pnpm pdf` | Builds, serves, and prints the deck to `dist/pdf/3dtiled.pdf` (one page per slide) with the system Chrome, or `CHROME_PATH`. |

## Publish

- **Live deck**: nothing to do by hand. The `docs` Docker image (`Dockerfile`, stage `slides-build`) builds this folder
  and serves it at `/docs/slides/` beside the docs; `docker-publish.yml` rebuilds it on every push to main.
- **PDF**: `pnpm pdf --release` builds, prints, and uploads `dist/pdf/*.pdf` to the `slides` release of
  jo-chemla/3dtiled-to-3dtiles (`gh release upload --clobber`, creating the release as a prerelease if missing). Needs
  `gh` logged in with write access. The PDF is never committed.

See [`CLAUDE.md`](./CLAUDE.md) for the authoring rules.

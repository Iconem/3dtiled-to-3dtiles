# 3D Tiled — desktop companion

Runs `packages/tile-server` **on-device** and turns a dataset on your disk (or a public URL) into a
paste-ready OGC 3D Tiles endpoint. Nothing is uploaded — the conversion happens locally, streamed on
demand (`cache=none`) or cached to the local disk cache (`cache=full`). It is `3dtiled serve` with a
window, plus the placement params and a stock-CesiumJS preview.

## Installing it

Windows builds are on the [`desktop-latest` release](https://github.com/jo-chemla/3dtiled-to-3dtiles/releases/tag/desktop-latest).
One installer that updates itself, and a portable zip. See the
[desktop app guide](../docs/content/docs/guide/desktop-app.mdx), which also covers building one.

## Running it

```sh
cd apps/desktop
hutch install --frozen-lockfile --ignore-workspace   # the view's dependencies, from pnpm (own lockfile)
hutch run build          # Vite builds the view, then electrobun build --env=stable → build/<target>/
# then launch build/<target>/3DTiled/bin/launcher.exe   (or the platform equivalent)

hutch run dev            # Vite build + electrobun dev --watch
hutch run view           # the Vite build alone (dist/), e.g. before a bare `hutch electrobun build`
hutch run typecheck      # tsc --noEmit over src/ (view and main process)
```

On Windows, Hutch wants an explicit home if your user directory already contains unrelated files:

```powershell
$env:HUTCH_HOME = "$env:LOCALAPPDATA\hutch-home"
```

## Why Electrobun

Tauri needs a Rust + MSVC toolchain this repo has no other use for; Electron would add a ~200 MB
dependency to a monorepo whose CI runs `pnpm install` on every build. Electrobun ships a small native
host (Hutch + the Cottontail JSC runtime) with official Windows 11 / macOS 14 / Ubuntu 24.04 support
and pulls its toolchain into `.hutch/` (gitignored).

`apps/desktop` is deliberately **excluded from the pnpm workspace** (see `pnpm-workspace.yaml`): it has
its own `pnpm-lock.yaml`, installed with `--ignore-workspace`, so `pnpm install --frozen-lockfile` at
the root — which the Dockerfile and every CI job run — is completely unaffected by this app. Hutch's
own resolver cannot be used here: it refuses to run under a root `package.json` that declares
`workspaces`, so `hutch.config.ts` selects pnpm as the package manager.

## How it works

`src/bun/index.ts` (main process) brings up two Node children (the tile-server with `TILED_ALLOW_EXPORT=1`, which enables writing exports to disk), both reusing existing repo scripts
rather than reimplementing anything:

| child | purpose |
|---|---|
| `packages/tile-server/server.js` | the middleware itself |
| `scripts/static-server.mjs` over `scripts/` | serves `cesium-harness.html`, so the 3D preview is a plain `http://` page |

If a 3dtiled server is already listening on a candidate port (e.g. you have `pnpm dev` running) the
app **adopts** it instead of starting a second copy, and leaves it running on quit. The repo root is
found by walking up for `packages/tile-server/server.js`, because `electrobun dev` runs with
`apps/desktop` as cwd while the built app runs from `build/<target>/3DTiled-dev/bin` — a fixed depth
would only ever be right for one of them.

`src/mainview/` is the launcher UI, a React 19 app styled with Tailwind CSS v4 and shadcn/ui
components on Base UI (`components.json`; the components live in `components/ui/`). Three tabs:

| tab | what it is |
|---|---|
| **Build** (`BuildTab.tsx`, `ExportCard.tsx`) | dataset + format + materialization + optional globe placement → paste-ready URL, and **Export to a folder** (a static 3D Tiles copy, written by the server's `POST /export` or by a `packages/convert/cli.js` child of the main process — `src/bun/cli-runner.ts`, allow-listed scripts only) |
| **Library** (`LibraryTab.tsx`) | saved datasets (`library.ts`), with a cached `/stats` check per row |
| **Samples** (`SamplesTab.tsx`) | `catalog.ts` — a real public dataset per source format, one click into Build |

`App.tsx` is the shell (header, tabs, footer, the preview overlay, the state the tabs share);
`host.ts` holds the RPC to the main process and the query-string parameters; `urls.ts` the pure
helpers (tileset URL, viewer links, the CLI command equivalent to an export); `theme.ts` the
system/light/dark cycle.

Ports **and** the resolved viewer/docs URLs travel to it in the `views://` query string, since the
main process may adopt a server and probes for a local viewer/docs — none of which is knowable at
build time. Link resolution is local-first: `VIEWER_URL`/`DOCS_URL` env → a reachable localhost
instance → the public deployment.

The library is `localStorage`-backed, so it is per-install and **not** shared with the CLI or the web
viewer; Export/Import round-trip it as JSON, which is the seam to move it to a real file later.
`/stats` refresh is sequential by design — it fans out to arbitrary third-party hosts, and the
unbounded-concurrency version of that is what cost `/aggregate` half its children at scale.

Row icons are generated **format glyphs, not thumbnails**: a real preview would require loading each
tileset in a hidden Cesium view, which is far too expensive for a list.

## How the view is built

Electrobun's own view bundler takes no plugins, so React and Tailwind cannot go through it. As in
Electrobun's `react-tailwind-vite` template, **Vite builds the view** (`vite.config.ts`, root
`src/mainview`, output `dist/`) and `electrobun.config.ts` copies `dist/index.html` and `dist/assets`
into the app as `views/mainview`. There is no `build.views` entry any more: a bare
`hutch electrobun build` packages whatever `dist/` holds, which is why the Hutch scripts run Vite first.

`electrobun/view` is not an npm package. `hutch electrobun prepare` unpacks the pinned Electrobun API
into `.hutch/devkit/`, and the Vite config aliases the `electrobun/*` imports onto it with the
`electrobunViteAliases` helper the devkit ships, so the view bundles the same RPC transport the main
process speaks. `tsconfig.json` repeats the three entries it needs in `paths` next to the `@/` alias,
because `paths` replaces the devkit's rather than merging with it.

## Two things that will bite you if you edit this

- **Vite's output is an input of the Electrobun build.** Edit `src/mainview`, run `hutch run view`
  (or `hutch run build` / `hutch run dev`, which include it), and only then `electrobun build`;
  otherwise the app ships the previous `dist/`. `watchIgnore: ["dist/**"]` keeps `--watch` from
  looping on it.
- **Lay out left-aligned, not centred.** On a HiDPI Windows display the webview reports a CSS
  viewport wider than the native frame, so `margin: 0 auto` centres content against a width the user
  cannot see and clips the right-hand side.

## Not done yet

Packaging/signing/auto-update, a native file-picker (the dataset field is typed or pasted for now),
and bundling Node so the app works without a repo checkout — today it locates and runs the
tile-server from the surrounding repo.

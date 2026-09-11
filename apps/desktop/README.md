# 3D Tiled — desktop companion

Runs `packages/tile-server` **on-device** and turns a dataset on your disk (or a public URL) into a
paste-ready OGC 3D Tiles endpoint. Nothing is uploaded — the conversion happens locally, streamed on
demand (`cache=none`) or cached to the local disk cache (`cache=full`). It is `3dtiled serve` with a
window, plus the placement params and a stock-CesiumJS preview.

## Running it

```sh
cd apps/desktop
npx electrobun build     # writes build/<target>/
# then launch build/<target>/3DTiled-dev/bin/launcher.exe   (or the platform equivalent)

npx electrobun dev       # build + run, with watch
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

`apps/desktop` is deliberately **excluded from the pnpm workspace** (see `pnpm-workspace.yaml`): its
dependencies are Hutch-managed, so `pnpm install --frozen-lockfile` — which the Dockerfile and every
CI job run — is completely unaffected by this app.

## How it works

`src/bun/index.ts` (main process) brings up two Node children, both reusing existing repo scripts
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

`src/mainview/` is the launcher UI — three tabs:

| tab | what it is |
|---|---|
| **Build** | dataset + format + materialization + optional globe placement → paste-ready URL |
| **Library** | saved datasets (`library.ts`), with a cached `/stats` check per row |
| **Samples** | `catalog.ts` — a real public dataset per source format, one click into Build |

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

## Two things that will bite you if you edit this

- **The view needs an explicit `<script src="index.js">` tag.** The builder emits
  `views/mainview/index.js` from the configured entrypoint but does **not** inject a tag for it. The
  stock template's HTML has no tag either, so copying it yields a view that renders but never runs.
- **Lay out left-aligned, not centred.** On a HiDPI Windows display the webview reports a CSS
  viewport wider than the native frame, so `margin: 0 auto` centres content against a width the user
  cannot see and clips the right-hand side.

## Not done yet

Packaging/signing/auto-update, a native file-picker (the dataset field is typed or pasted for now),
and bundling Node so the app works without a repo checkout — today it locates and runs the
tile-server from the surrounding repo.

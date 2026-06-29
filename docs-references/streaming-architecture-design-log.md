# Streaming architecture — design log

> A faithful, structured synthesis of the design conversation that produced the live-streaming
> harmonization (lazy hierarchy, the `cache` continuum, and the per-format wiring). It captures the
> questions asked, decisions made, the rationale, and the verification — not a byte-verbatim transcript.
> The canonical reference is the README section *"Architecture: the materialization continuum"*; this
> log records *how we got there*.

---

## 1. Lazy hierarchy (the starting point)

**Problem.** Geometry was already fetched per-tile on demand for every live converter, but the
**hierarchy** was read in full at cold load (`getCtx`). For massive datasets that is the bottleneck:
a 302 M-point Potree 1.7 cloud took ~80 s to walk its `.hrc`; a 50 M-splat RAD took ~9.6 s for the
chunk pass; large COPC/Potree 2.0/I3S read the whole index up front.

**Principle stated by the user.** All stream converters must have minimal cold starts even for large
hierarchies. Out-of-core lazy — but not every level should reference the next as a separate external
tileset; use **multiple sub-trees** (like Potree's octree `stepSize`): for **implicit** octree/quadtree
formats emit `.subtree`s; for **explicit** formats emit N-level external-tileset fragments.

**What was implemented & verified (earlier rounds):**
- **Potree 1.x** — lazy implicit: load one `.hrc` chunk; generate each `.subtree` from only the chunks
  that block needs. Verified byte-identical to the eager build. 302 M cloud: ~80 s → ~0.2 s.
- **Potree 2.0** — lazy implicit: read only `firstChunkSize` of `hierarchy.bin`; load proxy chunks on
  subtree demand. Verified byte-identical (1624 nodes, 0 mismatches).
- **COPC** — lazy implicit: load only the root hierarchy page; load child pages on subtree demand;
  fire-and-forget warmup of the first block.
- **RAD** — lazy explicit: read only the JSON header; build 4-level fragments, boundary children become
  `/rad/subtree/<ci>.json` external refs. Was found **broken** (Sonnet pass emitted ~1 ref for a 50 M
  cloud) and **rewritten** to a correct recursive builder. Verified 765/765 reachable nodes. 9.6 s →
  0.015 s cold start.
- **I3S** — lazy explicit (`&lazy=1`): load node-page 0; 4-level fragments with `/i3s/node/<idx>.json`
  external refs; pages on demand. Verified 5882/5882 content tiles, tiles byte-identical to eager.

**Why lazy cold-starts but slightly slower subsequent tiles — and the fix.** Eager keeps all
availability in RAM (every later lookup is a hit); lazy pays a fetch on the first request into a new
region. Mitigations kept in the middleware: background **prefetch** of the first levels, and a per-URL
`getCtx` cache so a region is fetched at most once.

---

## 2. The conceptual step back — the materialization continuum

**The one idea.** Every converter (offline or live) is the *same mapping*: input-format
(hierarchy, node-data, CRS) ↔ 3D Tiles (tree, tile content, transform). The only thing that varies is
**when the mapping is evaluated and how much is persisted**.

**Push vs pull.** Offline conversion **pushes** — walks the format hierarchy top-down, building the tree
and emitting every tile. Live adapters **pull** — expose the tileset root, then answer each request by
extracting exactly the hierarchy/tile content needed. Same mapping, opposite direction. **Decision:
conserve the offline converters as-is** (they work and walk the hierarchy correctly); harmonize only the
live path.

**First framing (later corrected): two axes.** `mode` (materialization) × `hierarchy` (eager/lazy). The
naming `prebuilt | cached | live` + `hierarchy=eager|lazy` + `prefetch=N` was chosen, and Phases 1–3
implemented (shared services, unified octree builder, `/tiles?mode=` endpoint).

**The correction (user).** `prebuilt` doesn't make sense as a *middleware* mode: if you built a tileset
offline you point the viewer straight at its output `tileset.json` — the middleware isn't involved and
can't (shouldn't) know the input→output link. Dropping it collapses the two axes into **one ordered
axis: what the middleware caches.**

**Final naming (chosen): `cache = none | hierarchy | full`.**

| `cache` | hierarchy up front | tiles persisted | = old |
|---|---|---|---|
| `none` | no (lazy, on demand) | no | `/stream` lazy |
| `hierarchy` | yes (whole tree in RAM) | no (per-request) | `/stream` eager |
| `full` | yes | yes (tree + all tiles → disk) | `/convert` |

`?cache=hierarchy` reads literally as "cache the hierarchy, not the tiles." The parameter name carries
the concept, so no one must memorize what "live" vs "cached" means. (Analogues: DB
materialized-table→view; Next.js SSG→ISR→SSR; GIS tile-cache→dynamic-tiling.)

---

## 3. Harmonization (chosen scope: shared services + unified live; offline `bake()` deferred)

**Phase 1 — shared services (byte-identical, verified).**
- `core/geo.js` — `llhToEcef` / `enuFrame` / `enuMatrix` / `georefFromCrs` (was duplicated 4× across
  copc/potree/lcc/i3s).
- `core/source.js` — `Source`: `.range` / parallel `.ranges` / `.full` / probe-once. RAD rewired onto it.
- `core/http.js` — `CORS` + `sendJson`/`sendGlb`/… across all adapters.

**Phase 2 — unified octree builder.** `core/octree.js` `buildImplicitTileset()` shared by COPC + Potree
(were near-identical). Output byte-identical (COPC availableLevels 9, Potree 2.0 25, 424 B subtrees).

**Phase 3 — single `cache` axis + `/tiles` endpoint.** `/tiles/tileset.json?cache=` 307-routes:
`none`/`hierarchy`→`/stream` (with `hierarchy=lazy`/`eager`), `full`→`/convert`. No `prebuilt`. Old
paths (`/stream`, `/convert`, `/copc`, …) kept as aliases. `tiling=explicit` routes *through* the
existing `implicit-to-explicit` tool (one composable pipeline).

**Factory / composability idea (future).** One-shot transforms are natural chainable `/3dtiles-tools`
commands rather than per-converter flags: `implicit-to-explicit`, `upgrade` (b3dm/pnts→glb, glTF
1.0→2.0, `CESIUM_RTC` bake), and **`centroids`** (currently a `/convert` flag — better as a chainable
tool). Goal: `source → convert → [centroids] → [implicit-to-explicit] → [upgrade] → 3D Tiles`.

**Deferred (Phase 4).** `bake(driver)` to power offline conversion from the same drivers — offline
converters stay untouched for now.

---

## 4. Wiring `cache` / `prefetch` across ALL converters + parallel hierarchy build

**Audit found** the eager knob was only on COPC + Potree 2.0 (and I3S via its `lazy` flag); RAD's eager
path existed but was unreachable; SOG/LCC/Potree 1.x weren't wired. The lazy fragment builders were also
partly **sequential** (RAD BFS, I3S recursion, Potree 1.x `ensureBlock` all `await`-per-node).

**Implemented:**
- `cache=hierarchy` (eager-drain) wired for **all** live converters with a hierarchy: COPC, Potree 2.0,
  **RAD** (full explicit tree), **Potree 1.x** (`drainAll` over the whole `.hrc`), I3S. SOG/LCC are
  single-index → `none`≡`hierarchy` (documented no-op).
- **Parallel hierarchy build** for the lazy fragment builders — RAD loads each BFS level concurrently;
  I3S loads each node-page level concurrently then builds the fragment **synchronously** (avoids a
  `seen` race); Potree 1.x loads each `.hrc` band concurrently (`loadChunkRoots`). All **bounded** at
  `min(cpus−1, 16)` via `parallelMap` so a deep multi-page fragment can't burst hundreds of fetches
  (an unbounded `Promise.all` first attempt caused `fetch failed` under load — fixed by bounding).
- `prefetch=N` wired for the octree-lazy formats (COPC, Potree 2.0, Potree 1.x); for RAD/I3S the
  4-level fragment is itself the prefetch unit; SOG/LCC n/a.

**Re-verified after parallelization:** RAD 765/765, I3S 5882/5882, Potree subtrees valid, no errors.

---

## 5. Verification summary (endpoint/output level)

| Gate | Result |
|---|---|
| All format endpoints (`cache=none` & `cache=hierarchy`) | 200 |
| COPC / Potree 2.0 implicit output | byte-identical (availableLevels 9 / 25, 424 B subtrees) |
| Potree 2.0 hierarchy nodes (lazy drains to eager) | 1624 |
| RAD reachability (lazy fragments) | 765 / 765 |
| RAD eager | full 765-tile explicit tree (0 fragments) |
| I3S lazy coverage | 5882 / 5882 (tiles byte-identical to eager) |
| `/tiles?cache=` routing | none/hierarchy→/stream, full→/convert, bad→400 |
| Bounded parallel build under load | no `fetch failed` |

Verification was at the HTTP/output layer (byte-identity + coverage + no errors), where the refactor
risk lives; the renderer-facing outputs are unchanged, so Cesium/3DTRjs render behavior is preserved by
construction.

---

## 6. Open / deferred

- **Phase 4** — `bake(driver)`: unify offline conversion behind the same drivers. Deferred; offline
  converters conserved.
- **`centroids` as a chainable `/3dtiles-tools` command** (currently a `/convert` flag).
- **Multi-page COPC/Potree timing** — lazy/eager split is verified *correct* on local single-page/small
  samples; the dramatic cold-start win only shows on genuinely huge multi-page clouds.

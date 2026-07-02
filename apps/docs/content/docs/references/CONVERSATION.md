---
title: "Conversation log — the stream-cache arc"
description: "---"
---

# Conversation log — the `stream-cache` arc

> Foundational groundwork for what's next. A faithful, structured reconstruction of the working
> conversation (user asks ↔ outcomes) that produced lazy hierarchy, the `cache` continuum, the shared
> `core/` services, and the new `/gltf` · `/bing` · `/threemx` adapters. It captures the decisions and
> their rationale turn by turn — not a byte-verbatim transcript. Canonical detail lives in the README
> "Architecture: the materialization continuum", `streaming-architecture-design-log.md`, and
> `streaming-adapter-plans.md`.

---

## Turn 1 — Lazy hierarchy for all stream converters
**User:** There's probably a way to avoid doing availability/`getCtx` upfront *and* not pay it lazily.
Add a column for that, and a column for whether requests are parallel range. Minimal cold starts even
for huge hierarchies — out-of-core lazy, but use multiple sub-trees (like Potree octree `stepSize`):
subtrees for implicit, external references for explicit. Implement lazy for Potree 1.0/COPC/Potree 2.0,
SOG/LCC, I3S, and RAD (subtree of 4 next levels). Why are cold starts better but subsequent tiles slower
— can we combine lazy+eager? Keep both implementations.
**Outcome:** Implemented lazy hierarchy: COPC (root page only + on-demand pages), Potree 2.0 (first chunk
+ on-demand), I3S (page-0 + parallel/lazy), RAD (header-only + 4-level fragments). Added a README
lazy-loading status table (geometry vs hierarchy, parallel range, cold start). Background **prefetch**
warmup to combine lazy cold start with warm children.

## Turn 2 — Re-evaluate with Opus; redo the table
**User:** (switched model) carefully re-evaluate everything and redo the table — lazy vs eager hierarchy,
tiles, `getCtx`, parallel range, cold starts.
**Outcome:** Verified each adapter by running it. Found **RAD lazy was broken** (≈1 external ref for a
50 M cloud) → rewrote `buildRadLazySubtree` (765/765 reachable). Implemented true **I3S lazy** (node-page
external fragments, opt-in `&lazy=1`; 5882/5882). Potree 2.0 verified byte-identical (1624 nodes).
Corrected docs (COPC vs Potree speed; Apple Maps date). Redone table with measured states.

## Turn 3 — Step back: the continuum; naming; harmonization
**User:** A quasi-continuum from full-readiness (offline) → cached on-demand (`/convert`) → fully live
(lazy). Find a great naming convention and a concept for it. Generalize the converters (factories);
rework endpoints. Plan first, then we decide.
**Outcome:** Framed it as **one mapping** evaluated at different times/persistence (push offline vs pull
live). Proposed the materialization continuum + a `FormatDriver` + shared `core/` services. Asked
(AskUserQuestion) the **naming** (`prebuilt|cached|live`) and **scope** (Phases 1–3, defer offline `bake`).
Chosen: `prebuilt|cached|live`; "Services + unified live".

## Turn 4 — Push/pull; clarify modes; implement Phases 1–3
**User:** Conserve the offline converters (push, they work). Add these replies + my prompts to the README
(important). Centroid could be a chainable `/3dtiles-tools` tool. Clarify: what's the difference between
prebuilt / cached / live and the eager/lazy axis? Proceed with Phases 1–3.
**Outcome:** Clarified the two axes. Implemented **Phase 1** (`core/geo.js`, `core/source.js`,
`core/http.js`), **Phase 2** (`core/octree.js` `buildImplicitTileset` shared by COPC+Potree, byte-identical),
**Phase 3** (`mode`/`hierarchy`/`prefetch`/`tiling` + `/tiles` endpoint, eager-drain for COPC/Potree 2.0).
Documented the continuum in the README.

## Turn 5 — Collapse the axes; `cache=none|hierarchy|full`
**User:** Is it wired for all converters? "prebuilt" doesn't make sense as a middleware mode — if built
offline you point the viewer at the output directly. Collapse the two axes into one: what the middleware
caches. Naming?
**Outcome:** Agreed — dropped `prebuilt` as a mode; collapsed to **one `cache` axis**. Asked naming →
chose **`cache=none | hierarchy | full`**. Wired `cache=hierarchy` (eager-drain) for COPC, Potree 2.0,
**RAD**, I3S; COPC refactored to a single shared ctx + `drainAll`. `/tiles?cache=` routing. SOG/LCC are
monolithic-index (no-op).

## Turn 6 — Massive multi-page; wire SOG/LCC/Potree; prefetch for all; parallel
**User:** Assume only massive multi-page. Implement `cache` for SOG/LCC/Potree 1.x; check prefetch exists
for all; where are we on parallel hierarchy + tile building per format?
**Outcome:** Added Potree 1.x eager-drain; documented SOG/LCC as single-index no-ops. **Parallelized** the
lazy fragment builders (RAD BFS, I3S page-load, Potree 1.x `.hrc` bands) — **bounded** via `parallelMap`
(`min(cpus−1,16)`; an unbounded first attempt caused `fetch failed`). Fixed an I3S off-by-one (preload one
extra level). Added the parallel-build audit table + prefetch semantics (0/N/-1).

## Turn 7 — Multi-page concept across formats; prefetch caching; viewer pills
**User:** Does 3D Tiles' subtree (implicit) / external-ref (explicit) concept exist in COPC (pages), I3S
(nodepages)? Re-check the specs. How is prefetch cached — subtree/external-ref? Add a viewer prefetch
input after the cache mode.
**Outcome:** Confirmed via spec re-check: COPC pages / I3S node-pages / Potree chunks·`.hrc` ARE the
multi-page concept; **SOG & LCC are monolithic single-index** (nothing to defer → `cache=none ≡ hierarchy`).
Explained prefetch warms the **input-format hierarchy in the in-RAM `getCtx` cache**; the `.subtree` /
external-ref output is regenerated per request (cheap once warm). Added the cache toggle + prefetch input
to the viewer (verified in-browser).

## Turn 8 — Generic glTF-Transform pipeline plan; format crawl; LAS dumping
**User:** Make the on-the-fly decompress a generic glTF-Transform pipeline (per-tile, like upgrade/i2e).
Crawl GIS/CAD/VFX/heritage for missing tiled formats (Nexus, ReCap RCP, Bing/MSFS, terrain). Plan only.
How to write LAS/LAZ from JS/Node — is there a PDAL for Node?
**Outcome:** Researched + planned. Catalog of candidate formats (Nexus, OSGB, 3MX, S3M, Bing, terrain) with
a priority ranking; `docs-references/streaming-adapter-plans.md`. Answered LAS/LAZ: hand-write LAS, shell
out to `pdal`/`untwine` for LAZ/COPC (no PDAL-Node binding; laz-perf is decode-only).

## Turn 9 — Verify claims; plan 3MX + Bing; assess Nexus
**User:** fanvanzh reads only OSGB/SHP? S3M not well known. Open datasets? ReCap really closed — any RE
impl? Can Autodesk read 3D Tiles? Try Nexus if it's easy. Plan 3MX + Bing.
**Outcome:** Corrected: fanvanzh reads OSGB/SHP/FBX/OBJ. ReCap fully closed (no open reader/writer; Autodesk
can't read 3D Tiles natively — Cesium is Bentley's now). Nexus = moderate (DAG→tree, Corto vendoring) →
postponed. Wrote implementation plans for **3MX** and **Bing** (in `streaming-adapter-plans.md`).

## Turn 10 — Implement the three tools (decompress → 3MX → Bing)
**User:** Bing `3dv4` URL template? DAG vs tree / OpenSceneGraph? Note a future "dump tiles by OBB"
feature. Proceed: generic glTF-Transform decompress, then 3MX, then Bing — find test data, no input needed.
**Outcome:** Built and **verified live**: **`/gltf`** decompress (Draco+meshopt+KTX2→PNG via Basis WASM +
pngjs, no sharp) — tested on a real Bing tile; **`/bing`** (keyless `g=15340`, Berlin); **`/threemx`**
(OpenCTM MG1 via vendored js-openctm, colorwlof/Unity-3mxb fixture). Saved the dump-tiles idea to memory.

## Turn 11 — Packaging; per-tile ops; KTX-decode PR; LAS writer; out-of-core
**User:** Are Bentley/Bing their own packages/vendored? Generic glTF-Transform applied to every tile like
upgrade/i2e — already possible? Did you see the glTF-Transform KTX-decompress PR — why vendor Basis/Draco
WASM, doesn't it handle that itself? Really no LAS writer JS (entwine/untwine)? Out-of-core for 500 GB?
**Outcome:** Answered: Bing = handler only; 3MX = handler + vendored js-openctm package. `/gltf` per-tile
works for **explicit** tilesets (recurses external refs); implicit octree passes through. glTF-Transform's
`ktxdecompress` is **CLI-only + shells to native `ktx`** (no library decode) → our in-process Basis+pngjs
is correct; Draco/meshopt need the documented `draco3dgltf`/`meshoptimizer` deps (not vendoring). LAS:
hand-write (out-of-core via header back-patch, O(1) RAM for 500 GB) → `pdal`/`untwine` for LAZ/COPC.

## Turn 12 — Viewer pills + many fixes + finish docs + commit
**User:** Add Bing/3MX pills. List ops + how to call (README). Speed up Draco/KTX decode. Move cache pill
before formats. LCC/Potree offline georef. 3tz/3dtiles wrong Z-up → move to Packages pill. 3MX white/no
tiles. cache=full disk vs hierarchy memory? Open-data packages endpoint? raw-url: reset on offline, update
on toggle. Progress reporting + permanent timing log. Potree live float32 precision artifact (fix
transform). Do Gauzilla/Arrival have their own tiled splat format? Add references + changelog + full
conversation dump; commit to branch `stream-cache` and push.
**Outcome (this turn):** Fixed the **Potree float32 precision** bug (Float64 positions → local ±351 m).
Viewer: cache pill + prefetch moved **before formats**; **Bing/3MX pills**; tastier moved to **Packages**;
public CesiumGS samples on the 3D Tiles pill; **raw-url** re-resolves on toggle + auto-off in offline.
Answered: `cache=full` persists everything to **disk** (`/convert`), `cache=hierarchy` holds only the tree
in **RAM**; **Arrival.Space `.lod`** is its own chunked LOD format (≈ our SOG `lod-meta.json` path; ingests
SOG/LCC), **Gauzilla** = static standard formats only. Wrote `CHANGELOG.md` entry + this log; committed to
`stream-cache`. **Deferred** (noted): glTF-Transform encode ops, `&transform=` in `/stream`, offline-georef
regen + Potree implicit offline output, 3MX visual debug (needs a georeferenced 3MX), live progress
reporting, browser-native bbox-crop→LAS→COPC, fastest JS point-cloud tiler.

---
title: "Performance & parallelism"
description: "This is stale as of the tier-1 parallelization work — see \"Parallelism (per"
---

**This is stale as of the tier-1 parallelization work — see "[Parallelism (per
converter)](#parallelism-per-converter)" above for the current, accurate picture.** (Kept here,
corrected, since other sections still link to this heading.) Tile work — decode → SPZ/GLB encode
(gzip) → write — is **embarrassingly parallel and independent per tile**. All five operational
converters (rad, sog, lcc, copc, potree) now fan tiles out via `parallelMap` (bounded concurrency =
cores−1) + async gzip, verified byte/content-identical to the prior serial versions; i3s (draft)
remains serial. Memory is already bounded per-chunk (esp. SOG/LCC: decode one chunk → write its
tiles → release). The **outstanding piece** is tier 2 — a real `worker_threads` pool for true
multicore *decode* (WASM/CPU-bound: LAZ, WebP, brotli) rather than just bounded concurrency on the
main thread's event loop; see the per-converter table for where that headroom is biggest (SOG's WebP
decode, mainly).

---

---
title: "Splatter (splatter.app) — hosted Gaussian-splat viewer, status notes"
description: "A hosted, content-addressed Gaussian-splat viewer/host by Jakub Červený. Its splatter-three"
---

A hosted, content-addressed Gaussian-splat viewer/host by Jakub Červený. Its `splatter-three` library's
actual source lives in [`splatter-app/splatter-three`](https://github.com/splatter-app/splatter-three), a
**private** repo — nothing beyond its published, intentionally-public consumer demo bundle is
reverse-engineered or reproduced here. Tested against a real 103M-splat scene hosted on splatter.app.

## Status: not a candidate source format (yet)

Unlike every other format in [`format-comparison.md`](/docs/guide/format-comparison), Splatter isn't a
**file format** at all — it's a **hosted rendering service**. Content is addressed by an opaque `splatId`
resolved against splatter.app's own backend; there is no published, standalone wire format a converter
could point at (`.splat`/`.ply`/`.sog`/`.spz`/etc. are not it — whatever bytes actually stream over the
wire are a private implementation detail of the closed `splatter-three` package). That makes it a
**dead end for `→ 3D Tiles` conversion** today: there's nothing to parse. It's tracked here (rather than
in [`candidate-source-formats-roadmap-not-yet-supported.md`](/docs/guide/candidate-source-formats-roadmap-not-yet-supported))
as a **rendering-technique reference** instead — see [Related tilers](/docs/guide/related-tilers-prior-art-reference-implementations)
for how its progressive-loading/hit-testing ideas compare to this repo's own SOG/GeoSplats octree LOD.

This could change if splatter.app ever publishes the wire format or open-sources `splatter-three` — until
then, re-open this doc rather than starting a new investigation from scratch.

## Observable public API surface

From [`splatter-app/three-demo`](https://github.com/splatter-app/three-demo)'s `main.js` — the only
public source — the following API surface is observable:

- `new Splatter(renderer, { splatId })` — content addressed by an opaque ID, loaded/streamed independent
  of the Three.js scene graph; `renderer.render(scene, camera)` and
  `splatter.render(camera, controls.target)` are called **separately per frame** (the splat cloud is not
  a normal scene-graph object — it's composited in its own render pass, alongside whatever three.js drew).
- Progressive loading via `'update'` (redraw on each streamed chunk) and `'loaded'(totalLoaded,
  numDisplayed)` events — their own demo hides a loading spinner once `numDisplayed > 1e6`, well before
  `totalLoaded` finishes, i.e. **partial-scene display while still streaming** (conceptually close to
  this repo's own SOG octree LOD and MapTiler GeoSplats' progressive octant LODs, though the wire format
  itself isn't public).
- `splatter.setTransform(matrix)` positions the splat cloud independent of the rest of the scene.
- `splatter.addUniform(type, name)` + `splatter.setShaderEffect(glsl)` — a small GLSL-injection point
  operating on per-splat `position`/`scale` (their demo uses it for a radial reveal-on-load animation)
  without needing to fork the splat renderer itself.
- `splatter.hitTest(camera, [x, y], { alphaThreshold })` — screen-space picking weighted by actual
  rendered alpha, not just geometry — used for a recenter-on-double-click interaction.
- Requires an explicit WebGL2 context (`canvas.getContext('webgl2', options)`), passed into
  `new THREE.WebGLRenderer({ canvas, context })`.

## Why this boundary

`splatter-three`'s actual source is a private GitHub repo. Only its published, intentionally-public
consumer demo (`three-demo`) was read — the production bundle served from splatter.app itself was
deliberately **not** fetched or decompiled. This mirrors the same boundary this repo holds for closed
services elsewhere (e.g. Google Photorealistic 3D Tiles' ToS forbidding re-serving/caching, tracked in
the roadmap doc's Tier 3).

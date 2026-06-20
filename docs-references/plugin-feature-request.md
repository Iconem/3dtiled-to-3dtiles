# Feature request draft — expose SparkRenderer LoD options in 3d-tiles-rendererjs-3dgs-plugin

**Target repo:** https://github.com/WilliamLiu-1997/3D-Tiles-RendererJS-3DGS-Plugin

**Title:** Allow passing `lodInflate` / `lodSplatScale` (and other SparkRenderer LoD settings) through `sparkRendererOptions`

**Body:**

The plugin's `sparkRendererOptions` currently forwards a fixed allowlist to the shared
SparkRenderer: `premultipliedAlpha, encodeLinear, maxStdDev, minPixelRadius, maxPixelRadius,
minAlpha, enable2DGS, preBlurAmount, blurAmount, clipXY, focalAdjustment, sortRadial,
minSortIntervalMs, depthTest, depthWrite`.

It does **not** include the SparkRenderer LoD controls that SparkJS's own viewer sets, notably:

- `lodInflate` (default `true` in SparkJS's viewer) — inflate LoD splats so opacity ≤ 1.0; visibly
  improves blending of coarse/merged LoD splats.
- `lodSplatScale` — scales the active-splat budget / LoD detail.

**Why it matters:** when rendering 3D Tiles tilesets whose content is baked LoD Gaussian splats
(e.g. converted from SparkJS `.RAD` or PlayCanvas Streamed SOG), the coarse tiles are pre-merged
representatives. Without `lodInflate`, those coarse splats render under-opaque and don't blend the
way they do in SparkJS's native viewer, so the same data looks sparser/spikier through the plugin
than in `sparkjs.dev`'s explore viewer.

**Current workaround:** reach the shared renderer via `getSparkRendererForScene(scene)` and set
`spark.lodInflate = true; spark.lodSplatScale = …; spark.lodDirty = true;` directly. This works but
relies on internal properties rather than the public `sparkRendererOptions` surface.

**Request:** add `lodInflate` and `lodSplatScale` (and ideally the cone-foveation settings
`coneFov0/coneFov/coneFoveate/behindFoveate`) to the `sparkRendererOptions` allowlist, and to
`updateSharedSparkRendererOptions`, so they can be set declaratively at plugin construction and at
runtime.

---

*This repo (`3dtiles-converters`) applies the `getSparkRendererForScene` workaround in `viewer.html`
(`applySparkLodSettings`) until the option is exposed.*

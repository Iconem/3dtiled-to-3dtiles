# 3d-tiles-renderer-3tz (vendored)

`Tiles3tzPlugin` by Emanuel Demetrescu, MIT (see `LICENSE`): reads a 3D Tiles tileset from a `.3tz`
archive in place, by HTTP range requests, in 3DTilesRendererJS.

- Source: https://github.com/zalmoxes-laran/3d-tiles-renderer-3tz
- Version 0.3.0, commit `4cc4536ff68892fe2d717feee8671054a51778b0`, files of `src/` unchanged except
  `sources.js` (marked `3dtiled:`), which carries the fix proposed upstream as
  [PR #2](https://github.com/zalmoxes-laran/3d-tiles-renderer-3tz/pull/2) (issue #1): when the suffix range of
  `tail()` gets no response (across origins it needs a CORS preflight, which GitHub Pages and
  raw.githubusercontent.com refuse), the size comes from a HEAD and the tail from a plain `bytes=a-b`; a 206 whose
  `Content-Range` the browser hides is checked by the length of its body. Drop the patch once that PR is released.
- Vendored because the package is not on npm. Replace this folder by the dependency once it is.

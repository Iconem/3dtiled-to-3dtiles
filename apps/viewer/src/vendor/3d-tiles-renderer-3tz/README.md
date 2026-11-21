# 3d-tiles-renderer-3tz (vendored)

`Tiles3tzPlugin` by Emanuel Demetrescu, MIT (see `LICENSE`): reads a 3D Tiles tileset from a `.3tz`
archive in place, by HTTP range requests, in 3DTilesRendererJS.

- Source: https://github.com/zalmoxes-laran/3d-tiles-renderer-3tz
- Version 0.3.0, commit `4cc4536ff68892fe2d717feee8671054a51778b0`, files of `src/` unchanged except
  `sources.js` (marked `3dtiled:`): the archive's size comes from a HEAD and its tail from a plain
  `bytes=a-b` range instead of a suffix range `bytes=-n`, and a 206 whose `Content-Range` the browser hides
  is checked by the length of its body. Without that, hosts that serve range requests with CORS `*` but
  answer no preflight and expose no `Content-Range` (GitHub Pages, raw.githubusercontent.com) fail with
  "Failed to fetch". Worth proposing upstream.
- Vendored because the package is not on npm. Replace this folder by the dependency once it is.

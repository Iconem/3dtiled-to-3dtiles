---
title: "3D Gaussian Splatting extension lineage"
description: "The glTF extensions for 3D Gaussian splatting went through several incarnations in 2025–2026."
---

The glTF extensions for 3D Gaussian splatting went through several incarnations in 2025–2026.
Understanding the lineage is what pinned down the SPZ-version bug above, so it is documented here
in full.

**Timeline**

- **~June 2025** — a *single* experimental extension `KHR_spz_gaussian_splats_compression` shipped in
  CesiumJS. It bundled the SPZ blob and the splat semantics together.
- **Mid 2025** — Khronos **split** it into two:
  - `KHR_gaussian_splatting` — renderer-agnostic **base**: defines the splat attributes
    (`POSITION`, `COLOR_0`, and namespaced `KHR_gaussian_splatting:SCALE` / `:ROTATION` /
    `:SH_DEGREE_*`), the optional `shape` (ellipsoid/…) and `hints` (sorting method, projection),
    and allows uncompressed or meshopt-compressed data.
  - `KHR_gaussian_splatting_compression_spz_2` — a **child** extension nested *inside* the base on
    the primitive, carrying only the SPZ-compressed blob (a `bufferView`).
- **Sep 2025 (CesiumJS)** — the original single extension was **deprecated**; the tiler in Cesium ion
  switched to outputting the base + `_spz_2` pair.
- **Nov 2025 (CesiumJS v1.135)** — the original extension was **removed**; only the base + `_spz_2`
  pair is supported. Existing tilesets must be re-tiled.
- **Jan 2026** — `KHR_gaussian_splatting` (base) merged into the glTF repo as a release candidate.

**Why the `_2` matters (the bug).** The `_2` in `KHR_gaussian_splatting_compression_spz_2` is the
**SPZ format version (v2)**. As `lexaknyazev` notes in the PR, a KHR extension cannot float across
SPZ versions — for IP and portability reasons it is locked to a specific one. CesiumJS decodes via
the Niantic `spz` library against the **v2** layout. SPZ versions differ in the rotation block:

| SPZ version | Positions | Rotations | Bytes/splat | Niantic packer |
|-------------|-----------|-----------|-------------|----------------|
| v1 | 16-bit | — | — | — |
| **v2** ← what `_spz_2` requires | 24-bit (frac bits) | **3 bytes** (x,y,z; w≥0 recovered) | **19** | `packQuaternionFirstThree` |
| v3 | 24-bit | 4 bytes (smallest-three `uint32`) | 20 | `packQuaternionSmallestThree` |

`rad-to-3dtiles` had been emitting v3 (because SparkJS *writes* v3 by default). Under the `_spz_2`
extension, CesiumJS read that 4-byte rotation block at a 3-byte stride → corrupted rotations that
looked like global scale/falloff weirdness. **Fix:** emit SPZ v2 (see blocker #1 above). SparkJS's
reader version-dispatches, so v2 also renders in the 3DTRJS 3DGS plugin.

**A separate, related issue:** glTF #2509 reports splats rendering *upside-down* in Cesium — that is
a **coordinate-system** matter (SPZ's Left-Up-Front convention / SH handedness baked into the
Niantic `CoordinateConverter`), distinct from the rotation-stride bug. If, after re-tiling to v2,
orientation (not scale) still looks off, that conversion is the next thing to check.

**Primary sources**

- glTF base extension — [KhronosGroup/glTF#2490](https://github.com/KhronosGroup/glTF/pull/2490)
- glTF SPZ compression child — [KhronosGroup/glTF#2531](https://github.com/KhronosGroup/glTF/pull/2531)
- CesiumJS migration issue — [CesiumGS/cesium#12837](https://github.com/CesiumGS/cesium/issues/12837)
- CesiumJS implementation PR — [CesiumGS/cesium#12843](https://github.com/CesiumGS/cesium/pull/12843)
- "upside-down in Cesium" coordinate issue — [KhronosGroup/glTF#2509](https://github.com/KhronosGroup/glTF/issues/2509)
- Niantic SPZ reference codec — [nianticlabs/spz](https://github.com/nianticlabs/spz) (`src/cc/load-spz.cc`)
- Java reference writer — [javagl/JSplat](https://github.com/javagl/JSplat) (`GltfSpzSplatWriter`)

---

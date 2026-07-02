---
title: "Known blockers & how to overcome them"
description: "These are issues localized during a deep cross-check of the converter against the SPZ/SparkJS"
---

These are issues localized during a deep cross-check of the converter against the SPZ/SparkJS
reference and the viewer against both CesiumJS and 3DTilesRendererJS. Each lists the symptom,
the root cause as far as it could be isolated, and the concrete path to resolve it.

### 1. RAD splats rendered wrong after conversion — RESOLVED: emit SPZ **v2**, not v3

**Symptom.** The same `.rad` file rendered perfectly in SparkJS directly, but once converted to a
3D-Tiles GLB with an embedded SPZ payload it looked wrong (off scale / falloff / orientation) in
*both* CesiumJS and 3DTilesRendererJS (whose 3DGS plugin decodes via SparkJS).

**What was verified correct.** Every SPZ field encoder was checked byte-for-byte against SparkJS's
own `SpzWriter` and the Niantic SPZ reference:
- **Scale** — `byte = (ln(s) + 10) × 16`; decode yields `ln(s)`, renderer applies `exp` once → `s`. Single exp, correct.
- **Colour** — SH-DC basis `byte = sh_dc·0.15·255 + 128`. (The "factor 2" you sensed was a *documentation typo* in `spz-format.md`, where the decode divisor read `0.15·128` instead of `0.15·255`; the code was always correct. Now fixed.)
- **Opacity** — `byte = round(opacity·255)`; the SPZ/KHR sigmoid/inv-sigmoid pair is a net no-op. Correct.
- **Header / block order** — magic, version, numPoints, shDegree, fractionalBits; planar blocks positions→alpha→rgb→scales→rotations. All correct.

**Root cause — SPZ version. The extension is locked to SPZ v2; we were emitting v3.** Tracing the
extension's [inception](#3d-gaussian-splatting-extension-lineage) shows
`KHR_gaussian_splatting_compression_spz_2` is **pinned to SPZ v2** (the `_2` is the SPZ format
version — a KHR extension cannot float across SPZ versions for IP/portability reasons, so it is
deliberately fixed). The two SPZ versions differ in the **rotation block**:

| | SPZ v2 (`packQuaternionFirstThree`) | SPZ v3 (`packQuaternionSmallestThree`) |
|---|---|---|
| Rotation bytes/splat | **3** — store x,y,z (w≥0 recovered) | 4 — smallest-three packed `uint32` |
| Per-splat total | 19 bytes | 20 bytes |

We had been writing v3 (4-byte rotations, `version = 3` header) — what SparkJS *writes* by default
— under the v2 extension. CesiumJS's bundled Niantic decoder reads the v2 layout, so it consumed a
**4-byte rotation block at a 3-byte stride**, corrupting every rotation (and looking like global
scale/falloff weirdness). The 3DGS plugin showed the same because the GLB itself was non-conformant.

**The fix (applied).** `rad-to-3dtiles` now emits SPZ **v2**: `SPZ_VERSION = 2`, `encodeQuat` writes
3 bytes via the first-three scheme (`byte = round(comp·127.5 + 127.5)`, w canonicalised ≥ 0 and
recovered on decode), and `buildSpzBuffer` uses a 19-byte/splat layout. Verified against the Niantic
`load-spz.cc` v2 path **and** SparkJS's reader, which version-dispatches and reads the 3-byte branch
(`comp = byte/127.5 − 1`) — so the same GLB now decodes correctly in CesiumJS *and* the 3DTRJS 3DGS
plugin. Re-run the converter on your `.rad` files to regenerate v2 tilesets.

> If a future tiler/decoder targets SPZ v3, restore the 4-byte `packQuaternionSmallestThree`
> encoder (in this file's git history) and set `SPZ_VERSION = 3` — but only under a v3-capable
> extension, never under `_spz_2`. See the dedicated
> [3D Gaussian Splatting extension lineage](#3d-gaussian-splatting-extension-lineage) section for
> the full history and links.

### 2. COPC point clouds look "upside down" in 3DTRJS *Env* controls (fine in *Globe*)

**Symptom.** A georeferenced COPC tileset displays correctly in Globe controls but appears
rotated/upside-down under EnvironmentControls.

**Root cause — not a converter bug.** `glbWriter.js` stores points as `(East, Up, −North)` so
that after the renderer's standard glTF→3D-Tiles `RX(+90°)` correction they become the
right-handed `(East, North, Up)` frame — correct, and confirmed by the flawless Globe render.
The problem is purely viewer-side: after that correction the data is **Z-up**, but
`EnvironmentControls` assumes a **Y-up** local ground plane, so a georeferenced tileset viewed
in Env mode looks tipped over.

**How to overcome it:** use the new **Local orbit** control mode (added to the 3DTRJS toolbar),
which runs `ReorientationPlugin` to recenter the tileset at the origin with `up = +Y` and then a
plain Three.js `OrbitControls`. That presents any tileset — ECEF or local — in a clean upright
orbit, independent of the ECEF root transform, and was also added to verify that the
world→local matrix concatenation is not what limits fine-detail streaming.

---

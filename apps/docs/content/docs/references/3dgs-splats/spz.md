---
title: "SPZ (Niantic)"
description: "SPZ is a gzip-compressed binary format for Gaussian splat scenes developed by Niantic."
---

> Source: https://github.com/nianticlabs/spz  
> Version covered: v3 (used by SparkJS / this converter)

SPZ is a gzip-compressed binary format for Gaussian splat scenes developed by Niantic.
Version 3 is what SparkJS writes and what this converter produces.

---

## File Layout (v3)

```
[16-byte header]
[N × 9 bytes]   positions  — three int24 LE per splat
[N × 1 byte]    alphas     — one uint8 per splat
[N × 3 bytes]   colors     — RGB uint8 per splat (SH DC basis)
[N × 3 bytes]   scales     — XYZ uint8 per splat (log-encoded)
[N × 3 bytes]   rotations  — v2 "first-three" quaternion (x,y,z; w recovered)
```

Total body = N × 19 bytes (SPZ v2), then gzip-compressed.
(SPZ v3 uses 4-byte "smallest-three" rotations → N × 20 bytes.)

---

## Header (16 bytes)

| Offset | Size | Field         | Value       |
|--------|------|---------------|-------------|
| 0      | 4    | magic         | `0x5053474E` ("NGSP" as LE uint32) |
| 4      | 4    | version       | 3           |
| 8      | 4    | numPoints     | N           |
| 12     | 1    | shDegree      | 0 (base DC only) |
| 13     | 1    | fractionalBits | 12 (positions use 12-bit fractional) |
| 14     | 1    | flagAntiAlias | 0 or 1      |
| 15     | 1    | (reserved)    | 0           |

---

## Per-field Encoding

### Positions (int24 × 3 = 9 bytes/splat)

Each coordinate is a **24-bit signed little-endian integer** in fixed-point with `fractionalBits` (=12) fractional bits.

```
pack:   int24 = round(x * 2^12)   range: ±8388607 → ±2048 world units
unpack: x = int24 / 2^12
```

Bytes: `b0 = val & 0xFF`, `b1 = (val >> 8) & 0xFF`, `b2 = (val >> 16) & 0xFF`

---

### Alpha (uint8 × 1 = 1 byte/splat)

Stored as `sigmoid(logit_alpha) × 255`. The SPZ pack input is an opacity logit; the stored byte encodes the already-sigmoidified value.

```cpp
// pack (from C++ source):
packed.alphas[i] = toUint8(sigmoid(g.alphas[i]) * 255.0f);

// unpack:
result.alpha = invSigmoid(alpha / 255.0f);   // returns logit
```

KHR decode: `COLOR_0 A = sigmoid(logit)` → net result: **opacity = byte / 255**.

So if your input opacity ∈ [0,1], encode as: `byte = round(opacity × 255)`.

---

### Colors / RGB (uint8 × 3 = 3 bytes/splat)

Encodes the DC spherical harmonics coefficient (not display color directly).
The relationship is `display_color = 0.5 + SH_C0 × sh_dc` where `SH_C0 = 0.28209`.

```
pack:   byte = round(sh_dc * 0.15 * 255 + 128)
unpack: sh_dc = (byte - 128) / (0.15 * 255)
```

> NOTE: the unpack divisor is `0.15 * 255` (= 38.25), the exact inverse of the
> pack scale — NOT `0.15 * 128`. An earlier draft of this doc had `128`, which
> implied a spurious ~2× error in the colour round-trip. The converter code
> (`scaleRgb`) uses the correct 255-based scale.

KHR decode: `COLOR_0 RGB = 0.5 + SH_C0 × sh_dc`

To encode a display RGB value `r ∈ [0,1]`:
```js
sh_dc = (r - 0.5) / SH_C0;
byte  = round(sh_dc * 0.15 * 255 + 128);
// equivalently:
byte  = round(((r - 0.5) / (SH_C0 / 0.15) + 0.5) * 255);
```

---

### Scales (uint8 × 3 = 3 bytes/splat)

Log-encoded. The standard SPZ encoding (all versions):

```
pack:   byte = round((ln(s) + 10) × 16)
unpack: ln_s = byte / 16 − 10  →  s = exp(ln_s)
```

Effective range: exp(−10) ≈ 4.5×10⁻⁵ (byte 0) to exp(5.9375) ≈ 379 (byte 255).
A scale of 1.0 encodes to byte 160.

**IMPORTANT**: RAD `.rad` files store scales with chunk-specific `lnMin`/`lnMax` in their metadata.
When converting RAD → SPZ, always decode with RAD's lnMin/lnMax, then re-encode with the
standard SPZ formula above. Do NOT pass RAD range constants through to the SPZ encoder.

---

Rotations are version-dependent — this is the field that the `_spz_2` extension
pins, and the one that broke our converted splats when we mismatched it.

#### Version 2 — "first-three" (uint8 × 3 = 3 bytes/splat) ← what this converter writes

This is what SPZ **v2** uses and what `KHR_gaussian_splatting_compression_spz_2`
(and CesiumJS's bundled decoder) expects. Niantic `packQuaternionFirstThree`:

```
pack:   normalise q; if (q.w < 0) negate q   // canonicalise so w ≥ 0
        byte = round(component × 127.5 + 127.5)   for x, y, z
unpack: component = byte / 127.5 − 1
        w = sqrt(max(0, 1 − x² − y² − z²))        // w recovered, always ≥ 0
```

SparkJS version-dispatches and reads this via its 3-byte branch, so it works in
both CesiumJS and the 3DTilesRendererJS 3DGS plugin.

#### Version 3+ — "smallest-three" (uint8 × 4 = 4 bytes/splat)

Higher-accuracy packing (Niantic `packQuaternionSmallestThree`). Layout of the
4-byte little-endian uint32 `comp`:
```
bits [31:30] — index of largest component (0=x, 1=y, 2=z, 3=w)
bits [29:20] — 3rd component: [1 sign bit][9 magnitude bits]
bits [19:10] — 2nd component: [1 sign bit][9 magnitude bits]
bits [9:0]   — 1st component: [1 sign bit][9 magnitude bits]
```
Magnitude is scaled: `component = ±sqrt(0.5) × (mag / 511)`; the largest component
is recovered from the unit-quaternion constraint. This is what SparkJS *writes* and
what a v3-capable decoder reads — but a v2-only decoder (the spz_2 contract) will
mis-stride a 4-byte rotation block, so **do not** emit v3 under the spz_2 extension.

---

### Spherical Harmonics (v3: not present for shDegree=0)

When `shDegree > 0`, additional uint8 data follows rotations. Not used by this converter.

---

## References

- Niantic SPZ C++ source: https://github.com/nianticlabs/spz
- KHR_gaussian_splatting_compression_spz_2 extension: [KHR_gaussian_splatting.md](/docs/references/3dtiles-gltf/KHR_gaussian_splatting#compression-extension-khr_gaussian_splatting_compression_spz_2)
- SparkJS PackedSplats/ExtSplats byte layouts: [rad-format-notes.md](/docs/references/3dgs-splats/rad-format-notes)

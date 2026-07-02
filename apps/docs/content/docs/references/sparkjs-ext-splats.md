---
title: "SparkJS ExtSplats"
description: "ExtSplats is the Spark 2.0 preview extended splat container using 32 bytes per splat (vs 16 for PackedSplats), stored across two Uint32Array"
---

> Source: https://sparkjs.dev/2.0.0-preview/docs/ext-splats/
> Version: Spark 2.0 preview

ExtSplats is the Spark 2.0 preview extended splat container using 32 bytes per splat (vs 16 for PackedSplats), stored across two Uint32Arrays.

## Byte Layout (32 bytes = 2 × uvec4 = 8 × uint32)

**extArrays[0]** (bytes 0–15):

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0–3 | center.x | 4B | float32 bits (uintBitsToFloat) |
| 4–7 | center.y | 4B | float32 bits |
| 8–11 | center.z | 4B | float32 bits |
| 12–13 | opacity | 2B | float16 |
| 14–15 | reserved | 2B | unused |

**extArrays[1]** (bytes 16–31):

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 16–17 | color.r | 2B | float16 |
| 18–19 | color.g | 2B | float16 |
| 20–21 | color.b | 2B | float16 |
| 22–23 | ln(scale.x) | 2B | float16 (decoded with exp) |
| 24–25 | ln(scale.y) | 2B | float16 |
| 26–27 | ln(scale.z) | 2B | float16 |
| 28–31 | quaternion | 4B | packed oct+angle (10/10/12 bits) |

**Total: 32 bytes/splat**

## Key differences vs PackedSplats

| Property | PackedSplats | ExtSplats |
|----------|-------------|-----------|
| Size | 16 B/splat | 32 B/splat |
| center | float16 | **float32** (higher precision) |
| opacity | uint8 | **float16** |
| RGB color | uint8 (sRGB) | **float16** |
| scales | uint8 log (e^-12..e^9) | float16 log |
| quaternion | oct88 + u8 angle | oct10/10 + 12-bit angle |

## Creating

```js
const extSplats = new ExtSplats({
  url?: string,           // .ply, .spz, .splat, .ksplat, .rad
  fileBytes?: Uint8Array,
  extArrays?: [Uint32Array, Uint32Array],
  numSplats?: number,
  construct?: (splats) => void,
  lod?: boolean | number,
  lodSplats?: ExtSplats,
});
```

## Encoding / Decoding

```js
import { utils } from "@sparkjsdev/spark";

utils.encodeExtSplat(extSplats.extArrays, index, x, y, z, sx, sy, sz, qx, qy, qz, qw, opacity, r, g, b);
const { center, scales, quaternion, color, opacity } = utils.decodeExtSplat(extSplats.extArrays, index);

extSplats.forEachSplat((index, center, scales, quaternion, opacity, color) => { ... });
```

## SH Layout (extra property)

SH3 split into sh3a + sh3b (different from PackedSplats):

| Buffer | Words/splat | Coefficients |
|--------|-------------|--------------|
| sh1 | 4 (16B) | sh1_0, sh1_1, sh1_2, sh2_0 (4th word reused by SH2) |
| sh2 | 4 (16B) | sh2_1..sh2_4 |
| sh3a | 4 (16B) | sh3_0..sh3_3 |
| sh3b | 4 (16B) | sh3_4..sh3_6 |

Each RGB coefficient: 8-bit magnitude per channel + 5-bit shared exponent + 3 sign bits = 4 bytes/coefficient.

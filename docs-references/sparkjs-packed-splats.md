# SparkJS PackedSplats

> Source: https://sparkjs.dev/2.0.0-preview/docs/packed-splats/
> Version: Spark 2.0 preview

A PackedSplats is a collection of Gaussian splats packed into 16 bytes per splat.

## Byte Layout (16 bytes = 4 × uint32)

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | R | 1B | Red (uint8 0–255 → 0.0–1.0) |
| 1 | G | 1B | Green (uint8 0–255 → 0.0–1.0) |
| 2 | B | 1B | Blue (uint8 0–255 → 0.0–1.0) |
| 3 | A | 1B | Alpha/opacity (uint8 0–255 → 0.0–1.0) |
| 4–5 | center.x | 2B | float16 |
| 6–7 | center.y | 2B | float16 |
| 8–9 | center.z | 2B | float16 |
| 10 | quat oct.U | 1B | Octahedral quaternion U (uint8) |
| 11 | quat oct.V | 1B | Octahedral quaternion V (uint8) |
| 12 | scale.x | 1B | log-encoded uint8 (e^-12 to e^9) |
| 13 | scale.y | 1B | log-encoded uint8 |
| 14 | scale.z | 1B | log-encoded uint8 |
| 15 | quat angle θ | 1B | Rotation angle (uint8, θ/π×255) |

**Total: 16 bytes/splat**. With SH0+1+2+3: up to 56 bytes/splat.

## Creating

```js
const packedSplats = new PackedSplats({
  url?: string,           // .ply, .spz, .splat, .ksplat, .rad
  fileBytes?: Uint8Array,
  maxSplats?: number,
  packedArray?: Uint32Array,
  numSplats?: number,
  construct?: (splats) => void,
  lod?: boolean | number,
  lodSplats?: PackedSplats,
  splatEncoding?: SplatEncoding,
});
```

## Encoding / Decoding

```js
import { utils } from "@sparkjsdev/spark";

// Unpack all components
const { center, scales, quaternion, color, opacity } = utils.unpackSplat(packedSplats.packedArray, index);

// Pack
utils.setPackedSplat(packedSplats.packedArray, index, x, y, z, scaleX, scaleY, scaleZ, qx, qy, qz, qw, r, g, b, a);

// Iterate
packedSplats.forEachSplat((index, center, scales, quaternion, opacity, color) => { ... });
```

## SH Layout (extra property)

| Buffer | Words/splat | Coefficients | Quantization |
|--------|-------------|--------------|--------------|
| sh1 | 2 (8B) | 9 values (3 coeffs × RGB) | Sint7 |
| sh2 | 4 (16B) | 15 values (5 coeffs × RGB) | Sint8 |
| sh3 | 4 (16B) | 21 values (7 coeffs × RGB) | Sint6 |

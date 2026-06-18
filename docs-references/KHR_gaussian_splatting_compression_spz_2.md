# KHR\_gaussian\_splatting\_compression\_spz\_2

> Source: https://github.com/KhronosGroup/glTF/pull/2531
> Status: Draft (2026)

## Overview

Extension for compressing 3D Gaussian splats using SPZ v2 format (Niantic Spatial).

Depends on `KHR_gaussian_splatting`.

## Usage

```json
"extensions": {
  "KHR_gaussian_splatting": {
    "extensions": {
      "KHR_gaussian_splatting_compression_spz_2": {
        "bufferView": 0
      }
    }
  }
}
```

```json
"extensionsUsed": ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"]
```

## SPZ → glTF Attribute Mapping

| SPZ field | glTF Attribute | Conversion |
|-----------|---------------|------------|
| positions | POSITION | — |
| colors | COLOR_0 RGB | 0.5 + 0.282095 × x |
| alphas | COLOR_0 A | sigmoid(x) = 1/(1+e^-x) |
| scales | KHR_gaussian_splatting:SCALE | exp(x) |
| rotations | KHR_gaussian_splatting:ROTATION | — |
| sh[0..2] | SH_DEGREE_1_COEF_0 | — |
| sh[3..5] | SH_DEGREE_1_COEF_1 | — |
| sh[6..8] | SH_DEGREE_1_COEF_2 | — |
| sh[9..44] | SH_DEGREE_2..3_COEF_* | — |

Coordinate system: Left-Up-Front (LUF) in SPZ PackOptions/UnpackOptions for glTF compatibility.

## Resources

- SPZ format: https://github.com/nianticlabs/spz
- PR: https://github.com/KhronosGroup/glTF/pull/2531

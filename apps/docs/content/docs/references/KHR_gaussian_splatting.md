---
title: "KHR\_gaussian\_splatting"
description: "<!--"
---

<!--
Copyright 2026 The Khronos Group Inc.
SPDX-License-Identifier: CC-BY-4.0
-->

# KHR\_gaussian\_splatting

> Source: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_gaussian_splatting/README.md
> Status: Release Candidate (2026)

## Overview

Defines basic support for storing 3D Gaussian splats in glTF assets as point cloud primitives.

Splats are defined by: position, rotation, scale, opacity, and spherical harmonics.

## Extension Object Properties

| Property | Type | Description | Required |
|----------|------|-------------|----------|
| kernel | string | Gaussian kernel type | Yes |
| colorSpace | string | Color space of reconstructed values | Yes |
| projection | string | Projection method | No (default: "perspective") |
| sortingMethod | string | Sorting method for rendering | No (default: "cameraDistance") |

## Ellipse Kernel Attributes

| Splat Data | Attribute Semantic | Type | Required |
|------------|-------------------|------|----------|
| Position | POSITION | VEC3 float | Yes |
| Rotation | KHR_gaussian_splatting:ROTATION | VEC4 float/byte/short normalized | Yes |
| Scale | KHR_gaussian_splatting:SCALE | VEC3 float/ubyte/ushort | Yes |
| Opacity | KHR_gaussian_splatting:OPACITY | SCALAR float/ubyte/ushort normalized | Yes |
| SH degree 0 | KHR_gaussian_splatting:SH_DEGREE_0_COEF_0 | VEC3 float | Yes |
| SH degree 1 | KHR_gaussian_splatting:SH_DEGREE_1_COEF_[0-2] | VEC3 float | No |
| SH degree 2 | KHR_gaussian_splatting:SH_DEGREE_2_COEF_[0-4] | VEC3 float | No |
| SH degree 3 | KHR_gaussian_splatting:SH_DEGREE_3_COEF_[0-6] | VEC3 float | No |

## Covariance Matrix

```
Σ = M·C·Cᵀ·Mᵀ
```
Where M = upper-left 3×3 of node transform, C = scale×rotation matrix.

## Spherical Harmonics Color

```
Color = SH_0,0 × 0.2820947917738781 + 0.5
```
(plus higher degree terms for view-dependent color)

## JSON Example

```json
{
  "meshes": [{ "primitives": [{
    "attributes": {
      "POSITION": 0,
      "KHR_gaussian_splatting:SCALE": 2,
      "KHR_gaussian_splatting:ROTATION": 3,
      "KHR_gaussian_splatting:OPACITY": 4,
      "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 5
    },
    "mode": 0,
    "extensions": {
      "KHR_gaussian_splatting": {
        "kernel": "ellipse",
        "colorSpace": "srgb_rec709_display"
      }
    }
  }]}]
}
```

## Full Specification

See full spec at: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_gaussian_splatting/README.md

---

## Compression extension: KHR_gaussian_splatting_compression_spz_2

> Source: https://github.com/KhronosGroup/glTF/pull/2531
> Status: Draft (2026)

Extension for compressing 3D Gaussian splats using the SPZ v2 format (Niantic Spatial). Depends on
`KHR_gaussian_splatting` above.

### Usage

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

### SPZ → glTF Attribute Mapping

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

### Resources

- SPZ format: https://github.com/nianticlabs/spz
- PR: https://github.com/KhronosGroup/glTF/pull/2531

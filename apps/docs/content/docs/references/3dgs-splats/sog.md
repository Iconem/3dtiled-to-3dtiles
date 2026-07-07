---
title: "SOG — Spatially Ordered Gaussians"
description: "SOG is PlayCanvas's compact container for 3D Gaussian Splat data. It stores per-Gaussian"
---

> Source: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
> Version covered: 2 (current)

SOG is PlayCanvas's compact container for 3D Gaussian Splat data. It stores per-Gaussian
properties as quantized **WebP images** plus a `meta.json`, typically **~15–20× smaller**
than the equivalent PLY. Authored / read with [SplatTransform](https://github.com/playcanvas/splat-transform).

A single chunk of a [Streamed SOG](streamed-sog.md) dataset is exactly one unbundled SOG.

---

## File set

| File | Purpose | Channels (8-bit) |
|------|---------|------------------|
| `meta.json`          | Scene metadata + filenames        | — |
| `means_l.webp`       | Positions — lower 8 bits          | R,G,B |
| `means_u.webp`       | Positions — upper 8 bits          | R,G,B |
| `scales.webp`        | Per-axis sizes via codebook       | R,G,B |
| `quats.webp`         | Orientation — compressed quat     | R,G,B,A |
| `sh0.webp`           | Base color (DC) + opacity         | R,G,B,A |
| `shN_centroids.webp` | SH palette coefficients (optional)| R,G,B |
| `shN_labels.webp`    | Indices into SH palette (optional)| R,G |

- Images **should** be **lossless WebP** (lossy corrupts quantized values).
- Pixels are row-major, origin top-left. For width `W`: index→pixel `x=i%W, y=floor(i/W)`.
- `meta.count <= W*H`; trailing pixels ignored.
- Coordinate system: **right-handed, x=right, y=up, z=back** (−z forward).
- Bundled variant = a ZIP of the same files (`scene.sog`). Streamed SOG uses **unbundled** only.

---

## Property encodings

### Positions — `means_l/u.webp` (16-bit/axis, log-domain)
```ts
const q  = (means_u.c << 8) | means_l.c;            // per channel, 0..65535
const n  = lerp(meta.means.mins[k], meta.means.maxs[k], q / 65535);  // log-domain
const p  = Math.sign(n) * (Math.exp(Math.abs(n)) - 1);               // undo symmetric log
```

### Orientation — `quats.webp` (RGBA, 26-bit smallest-three, order **w,x,y,z**)
```ts
const toComp = c => (c / 255 - 0.5) * 2 / Math.SQRT2;   // [-√2/2, +√2/2]
const a = toComp(r), b = toComp(g), cc = toComp(b);
const mode = quats.a - 252;                              // 0..3 → omitted = w,x,y,z
const d = Math.sqrt(Math.max(0, 1 - (a*a + b*b + cc*cc)));
// q ordered [w,x,y,z], reinsert d at `mode`
```
`quats.a` MUST be in {252,253,254,255}.

### Scales — `scales.webp` (RGB codebook indices, **log-domain**)
```ts
const sx = Math.exp(meta.scales.codebook[scales.r]);   // codebook = 256 log floats
```

### Base color + opacity (DC) — `sh0.webp` (RGBA)
```ts
const SH_C0 = 0.28209479177387814;
const r = 0.5 + meta.sh0.codebook[sh0.r] * SH_C0;       // gamma-space color
const a = sh0.a / 255;                                  // opacity [0,1]
```

### Higher-order SH (optional) — `shN_centroids/labels.webp`
Palette of AC coefficients. `bands∈[1,3]` → 3/8/15 coeffs/channel. 16-bit label per
Gaussian (`labels.r + (labels.g<<8)`) indexes a centroid row (64 entries/row); each
centroid channel is a codebook index into the shared 256-float `shN.codebook`.

---

## meta.json (v2)

```ts
interface Meta {
  version: 2;
  asset?: { generator?: string };
  count: number;
  antialias?: boolean;
  means:  { mins:[number,number,number]; maxs:[number,number,number]; files:[string,string] };
  scales: { codebook: number[]; files:[string] };      // 256 log floats
  quats:  { files:[string] };
  sh0:    { codebook: number[]; files:[string] };       // 256 floats
  shN?:   { count:number; bands:1|2|3; codebook:number[]; files:[string,string] };
}
```

---

## References
- SOG spec: https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/
- Streamed SOG (LOD): [streamed-sog.md](streamed-sog.md)
- SplatTransform: https://github.com/playcanvas/splat-transform

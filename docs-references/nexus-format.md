# Nexus (.nxs / .nxz) — CNR-ISTI multiresolution mesh

> Status: 🟠 **doc-referenced only — no converter built** (Nexus is a multiresolution *mesh* format,
> not Gaussian splats, and is comparatively niche). Listed for completeness / possible future work.
> Refs: https://github.com/cnr-isti-vclab/nexus · paper "Fast decompression for web-based
> view-dependent 3D rendering" (Ponchio & Dellepiane, 2016):
> https://vcg.isti.cnr.it/Publications/2016/PD16/FastDec_Ponchio.pdf

## Gist
Nexus stores a **multiresolution DAG of mesh patches** built by batched multi-triangulation. A
viewer traverses the DAG and selects a cut of patches to meet a screen-space error budget, streaming
patches on demand (the `.nxz` variant adds per-patch geometry/color compression with fast GPU-side
decode — the focus of the 2016 paper).

- **Hierarchy:** DAG of patches (not a strict tree); each node = a mesh chunk at some LoD.
- **Content:** triangle mesh (vertices/faces) + optional per-vertex color/normals/texcoords; **not splats**.
- **Metadata:** header + patch index (offsets/bounding spheres/errors) at the file head; patch data follows.
- **HTTP:** range-requestable (patches fetched individually), designed for web streaming.

## Why no converter (yet)
This repo targets **Gaussian-splat** tiling → 3D Tiles `KHR_gaussian_splatting`. Nexus is mesh-based,
so a `nexus-to-3dtiles` would emit `b3dm`/`glTF` mesh tiles, not splats — a different content path.
Low demand; left as a reference. The DAG→tree mapping (pick a patch cut per SSE) maps conceptually
onto 3D Tiles HLOD if ever needed.

//! Spark's RAD decoder behind two functions for Node:
//!   - `radHeader(bytes)`: the file header's JSON and the offset where the chunks start;
//!   - `decodeRadChunk(bytes)`: one `RADC` chunk decoded by Spark's own `RadDecoder` into flat columns.
//! Nothing here knows the format: the bytes go to `spark_lib::rad`, and what it hands its receiver is returned as is.

use js_sys::{Float32Array, Object, Reflect, Uint16Array, Uint32Array};
use spark_lib::decoder::{ChunkReceiver, SetSplatEncoding, SplatInit, SplatProps, SplatReceiver};
use spark_lib::rad::{decode_rad_header, RadDecoder};
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct Columns {
    count: usize,
    max_sh: usize,
    lod_tree: bool,
    lod_opacity: Option<bool>,
    center: Vec<f32>,
    opacity: Vec<f32>,
    rgb: Vec<f32>,
    scale: Vec<f32>,
    quat: Vec<f32>,
    sh1: Vec<f32>,
    sh2: Vec<f32>,
    sh3: Vec<f32>,
    sh1_codes: Vec<f32>,
    sh2_codes: Vec<f32>,
    sh3_codes: Vec<f32>,
    sh_labels: Vec<u32>,
    child_count: Vec<u16>,
    child_start: Vec<u32>,
}

/// Write `src` (`count` elements of `dims` values) at element `base` of `dst`, growing it as needed.
fn put<T: Copy + Default>(dst: &mut Vec<T>, base: usize, count: usize, dims: usize, src: &[T]) {
    let n = count.min(src.len() / dims.max(1));
    let end = (base + n) * dims;
    if dst.len() < end {
        dst.resize(end, T::default());
    }
    dst[base * dims..end].copy_from_slice(&src[..n * dims]);
}

impl SplatReceiver for Columns {
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        self.count = init.num_splats;
        self.max_sh = init.max_sh_degree;
        self.lod_tree = init.lod_tree;
        Ok(())
    }
    fn set_encoding(&mut self, encoding: &SetSplatEncoding) -> anyhow::Result<()> {
        if encoding.lod_opacity.is_some() {
            self.lod_opacity = encoding.lod_opacity;
        }
        Ok(())
    }
    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
        put(&mut self.center, base, count, 3, batch.center);
        put(&mut self.opacity, base, count, 1, batch.opacity);
        put(&mut self.rgb, base, count, 3, batch.rgb);
        put(&mut self.scale, base, count, 3, batch.scale);
        put(&mut self.quat, base, count, 4, batch.quat);
        if !batch.sh1.is_empty() { put(&mut self.sh1, base, count, 9, batch.sh1); }
        if !batch.sh2.is_empty() { put(&mut self.sh2, base, count, 15, batch.sh2); }
        if !batch.sh3.is_empty() { put(&mut self.sh3, base, count, 21, batch.sh3); }
        if !batch.child_count.is_empty() { put(&mut self.child_count, base, count, 1, batch.child_count); }
        if !batch.child_start.is_empty() {
            let starts: Vec<u32> = batch.child_start.iter().map(|&v| v as u32).collect();
            put(&mut self.child_start, base, count, 1, &starts);
        }
    }
    fn set_center(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.center, base, count, 3, v); }
    fn set_opacity(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.opacity, base, count, 1, v); }
    fn set_rgb(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.rgb, base, count, 3, v); }
    fn set_rgba(&mut self, base: usize, count: usize, v: &[f32]) {
        let n = count.min(v.len() / 4);
        let (mut rgb, mut a) = (Vec::with_capacity(n * 3), Vec::with_capacity(n));
        for i in 0..n {
            rgb.extend_from_slice(&v[i * 4..i * 4 + 3]);
            a.push(v[i * 4 + 3]);
        }
        put(&mut self.rgb, base, n, 3, &rgb);
        put(&mut self.opacity, base, n, 1, &a);
    }
    fn set_scale(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.scale, base, count, 3, v); }
    fn set_quat(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.quat, base, count, 4, v); }
    fn set_sh(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32]) {
        if !sh1.is_empty() { put(&mut self.sh1, base, count, 9, sh1); }
        if !sh2.is_empty() { put(&mut self.sh2, base, count, 15, sh2); }
        if !sh3.is_empty() { put(&mut self.sh3, base, count, 21, sh3); }
    }
    fn set_sh1(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.sh1, base, count, 9, v); }
    fn set_sh2(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.sh2, base, count, 15, v); }
    fn set_sh3(&mut self, base: usize, count: usize, v: &[f32]) { put(&mut self.sh3, base, count, 21, v); }
    // Clustered harmonics: a table of coefficient sets (the codes) and one label per splat. Their sizes are the
    // table's, not the chunk's, so they are kept whole.
    fn set_sh1_codes(&mut self, _base: usize, _count: usize, v: &[f32]) { self.sh1_codes = v.to_vec(); }
    fn set_sh2_codes(&mut self, _base: usize, _count: usize, v: &[f32]) { self.sh2_codes = v.to_vec(); }
    fn set_sh3_codes(&mut self, _base: usize, _count: usize, v: &[f32]) { self.sh3_codes = v.to_vec(); }
    fn set_sh_labels(&mut self, base: usize, count: usize, v: &[u32]) { put(&mut self.sh_labels, base, count, 1, v); }
    fn set_child_count(&mut self, base: usize, count: usize, v: &[u16]) { put(&mut self.child_count, base, count, 1, v); }
    fn set_child_start(&mut self, base: usize, count: usize, v: &[usize]) {
        let starts: Vec<u32> = v.iter().map(|&x| x as u32).collect();
        put(&mut self.child_start, base, count, 1, &starts);
    }
}

fn err(e: anyhow::Error) -> JsValue { JsValue::from_str(&format!("{e:#}")) }
fn set(o: &Object, k: &str, v: &JsValue) { let _ = Reflect::set(o, &JsValue::from_str(k), v); }
fn f32s(o: &Object, k: &str, v: &[f32]) { if !v.is_empty() { set(o, k, &Float32Array::from(v).into()); } }

/// The header of a `.rad` file: `{ meta: <JSON text>, chunksStart }`, or `undefined` when `bytes` stops before its end.
#[wasm_bindgen(js_name = radHeader)]
pub fn rad_header(bytes: &[u8]) -> Result<JsValue, JsValue> {
    match decode_rad_header(bytes).map_err(err)? {
        None => Ok(JsValue::UNDEFINED),
        Some((meta, chunks_start)) => {
            let o = Object::new();
            set(&o, "meta", &JsValue::from_str(&serde_json::to_string(&meta).map_err(|e| err(e.into()))?));
            set(&o, "chunksStart", &JsValue::from_f64(chunks_start as f64));
            Ok(o.into())
        }
    }
}

/// One `RADC` chunk (its header and payload, as stored in the file) decoded by Spark's `RadDecoder`.
/// Returns `{ count, maxSh, lodTree, lodOpacity?, center, opacity, rgb, scale, quat, sh1?, sh2?, sh3?,
/// sh1Codes?, sh2Codes?, sh3Codes?, shLabels?, childCount?, childStart? }`: the values Spark's renderer receives,
/// before anything a renderer applies to them (a `lodOpacity` file stores half the opacity).
#[wasm_bindgen(js_name = decodeRadChunk)]
pub fn decode_rad_chunk(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let mut decoder = RadDecoder::new(Columns::default());
    decoder.push(bytes).map_err(err)?;
    decoder.finish().map_err(err)?;
    let c = decoder.into_splats();
    let o = Object::new();
    set(&o, "count", &JsValue::from_f64(c.count as f64));
    set(&o, "maxSh", &JsValue::from_f64(c.max_sh as f64));
    set(&o, "lodTree", &JsValue::from_bool(c.lod_tree));
    if let Some(v) = c.lod_opacity { set(&o, "lodOpacity", &JsValue::from_bool(v)); }
    f32s(&o, "center", &c.center);
    f32s(&o, "opacity", &c.opacity);
    f32s(&o, "rgb", &c.rgb);
    f32s(&o, "scale", &c.scale);
    f32s(&o, "quat", &c.quat);
    f32s(&o, "sh1", &c.sh1);
    f32s(&o, "sh2", &c.sh2);
    f32s(&o, "sh3", &c.sh3);
    f32s(&o, "sh1Codes", &c.sh1_codes);
    f32s(&o, "sh2Codes", &c.sh2_codes);
    f32s(&o, "sh3Codes", &c.sh3_codes);
    if !c.sh_labels.is_empty() { set(&o, "shLabels", &Uint32Array::from(&c.sh_labels[..]).into()); }
    if !c.child_count.is_empty() { set(&o, "childCount", &Uint16Array::from(&c.child_count[..]).into()); }
    if !c.child_start.is_empty() { set(&o, "childStart", &Uint32Array::from(&c.child_start[..]).into()); }
    Ok(o.into())
}

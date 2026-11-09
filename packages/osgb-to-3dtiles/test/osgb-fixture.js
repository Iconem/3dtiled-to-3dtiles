/**
 * osgb-fixture.js — a minimal OSGB WRITER, for tests only: the tests must not need the network, and no real export has
 * a licence that clearly allows committing it. It writes the same layouts the reader documents (osgb-reader.js), for
 * any file version, with or without block sizes ("binary brackets") and zlib, from a small description of a scene:
 *
 *   { type: 'Group', children: [...] }
 *   { type: 'MatrixTransform', matrix: [16], children: [...] }
 *   { type: 'PagedLOD', center: [x,y,z], radius, rangeMode: 0|1, ranges: [[min,max],…], files: ['', 'finer.osgb'], children: [...] }
 *   { type: 'Geode', drawables: [{ vertices: Float32Array, uvs?, normals?, indices? | arrays?: { first, count }, mode = 4,
 *       texture?: { name, file: Buffer } | { name, raw: { width, height, pixelFormat, internalFormat?, dataType?, packing?, pixels } },
 *       diffuse?: [r,g,b,a] }] }
 *   { type: 'Unknown', className, bytes: Buffer }        (a class the reader has no layout for)
 */
import zlib from 'node:zlib';

class Out {
  constructor(version, brackets) { this.version = version; this.brackets = brackets; this.parts = []; this.length = 0; this.open = []; this.nextId = 1; }
  push(b) { this.parts.push(b); this.length += b.length; return this; }
  num(size, write, v) { const b = Buffer.alloc(size); b[write](v); return this.push(b); }
  bool(v) { return this.push(Buffer.from([v ? 1 : 0])); }
  i32(v) { return this.num(4, 'writeInt32LE', v); }
  u32(v) { return this.num(4, 'writeUInt32LE', v >>> 0); }
  f32(v) { return this.num(4, 'writeFloatLE', v); }
  f64(v) { return this.num(8, 'writeDoubleLE', v); }
  str(s) { const b = Buffer.from(s, 'utf8'); return this.i32(b.length).push(b); }
  data(typed) { return this.push(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)); }
  begin() { if (this.brackets) { const b = Buffer.alloc(this.version > 148 ? 8 : 4); this.open.push([b, this.length]); this.push(b); } return this; }
  end() {
    if (!this.brackets) return this;
    const [b, start] = this.open.pop(), size = this.length - start;
    if (b.length === 8) b.writeBigUInt64LE(BigInt(size)); else b.writeInt32LE(size);
    return this;
  }
}

function object(o, className, fields) { o.str(className).begin().u32(o.nextId++); fields(); o.end(); }
const objectFields = (o) => { o.str('').i32(2).bool(false); };                       // name, data variance, no user data
function nodeFields(o, stateSet) {
  o.bool(false).bool(false).bool(false).bool(false).bool(false).bool(true).u32(0xffffffff);
  if (o.version < 77) o.bool(false);                                                  // descriptions
  if (stateSet) { o.bool(true); stateSet(); } else o.bool(false);
}
function children(o, nodes) {
  o.bool(nodes.length > 0);
  if (!nodes.length) return;
  o.u32(nodes.length).begin();
  for (const n of nodes) node(o, n);
  o.end();
}

function image(o, tex) {
  if (o.version > 94) o.str('osg::Image');
  o.u32(o.nextId++).str(tex.name || '').i32(0);
  if (tex.file) o.i32(1).u32(tex.file.length).push(tex.file);
  else {
    const r = tex.raw;
    o.i32(0).i32(0).i32(r.width).i32(r.height).i32(1).i32(r.internalFormat ?? r.pixelFormat).i32(r.pixelFormat).i32(r.dataType ?? 0x1401).i32(r.packing ?? 1).i32(1);
    o.u32(r.pixels.length).push(Buffer.from(r.pixels)).u32(0);
  }
  objectFields(o);
}

function stateSet(o, d) {
  object(o, 'osg::StateSet', () => {
    objectFields(o);
    o.bool(false);                                                                    // modes
    o.bool(!!d.diffuse);
    if (d.diffuse) {
      o.u32(1).begin();
      object(o, 'osg::Material', () => {
        objectFields(o); o.bool(false).bool(false).i32(5635);
        for (const c of [d.diffuse, d.diffuse, [0, 0, 0, 1], [0, 0, 0, 1]]) { o.bool(true).bool(true); c.forEach((v) => o.f32(v)); c.forEach((v) => o.f32(v)); }
        o.bool(true).bool(true).f32(0).f32(0);
      });
      o.i32(1).end();
    }
    o.bool(false);                                                                    // texture modes
    o.bool(!!d.texture);
    if (d.texture) {
      o.u32(1).begin().u32(1).begin();
      object(o, 'osg::Texture2D', () => {
        objectFields(o); o.bool(false).bool(false);
        for (const e of [10496, 10496, 10496, 9729, 9729]) o.bool(true).u32(e);
        o.f32(1).bool(true).bool(true).bool(false).bool(true);
        for (let i = 0; i < 4; i++) o.f64(0);
        o.i32(0).i32(0).bool(false).bool(false).bool(false).bool(false).i32(515).i32(6409).f32(0);
        if (o.version >= 95 && o.version < 154) o.bool(false);                         // image attachment
        if (o.version >= 98) o.bool(true).str('RGBA');                                // swizzle
        if (o.version >= 155) o.f32(0).f32(-1).f32(0);
        o.bool(true); image(o, d.texture);
        o.i32(0).i32(0);
      });
      o.i32(1).end().end();
    }
    o.bool(false).i32(0).i32(0).i32(0).str('').bool(true).bool(false).bool(false);
    if (o.version >= 151) o.bool(false);
  });
}

const arrayObject = (o, className, typed, perElement) => object(o, className, () => {
  objectFields(o);
  if (o.version >= 147) o.bool(false);                                                // buffer object
  o.i32(4).bool(false).bool(false).u32(typed.length / perElement).data(typed);
});
/** A vertex attribute as files before version 112 write it. */
const arrayData = (o, code, typed, perElement) => {
  o.begin().bool(true).u32(o.nextId++).i32(code).i32(typed.length / perElement).begin().data(typed).end().bool(false).i32(4).i32(0).end();
};

function geometry(o, d) {
  object(o, 'osg::Geometry', () => {
    const v = o.version, ss = d.texture || d.diffuse ? () => stateSet(o, d) : null;
    objectFields(o);
    if (v >= 154) nodeFields(o, v >= 156 ? ss : null);
    if (v < 156) { if (ss) { o.bool(true); ss(); } else o.bool(false); }
    o.bool(false).bool(false).bool(false).bool(true).bool(true).bool(false);
    if (v < 156) o.bool(false).bool(false).bool(false).bool(false);
    if (v >= 142) o.u32(0xffffffff);
    if (v >= 145) o.bool(true);

    const mode = d.mode ?? 4;
    o.u32(1);
    if (v < 112) {
      o.i32(d.indices ? 54 : 50).i32(mode);
      if (v > 96) o.u32(0);
      if (d.indices) o.u32(d.indices.length).begin().data(d.indices).end(); else o.i32(d.arrays.first).i32(d.arrays.count);
      o.bool(true); arrayData(o, 16, d.vertices, 3);
      o.bool(!!d.normals); if (d.normals) arrayData(o, 16, d.normals, 3);
      o.bool(false).bool(false).bool(false);
      o.bool(!!d.uvs); if (d.uvs) { o.u32(1).begin(); arrayData(o, 15, d.uvs, 2); o.end(); }
      o.bool(false).bool(true);
    } else {
      object(o, d.indices ? 'osg::DrawElementsUInt' : 'osg::DrawArrays', () => {
        objectFields(o);
        if (v >= 147) o.bool(false);
        o.i32(0).i32(mode);
        if (d.indices) o.u32(d.indices.length).data(d.indices); else o.i32(d.arrays.first).i32(d.arrays.count);
      });
      o.bool(true); arrayObject(o, 'osg::Vec3Array', d.vertices, 3);
      o.bool(!!d.normals); if (d.normals) arrayObject(o, 'osg::Vec3Array', d.normals, 3);
      o.bool(false).bool(false).bool(false);
      o.u32(d.uvs ? 1 : 0); if (d.uvs) arrayObject(o, 'osg::Vec2Array', d.uvs, 2);
      o.u32(0);
    }
  });
}

function node(o, n) {
  if (n.type === 'Unknown') return object(o, n.className, () => o.push(n.bytes));
  if (n.type === 'Geode') return object(o, 'osg::Geode', () => {
    objectFields(o); nodeFields(o);
    o.bool(true).u32(n.drawables.length).begin();
    for (const d of n.drawables) geometry(o, d);
    o.end();
  });
  if (n.type === 'PagedLOD') return object(o, 'osg::PagedLOD', () => {
    objectFields(o); nodeFields(o);
    o.i32(1).bool(true); n.center.forEach((v) => o.f64(v)); o.f64(n.radius);
    o.i32(n.rangeMode ?? 1).bool(true).u32(n.ranges.length).begin();
    for (const [a, b] of n.ranges) o.f32(a).f32(b);
    o.end();
    o.bool(true).bool(false);                                                         // database path: none
    if (o.version < 70) o.u32(0);
    o.u32(0).bool(false);
    o.bool(true).u32(n.files.length).begin(); n.files.forEach((f) => o.str(f)); o.end();
    o.u32(n.files.length).begin(); n.files.forEach(() => o.f32(0).f32(1)); o.end();
    const kids = n.children || [];
    o.bool(kids.length > 0);
    if (kids.length) { o.u32(kids.length).begin(); kids.forEach((k) => node(o, k)); o.end(); }
  });
  return object(o, n.type === 'MatrixTransform' ? 'osg::MatrixTransform' : 'osg::Group', () => {
    objectFields(o); nodeFields(o); children(o, n.children || []);
    if (n.type === 'MatrixTransform') { o.i32(0).begin(); n.matrix.forEach((v) => o.f64(v)); o.end(); }
  });
}

/** A scene description → the bytes of an .osgb file. */
export function encodeOsgb(root, { version = 91, brackets = false, compress = false } = {}) {
  const o = new Out(version, brackets);
  node(o, root);
  const body = Buffer.concat(o.parts);
  const head = new Out(version, false);
  head.u32(0x6C910EA1).u32(0x1AFB4545).u32(1).u32(version).u32(brackets ? 4 : 0).str(compress ? 'zlib' : '0');
  return Buffer.concat([...head.parts, compress ? zlib.gzipSync(body) : body]);
}

/** A unit square in the z = `z` plane, two triangles, with UVs: what a tile of a test dataset holds. */
export const quad = (x0, y0, size, z = 0) => ({
  vertices: new Float32Array([x0, y0, z, x0 + size, y0, z, x0 + size, y0 + size, z, x0, y0 + size, z]),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

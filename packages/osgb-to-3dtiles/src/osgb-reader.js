/**
 * osgb-reader.js — a clean-room reader of OpenSceneGraph's native binary scene files (`.osgb`), as far as tiled
 * photogrammetry exports use them (Bentley ContextCapture / iTwin Capture, DJI Terra, Smart3D, Metashape, …).
 *
 * There is no specification. The layout below was learned from the OpenSceneGraph sources (the `osgDB` binary stream
 * and the per-class "wrappers" under `src/osgWrappers/serializers/osg/`) and checked against real exports; no code is
 * taken from them.
 *
 * FILE      u32 0x6C910EA1, u32 0x1AFB4545 (little-endian), u32 type (1 scene, 2 image, 3 object), u32 version
 *           (the OSG "SO version" the writer was built at: 80 = OSG 3.0, 91 = 3.2, 1xx = 3.4+), u32 attributes
 *           (1 custom domains follow, 2 an inline schema follows the compressor, 4 "binary brackets"), then a string
 *           naming the compressor: "0" for none, "zlib" for a gzip/zlib stream holding everything after it.
 * STRING    i32 length + bytes. BOOL one byte. Everything else is a plain little-endian scalar.
 * BRACKET   with attribute 4, every `{` of the text form is a block size here (i32, i64 from version 149), counted
 *           from the size field itself; `}` writes nothing. A reader can leave any block it does not understand.
 * OBJECT    string class name, `{`, u32 id, then, unless the id was already read (a shared object), the fields of
 *           every class the object derives from, base class first, in the order each class declares them. A class
 *           gained and lost fields over the versions, so each field carries the range of versions that write it.
 * FIELD     a value field is its bytes; an object field is a BOOL "present" and the OBJECT; a "user" field is a
 *           BOOL "present" and a layout of its own (lists are u32 count, `{`, items, `}`).
 * IMAGE     no bracket: [string class, from version 95] u32 id, string file name, i32 write hint, i32 decision
 *           (0 raw pixels follow with their GL formats, 1 the bytes of an image FILE follow, 2 external file),
 *           then the fields of osg::Object.
 * ARRAY     before version 112 arrays and primitive sets are not objects: u32 id, i32 type code, i32 count, `{`,
 *           the elements, `}`; a primitive set is i32 type code, i32 GL mode, [u32 instances from 97], then
 *           first/count or a counted index list. From 112 both are ordinary OBJECTs (osg::Vec3Array, …).
 */
import zlib from 'node:zlib';

const MAGIC_LOW = 0x6C910EA1, MAGIC_HIGH = 0x1AFB4545;

class Cursor {
  constructor(buf, version, brackets) { this.b = buf; this.o = 0; this.version = version; this.brackets = brackets; this.blocks = []; }
  u8() { return this.b.readUInt8(this.o++); }
  bool() { return this.b.readUInt8(this.o++) !== 0; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  f64s(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f64(); return a; }
  f32s(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  bytes(n) { if (n < 0 || this.o + n > this.b.length) throw new RangeError(`osgb: ${n} bytes asked at ${this.o}, file has ${this.b.length}`); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  str() { const n = this.i32(); if (n < 0 || n > 1 << 20) throw new RangeError(`osgb: string of ${n} bytes at ${this.o - 4}`); return this.bytes(n).toString('utf8'); }
  /** `{`: with binary brackets, the size of the block, counted from this field. */
  begin() {
    if (!this.brackets) return;
    const start = this.o;
    const size = this.version > 148 ? Number(this.b.readBigUInt64LE(this.o)) : this.b.readInt32LE(this.o);
    this.o += this.version > 148 ? 8 : 4;
    this.blocks.push(start + size);
  }
  /** `}` of a block read to its end. */
  end() { if (this.brackets) this.blocks.pop(); }
  /** `}` of a block that may hold more than was read: go to where it ends. True when something was left unread. */
  leave() {
    if (!this.brackets) return false;
    const end = this.blocks.pop();
    const skipped = end !== this.o;
    if (end >= this.o && end <= this.b.length) this.o = end;
    return skipped;
  }
}

// ── arrays ───────────────────────────────────────────────────────────────────────────────────────────────────────
// type code (files before version 112) → [class name (112+), components, element type]
const ARRAYS = [
  [0, 'ByteArray', 1, Int8Array], [1, 'UByteArray', 1, Uint8Array], [2, 'ShortArray', 1, Int16Array], [3, 'UShortArray', 1, Uint16Array],
  [4, 'IntArray', 1, Int32Array], [5, 'UIntArray', 1, Uint32Array], [6, 'FloatArray', 1, Float32Array], [7, 'DoubleArray', 1, Float64Array],
  [8, 'Vec2bArray', 2, Int8Array], [9, 'Vec3bArray', 3, Int8Array], [10, 'Vec4bArray', 4, Int8Array], [11, 'Vec4ubArray', 4, Uint8Array],
  [12, 'Vec2sArray', 2, Int16Array], [13, 'Vec3sArray', 3, Int16Array], [14, 'Vec4sArray', 4, Int16Array],
  [15, 'Vec2Array', 2, Float32Array], [16, 'Vec3Array', 3, Float32Array], [17, 'Vec4Array', 4, Float32Array],
  [18, 'Vec2dArray', 2, Float64Array], [19, 'Vec3dArray', 3, Float64Array], [20, 'Vec4dArray', 4, Float64Array],
  [21, 'Vec2ubArray', 2, Uint8Array], [22, 'Vec3ubArray', 3, Uint8Array],
  [23, 'Vec2usArray', 2, Uint16Array], [24, 'Vec3usArray', 3, Uint16Array], [25, 'Vec4usArray', 4, Uint16Array],
  [26, 'Vec2iArray', 2, Int32Array], [27, 'Vec3iArray', 3, Int32Array], [28, 'Vec4iArray', 4, Int32Array],
  [29, 'Vec2uiArray', 2, Uint32Array], [30, 'Vec3uiArray', 3, Uint32Array], [31, 'Vec4uiArray', 4, Uint32Array],
];
const ARRAY_BY_CODE = new Map(ARRAYS.map((a) => [a[0], a]));

/** `count` elements of `components` values → a typed array that owns its (aligned) bytes. */
function typedData(r, count, components, Type) {
  const n = count * components, raw = r.bytes(n * Type.BYTES_PER_ELEMENT);
  const out = new Type(n);
  new Uint8Array(out.buffer).set(raw);
  return out;
}

// ── field kinds ──────────────────────────────────────────────────────────────────────────────────────────────────
const bool = (r) => r.bool(), int = (r) => r.i32(), uint = (r) => r.u32(), float = (r) => r.f32(), string = (r) => r.str();
const vec4f = (r) => r.f32s(4), vec4d = (r) => r.f64s(4);
const object = (r, c) => (r.bool() ? c.readObject() : null);
const image = (r, c) => (r.bool() ? c.readImage() : null);
const matrix = (r) => { r.begin(); const m = r.f64s(16); r.end(); return m; };
/** A field with a layout of its own, written only when the object has something to say. */
const user = (read) => (r, c) => (r.bool() ? read(r, c) : undefined);
const list = (item) => (r, c) => { const n = r.u32(); r.begin(); const out = []; for (let i = 0; i < n; i++) out.push(item(r, c)); r.end(); return out; };
const glenumUser = user(uint);

const modes = (r) => { const n = r.u32(), out = []; if (n) { r.begin(); for (let i = 0; i < n; i++) out.push([r.u32(), r.i32()]); r.end(); } return out; };
const attributes = (r, c) => { const n = r.u32(), out = []; if (n) { r.begin(); for (let i = 0; i < n; i++) { const a = c.readObject(); r.i32(); out.push(a); } r.end(); } return out; };
/** One vertex attribute of a Geometry written before version 112: the array, a deprecated index array, binding, normalize. */
const arrayData = (r, c) => {
  r.begin();
  const array = r.bool() ? c.readArray() : null;
  const indices = r.bool() ? c.readArray() : null;
  const binding = r.i32();
  r.i32();
  r.end();
  return array ? { ...array, binding, indexed: !!indices } : null;
};
const materialColor = user((r) => { r.bool(); const front = r.f32s(4); r.f32s(4); return front; });

// [field, kind, first version that writes it, first version that no longer does]
const CLASSES = {
  'osg::Object': [
    ['Name', string], ['DataVariance', int],
    ['UserData', user((r, c) => { r.begin(); const o = c.readObject(); r.end(); return o; }), 0, 77],
    ['UserDataContainer', object, 77],
  ],
  'osg::Node': [
    ['InitialBound', user((r) => { r.begin(); const b = { center: r.f64s(3), radius: r.f64() }; r.end(); return b; })],
    ['ComputeBoundingSphereCallback', object], ['UpdateCallback', object], ['EventCallback', object], ['CullCallback', object],
    ['CullingActive', bool], ['NodeMask', uint],
    ['Descriptions', user(list(string)), 0, 77],
    ['StateSet', object],
  ],
  'osg::Group': [['Children', user(list((r, c) => c.readObject()))]],
  'osg::LOD': [
    ['CenterMode', int],
    ['UserCenter', user((r) => ({ center: r.f64s(3), radius: r.f64() }))],
    ['RangeMode', int],                                               // 0 distance from the eye, 1 pixel size on screen
    ['RangeList', user(list((r) => [r.f32(), r.f32()]))],
  ],
  'osg::PagedLOD': [
    ['DatabasePath', user((r) => (r.bool() ? r.str() : ''))],
    ['FrameNumberOfLastTraversal', uint, 0, 70],
    ['NumChildrenThatCannotBeExpired', uint], ['DisableExternalChildrenPaging', bool],
    ['RangeDataList', user((r, c) => { const files = list(string)(r, c); list((q) => [q.f32(), q.f32()])(r, c); return files; })],
    ['Children', user((r, c) => { const n = r.u32(), out = []; if (n) { r.begin(); for (let i = 0; i < n; i++) out.push(c.readObject()); r.end(); } return out; })],
  ],
  'osg::Geode': [['Drawables', user(list((r, c) => c.readObject()))]],
  'osg::Drawable': [
    ['StateSet', object, 0, 156],
    ['InitialBound', user((r) => { r.begin(); const b = { min: r.f64s(3), max: r.f64s(3) }; r.end(); return b; })],
    ['ComputeBoundingBoxCallback', object], ['Shape', object],
    ['SupportsDisplayList', bool], ['UseDisplayList', bool], ['UseVertexBufferObjects', bool],
    ['UpdateCallback', object, 0, 156], ['EventCallback', object, 0, 156], ['CullCallback', object, 0, 156], ['DrawCallback', object, 0, 156],
    ['NodeMask', uint, 142], ['CullingActive', bool, 145],
  ],
  'osg::Geometry': [
    ['PrimitiveSetList', (r, c) => { const n = r.u32(), out = []; for (let i = 0; i < n; i++) out.push(r.version >= 112 ? c.readObject() : c.readPrimitiveSet()); return out; }],
    ['VertexData', user(arrayData), 0, 112], ['NormalData', user(arrayData), 0, 112], ['ColorData', user(arrayData), 0, 112],
    ['SecondaryColorData', user(arrayData), 0, 112], ['FogCoordData', user(arrayData), 0, 112],
    ['TexCoordData', user(list(arrayData)), 0, 112], ['VertexAttribData', user(list(arrayData)), 0, 112],
    ['FastPathHint', bool, 0, 112],
    ['VertexArray', object, 112], ['NormalArray', object, 112], ['ColorArray', object, 112],
    ['SecondaryColorArray', object, 112], ['FogCoordArray', object, 112],
    ['TexCoordArrayList', (r, c) => { const n = r.u32(), out = []; for (let i = 0; i < n; i++) out.push(c.readObject()); return out; }, 112],
    ['VertexAttribArrayList', (r, c) => { const n = r.u32(), out = []; for (let i = 0; i < n; i++) out.push(c.readObject()); return out; }, 112],
  ],
  'osg::Transform': [['ReferenceFrame', int]],
  'osg::MatrixTransform': [['Matrix', matrix]],
  'osg::StateSet': [
    ['ModeList', user(modes)], ['AttributeList', user(attributes)],
    ['TextureModeList', user(list(modes))], ['TextureAttributeList', user(list(attributes))],
    ['UniformList', user(list((r, c) => { const u = c.readObject(); r.i32(); return u; }))],
    ['RenderingHint', int], ['RenderBinMode', int], ['BinNumber', int], ['BinName', string], ['NestRenderBins', bool],
    ['UpdateCallback', object], ['EventCallback', object],
    ['DefineList', user(list((r) => { const d = [r.str(), r.str()]; r.i32(); return d; })), 151],
  ],
  'osg::StateAttribute': [['UpdateCallback', object], ['EventCallback', object]],
  'osg::Texture': [
    ['WRAP_S', glenumUser], ['WRAP_T', glenumUser], ['WRAP_R', glenumUser], ['MIN_FILTER', glenumUser], ['MAG_FILTER', glenumUser],
    ['MaxAnisotropy', float], ['UseHardwareMipMapGeneration', bool], ['UnRefImageDataAfterApply', bool], ['ClientStorageHint', bool],
    ['ResizeNonPowerOfTwoHint', bool], ['BorderColor', vec4d], ['BorderWidth', int], ['InternalFormatMode', int],
    ['InternalFormat', glenumUser], ['SourceFormat', glenumUser], ['SourceType', glenumUser],
    ['ShadowComparison', bool], ['ShadowCompareFunc', int], ['ShadowTextureMode', int], ['ShadowAmbient', float],
    ['ImageAttachment', user((r) => [r.u32(), r.i32(), r.u8(), r.i32(), r.u32(), r.u32()]), 95, 154],
    ['Swizzle', user(string), 98],
    ['MinLOD', float, 155], ['MaxLOD', float, 155], ['LODBias', float, 155],
  ],
  'osg::Texture2D': [['Image', image], ['TextureWidth', int], ['TextureHeight', int]],
  'osg::Material': [
    ['ColorMode', int], ['Ambient', materialColor], ['Diffuse', materialColor], ['Specular', materialColor], ['Emission', materialColor],
    ['Shininess', user((r) => { r.bool(); const s = r.f32(); r.f32(); return s; })],
  ],
  'osg::TexEnv': [['Mode', int], ['Color', vec4f]],
  'osg::CullFace': [['Mode', int]],
  'osg::ShadeModel': [['Mode', int]],
  'osg::BlendFunc': [['SourceRGB', uint], ['SourceAlpha', uint], ['DestinationRGB', uint], ['DestinationAlpha', uint]],
  'osg::UserDataContainer': [],
  'osg::DefaultUserDataContainer': [
    ['UDC_UserData', user((r, c) => { r.begin(); const o = c.readObject(); r.end(); return o; })],
    ['UDC_Descriptions', user(list(string))],
    ['UDC_UserObjects', user(list((r, c) => c.readObject()))],
  ],
  // arrays and primitive sets as objects (version 112 and later)
  'osg::BufferData': [['BufferObject', object, 147]],
  'osg::BufferObject': [['Target', uint], ['Usage', uint], ['CopyDataAndReleaseGLBufferObject', bool], ['MappingBitfield', uint, 201]],
  'osg::Array': [['Binding', int], ['Normalize', bool], ['PreserveDataType', bool]],
  'osg::PrimitiveSet': [['NumInstances', int], ['Mode', int]],
  'osg::DrawArrays': [['First', int], ['Count', int]],
  'osg::DrawArrayLengths': [['First', int], ['Lengths', (r) => typedData(r, r.u32(), 1, Int32Array)]],
  'osg::DrawElementsUByte': [['Indices', (r) => typedData(r, r.u32(), 1, Uint8Array)]],
  'osg::DrawElementsUShort': [['Indices', (r) => typedData(r, r.u32(), 1, Uint16Array)]],
  'osg::DrawElementsUInt': [['Indices', (r) => typedData(r, r.u32(), 1, Uint32Array)]],
};

// class → the classes whose fields it writes, base first: [class, first version that includes it]
const NODE = [['osg::Object'], ['osg::Node']], GROUP = [...NODE, ['osg::Group']];
const ATTRIBUTE = [['osg::Object'], ['osg::StateAttribute']];
const BUFFER = [['osg::Object'], ['osg::BufferData', 147]];
const PARENTS = {
  'osg::Node': NODE,
  'osg::Group': GROUP,
  'osg::LOD': [...GROUP, ['osg::LOD']],
  'osg::PagedLOD': [...NODE, ['osg::LOD'], ['osg::PagedLOD']],        // not osg::Group: its children are written by PagedLOD itself
  'osg::Geode': [...NODE, ['osg::Geode']],
  'osg::Geometry': [['osg::Object'], ['osg::Node', 154], ['osg::Drawable'], ['osg::Geometry']],
  'osg::Transform': [...GROUP, ['osg::Transform']],
  'osg::MatrixTransform': [...GROUP, ['osg::Transform'], ['osg::MatrixTransform']],
  'osg::StateSet': [['osg::Object'], ['osg::StateSet']],
  'osg::Texture2D': [...ATTRIBUTE, ['osg::Texture'], ['osg::Texture2D']],
  'osg::Material': [...ATTRIBUTE, ['osg::Material']],
  'osg::TexEnv': [...ATTRIBUTE, ['osg::TexEnv']],
  'osg::CullFace': [...ATTRIBUTE, ['osg::CullFace']],
  'osg::ShadeModel': [...ATTRIBUTE, ['osg::ShadeModel']],
  'osg::BlendFunc': [...ATTRIBUTE, ['osg::BlendFunc']],
  'osg::DefaultUserDataContainer': [['osg::Object'], ['osg::UserDataContainer'], ['osg::DefaultUserDataContainer']],
  'osg::BufferObject': [['osg::Object'], ['osg::BufferObject']],
  'osg::VertexBufferObject': [['osg::Object'], ['osg::BufferObject']],
  'osg::ElementBufferObject': [['osg::Object'], ['osg::BufferObject']],
  'osg::DrawArrays': [...BUFFER, ['osg::PrimitiveSet'], ['osg::DrawArrays']],
  'osg::DrawArrayLengths': [...BUFFER, ['osg::PrimitiveSet'], ['osg::DrawArrayLengths']],
  'osg::DrawElementsUByte': [...BUFFER, ['osg::PrimitiveSet'], ['osg::DrawElementsUByte']],
  'osg::DrawElementsUShort': [...BUFFER, ['osg::PrimitiveSet'], ['osg::DrawElementsUShort']],
  'osg::DrawElementsUInt': [...BUFFER, ['osg::PrimitiveSet'], ['osg::DrawElementsUInt']],
};
for (const [, name, components, Type] of ARRAYS) {
  CLASSES[`osg::${name}`] = [['data', (r) => typedData(r, r.u32(), components, Type)]];
  PARENTS[`osg::${name}`] = [...BUFFER, ['osg::Array'], [`osg::${name}`]];
}
const ARRAY_COMPONENTS = new Map(ARRAYS.map(([, name, components]) => [`osg::${name}`, components]));

class Reader {
  constructor(r, info) { this.r = r; this.info = info; this.objects = new Map(); this.arrays = new Map(); }

  readFields(className, obj) {
    const r = this.r, v = r.version;
    for (const [parent, since = 0] of PARENTS[className]) {
      if (v < since) continue;
      for (const [name, kind, first = 0, gone = Infinity] of CLASSES[parent]) {
        if (v < first || v >= gone) continue;
        const value = kind(r, this);
        if (value != null && obj[name] == null) obj[name] = value;          // Node and Drawable both have a StateSet: the first one set stays
      }
    }
    return obj;
  }

  readObject() {
    const r = this.r, className = r.str();
    if (className === 'NULL') return null;
    r.begin();
    const id = r.u32();
    let obj = this.objects.get(id);
    if (obj) { r.leave(); return obj; }
    obj = { class: className, id };
    this.objects.set(id, obj);
    if (!PARENTS[className]) {
      // An unknown class can only be stepped over when the file says where it ends.
      if (!r.brackets) throw new Error(`osgb: class ${className} is not supported, and this file has no block sizes to skip it`);
      obj.unsupported = true;
      this.info.skipped.add(className);
      r.leave();
      return obj;
    }
    this.readFields(className, obj);
    if (ARRAY_COMPONENTS.has(className)) obj.components = ARRAY_COMPONENTS.get(className);
    if (r.leave()) this.info.misread.add(className);
    return obj;
  }

  /** An array of a file older than version 112. */
  readArray() {
    const r = this.r, id = r.u32();
    const seen = this.arrays.get(id);
    if (seen) return seen;
    const code = r.i32(), def = ARRAY_BY_CODE.get(code);
    if (!def) throw new Error(`osgb: array type ${code} is not supported`);
    const count = r.i32();
    r.begin();
    const array = { class: `osg::${def[1]}`, components: def[2], data: typedData(r, count, def[2], def[3]) };
    r.end();
    this.arrays.set(id, array);
    return array;
  }

  /** A primitive set of a file older than version 112. */
  readPrimitiveSet() {
    const r = this.r, type = r.i32(), Mode = r.i32();
    if (r.version > 96) r.u32();                                           // instances
    if (type === 50) return { class: 'osg::DrawArrays', Mode, First: r.i32(), Count: r.i32() };
    if (type === 51) { const First = r.i32(), n = r.u32(); r.begin(); const Lengths = typedData(r, n, 1, Int32Array); r.end(); return { class: 'osg::DrawArrayLengths', Mode, First, Lengths }; }
    const Type = type === 52 ? Uint8Array : type === 53 ? Uint16Array : type === 54 ? Uint32Array : null;
    if (!Type) throw new Error(`osgb: primitive set type ${type} is not supported`);
    const n = r.u32();
    r.begin();
    const Indices = typedData(r, n, 1, Type);
    r.end();
    return { class: `osg::DrawElements${type === 52 ? 'UByte' : type === 53 ? 'UShort' : 'UInt'}`, Mode, Indices };
  }

  readImage() {
    const r = this.r;
    if (r.version > 94) r.str();                                           // class name, always osg::Image
    const id = r.u32();
    const seen = this.objects.get(id);
    if (seen) return seen;
    const img = { class: 'osg::Image', id, FileName: r.str(), WriteHint: r.i32() };
    this.objects.set(id, img);
    const decision = r.i32();
    if (decision === 0) {                                                  // raw pixels
      img.origin = r.i32(); img.width = r.i32(); img.height = r.i32(); img.depth = r.i32();
      img.internalFormat = r.i32(); img.pixelFormat = r.i32(); img.dataType = r.i32(); img.packing = r.i32();
      r.i32();                                                             // allocation mode
      const size = r.u32();
      img.pixels = r.bytes(size);
      const levels = r.u32();
      img.mipmapOffsets = []; for (let i = 0; i < levels; i++) img.mipmapOffsets.push(r.u32());
    } else if (decision === 1) {                                           // an image file, as it was on disk
      img.file = r.bytes(r.u32());
    } else img.external = true;
    this.readFields('osg::Object', img);
    return img;
  }
}
PARENTS['osg::Object'] = [['osg::Object']];

/** The header of an .osgb file, without reading (or inflating) what follows. */
export function readOsgbHeader(buf) {
  if (buf.length < 24 || buf.readUInt32LE(0) !== MAGIC_LOW || buf.readUInt32LE(4) !== MAGIC_HIGH) throw new Error('not an OSGB file (no OpenSceneGraph binary magic)');
  const type = buf.readUInt32LE(8), version = buf.readUInt32LE(12), attributes = buf.readUInt32LE(16);
  const r = new Cursor(buf, version, false);
  r.o = 20;
  const domains = {};
  if (attributes & 1) { const n = r.u32(); for (let i = 0; i < n; i++) { const name = r.str(); domains[name] = r.i32(); } }
  const compressor = r.str();
  return { type, version, attributes, brackets: !!(attributes & 4), schema: !!(attributes & 2), domains, compressor, bodyOffset: r.o };
}

/**
 * Parse an .osgb scene file.
 * @param {Buffer} buf the whole file
 * @returns {{ header, root, skipped: string[], misread: string[] }} `root` is the scene graph as plain objects
 *   ({ class, id, …fields named as OpenSceneGraph names them }); `skipped` lists the classes stepped over, `misread`
 *   those whose block held more than this reader knows (both empty for a file read in full).
 */
export function parseOsgb(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = readOsgbHeader(buf);
  if (header.type !== 1) throw new Error(`osgb: file type ${header.type} is not a scene`);
  let body = buf.subarray(header.bodyOffset);
  if (header.compressor === 'zlib') body = zlib.unzipSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  else if (header.compressor !== '0') throw new Error(`osgb: compressor "${header.compressor}" is not supported`);
  const r = new Cursor(body, header.version, header.brackets);
  if (header.schema) { header.schemaText = r.str(); if (header.schemaText.trim()) throw new Error('osgb: files with an inline schema are not supported'); }
  const info = { skipped: new Set(), misread: new Set() };
  const root = new Reader(r, info).readObject();
  return { header, root, skipped: [...info.skipped], misread: [...info.misread] };
}

// ── scene graph → what a tile needs ──────────────────────────────────────────────────────────────────────────────
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** OSG stores a matrix row by row for row vectors (v' = v·M), which is the column-major layout of glTF. child·parent in OSG terms. */
function compose(parent, m) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[c * 4 + row] += parent[k * 4 + row] * m[c * 4 + k];
  return out;
}

/** The triangles of a geometry's primitive sets, as indices into its vertices. Points and lines are dropped. */
function triangleIndices(primitiveSets, vertexCount) {
  const out = [];
  const run = (mode, at, count) => {                       // `at(i)` is the i-th vertex index of the run
    if (mode === 4) for (let i = 0; i + 2 < count; i += 3) out.push(at(i), at(i + 1), at(i + 2));
    else if (mode === 5) for (let i = 0; i + 2 < count; i++) { if (i & 1) out.push(at(i + 1), at(i), at(i + 2)); else out.push(at(i), at(i + 1), at(i + 2)); }
    else if (mode === 6 || mode === 9) for (let i = 1; i + 1 < count; i++) out.push(at(0), at(i), at(i + 1));
    else if (mode === 7) for (let i = 0; i + 3 < count; i += 4) out.push(at(i), at(i + 1), at(i + 2), at(i), at(i + 2), at(i + 3));
    else if (mode === 8) for (let i = 0; i + 3 < count; i += 2) out.push(at(i), at(i + 1), at(i + 2), at(i + 1), at(i + 3), at(i + 2));
  };
  for (const p of primitiveSets || []) {
    if (!p || p.unsupported) continue;
    if (p.Indices) run(p.Mode, (i) => p.Indices[i], p.Indices.length);
    else if (p.Lengths) { let first = p.First; for (const n of p.Lengths) { const f = first; run(p.Mode, (i) => f + i, n); first += n; } }
    else if (p.Count != null) run(p.Mode, (i) => p.First + i, p.Count);
  }
  const max = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new (out.some((i) => i > 65535) ? Uint32Array : max)(out.length);
  let ok = 0;
  for (let i = 0; i < out.length; i += 3) if (out[i] < vertexCount && out[i + 1] < vertexCount && out[i + 2] < vertexCount) { idx[ok++] = out[i]; idx[ok++] = out[i + 1]; idx[ok++] = out[i + 2]; }
  return ok === idx.length ? idx : idx.slice(0, ok);
}

const PER_VERTEX = 4;
const asFloat32 = (a) => (a.data instanceof Float32Array ? a.data : Float32Array.from(a.data));

/** One osg::Geometry → { positions, normals?, uvs?, colors?, indices, image?, diffuse? } in the file's own (Z-up) frame, or null. */
function meshOf(geom, stateSet, m) {
  const va = geom.VertexData || geom.VertexArray;
  if (!va || !va.data || va.components !== 3) return null;
  const n = va.data.length / 3;
  const indices = triangleIndices(geom.PrimitiveSetList, n);
  if (!n || !indices.length) return null;
  let positions = asFloat32(va);
  const identity = m.every((v, i) => v === IDENTITY[i]);
  if (!identity) {
    const src = va.data; positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
  }
  const mesh = { positions, indices };
  const na = geom.NormalData || geom.NormalArray;
  // normals are kept only when they need no transform: a tile under a MatrixTransform leaves them to the viewer
  if (identity && na && na.data && na.components === 3 && na.data.length === n * 3 && (na.binding ?? na.Binding) === PER_VERTEX) mesh.normals = asFloat32(na);
  const ta = (geom.TexCoordData || geom.TexCoordArrayList || [])[0];
  if (ta && ta.data && ta.components === 2 && ta.data.length === n * 2) mesh.uvs = asFloat32(ta);
  const ca = geom.ColorData || geom.ColorArray;
  if (ca && ca.data && ca.components === 4 && ca.data.length === n * 4 && (ca.binding ?? ca.Binding) === PER_VERTEX) {
    mesh.colors = ca.data instanceof Uint8Array ? ca.data : Uint8Array.from(ca.data, (v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  }
  // the texture of unit 0, from the geometry's own state or the nearest one above it
  for (const ss of [geom.StateSet, stateSet]) {
    const tex = ((ss?.TextureAttributeList || [])[0] || []).find((a) => a && a.class === 'osg::Texture2D' && a.Image);
    if (tex) { mesh.image = tex.Image; break; }
  }
  // the diffuse colour of its material, which is all an untextured mesh has (ContextCapture's grey for faces no photo saw)
  for (const ss of [geom.StateSet, stateSet]) {
    const mat = (ss?.AttributeList || []).find((a) => a && a.class === 'osg::Material' && a.Diffuse);
    if (mat) { mesh.diffuse = mat.Diffuse; break; }
  }
  return mesh;
}

const sphereOf = (meshes) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const { positions: p } of meshes) for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < mn[k]) mn[k] = p[i + k]; if (p[i + k] > mx[k]) mx[k] = p[i + k]; }
  if (mn[0] === Infinity) return null;
  return { center: mn.map((v, k) => (v + mx[k]) / 2), radius: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2, min: mn, max: mx };
};

/**
 * The tiles a parsed file holds. A file of a tiled export is one level of one tile: a few osg::PagedLOD nodes, each
 * with its own coarse mesh inline and the name of the file that refines it, or, at the last level, bare meshes.
 * @returns {Array<{ meshes, center, radius, min?, max?, rangeMode: 'pixels'|'distance'|null, range: number|null, files: string[] }>}
 *   one unit per PagedLOD (`files` are the finer files, relative to this one; `range` is where they take over: the
 *   size in pixels of the bounding sphere on screen, or the distance to it), and one for the meshes outside any.
 */
export function osgbUnits(scene) {
  const units = [], loose = [];
  const walk = (node, m, stateSet, unit) => {
    if (!node || node.unsupported) return;
    const ss = node.StateSet || stateSet;
    if (node.class === 'osg::Geode') {
      for (const d of node.Drawables || []) {
        if (!d || d.class !== 'osg::Geometry') continue;
        const mesh = meshOf(d, ss, m);
        if (mesh) (unit ? unit.meshes : loose).push(mesh);
      }
      return;
    }
    if (node.class === 'osg::Geometry') {                                  // a drawable placed in the graph directly (OSG 3.4+)
      const mesh = meshOf(node, ss, m);
      if (mesh) (unit ? unit.meshes : loose).push(mesh);
      return;
    }
    if (node.class === 'osg::PagedLOD' || node.class === 'osg::LOD') {
      const ranges = node.RangeList || [], files = node.class === 'osg::PagedLOD' ? node.RangeDataList || [] : [];
      const pixels = node.RangeMode === 1;
      const u = unit || { meshes: [], files: [], rangeMode: null, range: null, center: null, radius: 0 };
      // children are written for the ranges that name no file, in order
      const inline = [];
      for (let i = 0, c = 0; i < Math.max(ranges.length, files.length, (node.Children || []).length); i++) {
        if (files[i]) {
          u.files.push(files[i].replace(/\\/g, '/'));
          const r = ranges[i];
          if (r) { const at = pixels ? r[0] : r[1]; u.rangeMode = pixels ? 'pixels' : 'distance'; u.range = u.range == null ? at : pixels ? Math.min(u.range, at) : Math.max(u.range, at); }
        } else if ((node.Children || [])[c]) inline.push([node.Children[c++], ranges[i]]);
      }
      // several inline levels (a plain osg::LOD): the finest one stands for the node
      let shown = inline;
      if (inline.length > 1 && !u.files.length) shown = [inline.reduce((a, b) => (!a[1] || !b[1] ? a : (pixels ? b[1][1] > a[1][1] : b[1][0] < a[1][0]) ? b : a))];
      for (const [child] of shown) walk(child, m, ss, u);
      if (!unit) {
        const bound = node.UserCenter || node.InitialBound;
        if (bound && bound.radius > 0) { u.center = bound.center; u.radius = bound.radius; }
        units.push(u);
      }
      return;
    }
    const mm = node.class === 'osg::MatrixTransform' && node.Matrix ? compose(m, node.Matrix) : m;
    for (const child of node.Children || []) walk(child, mm, ss, unit);
  };
  walk(scene.root, IDENTITY, null, null);
  if (loose.length) units.push({ meshes: loose, files: [], rangeMode: null, range: null, center: null, radius: 0 });
  for (const u of units) {
    const s = sphereOf(u.meshes);
    if (s) { u.min = s.min; u.max = s.max; }
    if (!u.center && s) { u.center = s.center; u.radius = s.radius; }
  }
  return units.filter((u) => u.center);
}

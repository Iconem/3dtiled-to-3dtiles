/**
 * osgb-image.js — the texture of an .osgb tile as something glTF can carry.
 *
 * An osg::Image is written one of two ways (see osgb-reader.js): the bytes of the image FILE the exporter had, or raw
 * pixels with their OpenGL formats. ContextCapture and its relatives embed a JPEG file, which passes through untouched.
 * The rest is decoded here and re-encoded with the pure-JS codecs the repo already ships: DDS files and raw S3TC
 * blocks (DXT1/3/5, what an export "optimised for desktop GPUs" holds), and raw 8-bit RGB/RGBA/BGR/BGRA/luminance.
 *
 * Row order. OpenGL puts the first row of an image's data at v = 0. OSG's JPEG/PNG loaders hand over the bottom row
 * first, so in those files v = 0 is the BOTTOM of the picture, and a tile's UVs are flipped (v → 1 − v) for glTF,
 * whose v = 0 is the top. What is decoded here is written to match: raw pixels are stored bottom row first already and
 * are flipped to a top-down picture; a DDS file is read by OSG top row first (v = 0 is then the top of the picture),
 * so its rows are flipped once more to stay consistent with the UV flip.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const GL_RGB = 0x1907, GL_RGBA = 0x1908, GL_LUMINANCE = 0x1909, GL_LUMINANCE_ALPHA = 0x190A, GL_BGR = 0x80E0, GL_BGRA = 0x80E1, GL_UNSIGNED_BYTE = 0x1401;
const GL_DXT1_RGB = 0x83F0, GL_DXT1_RGBA = 0x83F1, GL_DXT3 = 0x83F2, GL_DXT5 = 0x83F3;

const rgb565 = (c, out, o) => { out[o] = ((c >> 11) & 31) * 255 / 31 + 0.5 | 0; out[o + 1] = ((c >> 5) & 63) * 255 / 63 + 0.5 | 0; out[o + 2] = (c & 31) * 255 / 31 + 0.5 | 0; out[o + 3] = 255; };

/** S3TC blocks → RGBA8, top row of the DATA first. `kind` 1, 3 or 5 (DXT1, DXT3, DXT5). */
export function decodeS3tc(data, width, height, kind) {
  const out = new Uint8Array(width * height * 4), pal = new Uint8Array(16), alpha = new Uint8Array(8);
  const blockBytes = kind === 1 ? 8 : 16;
  let o = 0;
  for (let by = 0; by < height; by += 4) for (let bx = 0; bx < width; bx += 4, o += blockBytes) {
    if (o + blockBytes > data.length) return out;
    const c = kind === 1 ? o : o + 8;
    const c0 = data[c] | (data[c + 1] << 8), c1 = data[c + 2] | (data[c + 3] << 8);
    rgb565(c0, pal, 0); rgb565(c1, pal, 4);
    if (kind !== 1 || c0 > c1) {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (2 * pal[k] + pal[4 + k] + 1) / 3 | 0; pal[12 + k] = (pal[k] + 2 * pal[4 + k] + 1) / 3 | 0; }
      pal[11] = pal[15] = 255;
    } else {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (pal[k] + pal[4 + k]) >> 1; pal[12 + k] = 0; }
      pal[11] = 255; pal[15] = 0;                                          // DXT1's one-bit transparency
    }
    if (kind === 5) {
      const a0 = alpha[0] = data[o], a1 = alpha[1] = data[o + 1];
      if (a0 > a1) for (let k = 1; k < 7; k++) alpha[k + 1] = ((7 - k) * a0 + k * a1 + 3) / 7 | 0;
      else { for (let k = 1; k < 5; k++) alpha[k + 1] = ((5 - k) * a0 + k * a1 + 2) / 5 | 0; alpha[6] = 0; alpha[7] = 255; }
    }
    for (let py = 0; py < 4; py++) {
      const bits = data[c + 4 + py];
      for (let px = 0; px < 4; px++) {
        const x = bx + px, y = by + py;
        if (x >= width || y >= height) continue;
        const p = ((bits >> (px * 2)) & 3) * 4, d = (y * width + x) * 4, i = py * 4 + px;
        out[d] = pal[p]; out[d + 1] = pal[p + 1]; out[d + 2] = pal[p + 2]; out[d + 3] = pal[p + 3];
        if (kind === 3) out[d + 3] = ((data[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
        else if (kind === 5) {                                             // 16 three-bit indices in 6 bytes
          const bit = i * 3, byte = o + 2 + (bit >> 3);
          out[d + 3] = alpha[(((data[byte] | ((data[byte + 1] ?? 0) << 8)) >> (bit & 7)) & 7)];
        }
      }
    }
  }
  return out;
}

/** A .dds file → { width, height, rgba } (top row first), or null for a pixel format not handled here. */
export function decodeDds(file) {
  if (file.length < 128 || file.toString('latin1', 0, 4) !== 'DDS ') return null;
  const height = file.readUInt32LE(12), width = file.readUInt32LE(16);
  const flags = file.readUInt32LE(80), fourCC = file.toString('latin1', 84, 88), bits = file.readUInt32LE(88);
  const data = file.subarray(128);
  if (flags & 4) {                                                         // DDPF_FOURCC
    const kind = { DXT1: 1, DXT3: 3, DXT5: 5 }[fourCC];
    return kind ? { width, height, rgba: decodeS3tc(data, width, height, kind) } : null;
  }
  if ((flags & 0x40) && (bits === 24 || bits === 32)) {                    // DDPF_RGB, byte masks
    const shift = (mask) => (mask ? Math.log2(mask & -mask) >> 3 : -1);
    const r = shift(file.readUInt32LE(92)), g = shift(file.readUInt32LE(96)), b = shift(file.readUInt32LE(100)), a = (flags & 1) ? shift(file.readUInt32LE(104)) : -1;
    const step = bits / 8, rgba = new Uint8Array(width * height * 4);
    if (data.length < width * height * step) return null;
    for (let i = 0, s = 0, d = 0; i < width * height; i++, s += step, d += 4) { rgba[d] = data[s + r]; rgba[d + 1] = data[s + g]; rgba[d + 2] = data[s + b]; rgba[d + 3] = a >= 0 ? data[s + a] : 255; }
    return { width, height, rgba };
  }
  return null;
}

/** Raw pixels of an osg::Image → { width, height, rgba } (first row of the data first), or null when the format is not handled. */
function decodeRaw(img) {
  const { width, height, pixelFormat, dataType, pixels } = img;
  const kind = { [GL_DXT1_RGB]: 1, [GL_DXT1_RGBA]: 1, [GL_DXT3]: 3, [GL_DXT5]: 5 }[pixelFormat];
  if (kind) return { width, height, rgba: decodeS3tc(pixels, width, height, kind) };
  if (dataType !== GL_UNSIGNED_BYTE) return null;
  const n = { [GL_RGB]: 3, [GL_BGR]: 3, [GL_RGBA]: 4, [GL_BGRA]: 4, [GL_LUMINANCE]: 1, [GL_LUMINANCE_ALPHA]: 2 }[pixelFormat];
  if (!n) return null;
  const packing = img.packing > 1 ? img.packing : 1, rowBytes = Math.ceil(width * n / packing) * packing;   // rows are padded to GL_UNPACK_ALIGNMENT
  if (pixels.length < rowBytes * (height - 1) + width * n) return null;
  const rgba = new Uint8Array(width * height * 4), swap = pixelFormat === GL_BGR || pixelFormat === GL_BGRA;
  for (let y = 0, d = 0; y < height; y++) for (let x = 0, s = y * rowBytes; x < width; x++, s += n, d += 4) {
    if (n <= 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = n === 2 ? pixels[s + 1] : 255; }
    else { rgba[d] = pixels[s + (swap ? 2 : 0)]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + (swap ? 0 : 2)]; rgba[d + 3] = n === 4 ? pixels[s + 3] : 255; }
  }
  return { width, height, rgba };
}

function flipRows({ width, height, rgba }) {
  const out = new Uint8Array(rgba.length), row = width * 4;
  for (let y = 0; y < height; y++) out.set(rgba.subarray(y * row, y * row + row), (height - 1 - y) * row);
  return out;
}

/** RGBA8 (top row first) → JPEG, or PNG when a pixel is not opaque. */
function encode(width, height, rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  if (opaque) return { bytes: jpeg.encode({ data, width, height }, 90).data, mimeType: 'image/jpeg' };
  const png = new PNG({ width, height }); png.data = data;
  return { bytes: PNG.sync.write(png), mimeType: 'image/png' };
}

/**
 * An osg::Image as read by osgb-reader.js → { bytes, mimeType } for a glTF texture, or null when it cannot be carried
 * (an external file, or a format with no decoder here). `transcoded` is set when the pixels were re-encoded.
 */
export function osgbTexture(img) {
  if (!img) return null;
  if (img.file) {
    const f = img.file;
    if (f[0] === 0xFF && f[1] === 0xD8) return { bytes: f, mimeType: 'image/jpeg' };
    if (f[0] === 0x89 && f[1] === 0x50 && f[2] === 0x4E && f[3] === 0x47) return { bytes: f, mimeType: 'image/png' };
    const dds = decodeDds(f);
    return dds ? { ...encode(dds.width, dds.height, flipRows(dds)), transcoded: true } : null;
  }
  if (img.pixels && img.width > 0 && img.height > 0 && (img.depth ?? 1) <= 1) {
    const raw = decodeRaw(img);
    return raw ? { ...encode(raw.width, raw.height, flipRows(raw)), transcoded: true } : null;
  }
  return null;
}

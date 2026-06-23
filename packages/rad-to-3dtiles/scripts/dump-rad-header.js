#!/usr/bin/env node
/**
 * dump-rad-header.js — diagnostic tool for .rad files
 * Usage: node scripts/dump-rad-header.js <file.rad>
 */
import fs from 'fs';
import { inflateRawSync } from 'zlib';

const [,, radPath] = process.argv;
if (!radPath) { console.error('Usage: node dump-rad-header.js <file.rad>'); process.exit(1); }

function readMagic(buf, off=0) { return String.fromCharCode(buf[off],buf[off+1],buf[off+2],buf[off+3]); }
function readU32(buf, off) { return (buf[off]|(buf[off+1]<<8)|(buf[off+2]<<16)|(buf[off+3]<<24))>>>0; }
function pad8(n) { return Math.ceil(n/8)*8; }

const buf = fs.readFileSync(radPath);
if (readMagic(buf) !== 'RAD0') { console.error('Not a RAD file'); process.exit(1); }

const jsonLen    = readU32(buf, 4);
const payloadBase = pad8(8 + jsonLen);
const header     = JSON.parse(buf.slice(8, 8+jsonLen).toString('utf8'));

console.log('=== Root Header ===');
console.log(JSON.stringify({ ...header, chunks: `[${header.chunks?.length} items]` }, null, 2));
console.log(`payloadBase: ${payloadBase} (chunks start here)`);

if (!header.chunks?.length) { console.log('No chunks.'); process.exit(0); }

console.log('\n=== First 3 chunks ===');
for (let ci = 0; ci < Math.min(3, header.chunks.length); ci++) {
  const chunk = header.chunks[ci];
  const cs = payloadBase + chunk.offset;
  const magic = readMagic(buf, cs);
  if (magic !== 'RADC') { console.log(`chunk[${ci}]: bad magic "${magic}" at offset ${cs}`); continue; }

  const cJsonLen = readU32(buf, cs+4);
  const meta = JSON.parse(buf.slice(cs+8, cs+8+cJsonLen).toString('utf8'));
  const metaPadEnd = pad8(8+cJsonLen);
  const propDataStart = cs + metaPadEnd + 8;
  
  console.log(`\nchunk[${ci}] offset=${chunk.offset} bytes=${chunk.bytes}`);
  console.log(`  count=${meta.count} payloadBytes=${meta.payloadBytes}`);
  console.log('  properties:');
  for (const prop of (meta.properties ?? [])) {
    const data = buf.slice(propDataStart + prop.offset, propDataStart + prop.offset + prop.bytes);
    let note = '';
    try {
      const raw = inflateRawSync(data);
      const bps = (raw.length / meta.count).toFixed(1);
      if (['child_count','child_start'].includes(prop.property)) {
        const arr = prop.property === 'child_count'
          ? new Uint16Array(raw.buffer, raw.byteOffset, 4)
          : new Uint32Array(raw.buffer, raw.byteOffset, 4);
        note = `  first 4: [${[...arr].join(', ')}]`;
      }
      console.log(`    ${prop.property.padEnd(15)} ${prop.encoding.padEnd(14)} ${prop.bytes} bytes → ${raw.length} decompressed (${bps} B/splat)${note}`);
    } catch(e) {
      console.log(`    ${prop.property.padEnd(15)} ${prop.encoding.padEnd(14)} ${prop.bytes} bytes  [decompress failed: ${e.code}]`);
    }
  }
}

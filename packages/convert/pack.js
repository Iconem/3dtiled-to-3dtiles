/**
 * pack.js — package a 3D Tiles directory into the two single-file formats:
 *
 *   .3tz     ZIP (STORED entries, no compression) + a `@3dtilesIndex1@` random-access index.
 *            Spec: https://github.com/erikdahlstrom/3tz-specification (MAXAR_content_3tz).
 *   .3dtiles SQLite DB with a `media(key TEXT, content BLOB)` table.
 *            Spec: https://github.com/CesiumGS/3d-tiles/issues/727 (3D Tiles package format 1.0.0).
 *
 * Both are served back by packages/tile-server/3dtiles-self-contained.js.
 *
 *   packTileset(dir, outBase, ['3tz', '3dtiles'])  → the written paths
 *   (CLI: node scripts/pack-3dtiles.mjs <tilesetDir> <outBaseName>)
 *
 * Keys are relative POSIX paths (e.g. "tileset.json", "tiles/node_0.glb") with no leading slash,
 * matching how .3dtiles files have been produced historically (CesiumGS/3d-tiles-tools#149).
 */
import fs   from 'node:fs';
import fsp  from 'node:fs/promises';
import path from 'node:path';

// ── collect files ───────────────────────────────────────────────────────────────
export async function collect(dir, base = dir, out = []) {
  for (const name of await fsp.readdir(dir)) {
    const full = path.join(dir, name);
    const st = await fsp.stat(full);
    if (st.isDirectory()) await collect(full, base, out);
    else out.push({ key: path.relative(base, full).split(path.sep).join('/'), full });
  }
  return out;
}

// ── CRC32 (ZIP) ───────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

// ── .3tz writer (STORED entries + @3dtilesIndex1@) ───────────────────────────────
export async function write3tz(files, outPath) {
  // Read all contents; @3dtilesIndex1@ is appended as the final data entry.
  const entries = [];
  for (const f of files) entries.push({ key: f.key, data: await fsp.readFile(f.full) });

  // First pass: lay out local headers + data to learn each entry's local-header offset.
  // Index record (this handler's format): [uint16 pathLen][utf8 path][uint64 localHeaderOffset][uint32 dataLength]
  const localChunks = [];
  let offset = 0;
  const layout = (key, data) => {
    const nameBuf = Buffer.from(key, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);            // local file header sig
    lh.writeUInt16LE(20, 4);                     // version needed
    lh.writeUInt16LE(0, 6);                      // flags
    lh.writeUInt16LE(0, 8);                      // method 0 = STORED
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); // time/date
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(data.length, 18);           // compressed size (== size, STORED)
    lh.writeUInt32LE(data.length, 22);           // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                     // extra len
    const rec = { key, nameBuf, data, localOffset: offset, crc: crc32(data) };
    localChunks.push(lh, nameBuf, data);
    offset += 30 + nameBuf.length + data.length;
    return rec;
  };

  const recs = entries.map(e => layout(e.key, e.data));

  // Build the index over the data entries, then append it as its own STORED entry.
  const idxParts = [];
  for (const r of recs) {
    const p = Buffer.from(r.key, 'utf8');
    const head = Buffer.alloc(2); head.writeUInt16LE(p.length, 0);
    const tail = Buffer.alloc(12); tail.writeBigUInt64LE(BigInt(r.localOffset), 0); tail.writeUInt32LE(r.data.length, 8);
    idxParts.push(head, p, tail);
  }
  const idxData = Buffer.concat(idxParts);
  const idxRec = layout('@3dtilesIndex1@', idxData);
  const allRecs = [...recs, idxRec];

  // Central directory.
  const cdChunks = [];
  let cdSize = 0;
  for (const r of allRecs) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);            // central dir header sig
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(r.crc, 16);
    cd.writeUInt32LE(r.data.length, 20); cd.writeUInt32LE(r.data.length, 24);
    cd.writeUInt16LE(r.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(r.localOffset, 42);
    cdChunks.push(cd, r.nameBuf);
    cdSize += 46 + r.nameBuf.length;
  }
  const cdOffset = offset;

  // End of central directory.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(allRecs.length, 8); eocd.writeUInt16LE(allRecs.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  await fsp.writeFile(outPath, Buffer.concat([...localChunks, ...cdChunks, eocd]));
  console.log(`  → ${outPath}  (${allRecs.length} entries, ${(offset/1024).toFixed(0)} KB data)`);
}

// ── .3dtiles writer (SQLite media table via sql.js) ──────────────────────────────
export async function write3dtiles(files, outPath) {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE media (key TEXT PRIMARY KEY, content BLOB);');
  const stmt = db.prepare('INSERT INTO media (key, content) VALUES (?, ?)');
  for (const f of files) { stmt.run([f.key, new Uint8Array(await fsp.readFile(f.full))]); }
  stmt.free();
  await fsp.writeFile(outPath, Buffer.from(db.export()));
  db.close();
  console.log(`  → ${outPath}  (${files.length} rows)`);
}

/**
 * Pack a tileset folder into single files next to `outBase` (no extension). The export-report and
 * any previous package in the folder are left out.
 */
export async function packTileset(dir, outBase, formats = ['3tz', '3dtiles']) {
  const files = (await collect(path.resolve(dir))).filter((f) => f.key !== 'export-report.json' && !/\.(3tz|3dtiles)$/i.test(f.key));
  await fsp.mkdir(path.dirname(path.resolve(outBase)), { recursive: true });
  const written = [];
  if (formats.includes('3tz')) { await write3tz(files, path.resolve(outBase + '.3tz')); written.push(path.resolve(outBase + '.3tz')); }
  if (formats.includes('3dtiles')) { await write3dtiles(files, path.resolve(outBase + '.3dtiles')); written.push(path.resolve(outBase + '.3dtiles')); }
  return { files: files.length, written };
}

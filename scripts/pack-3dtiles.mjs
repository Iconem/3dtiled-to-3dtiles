#!/usr/bin/env node
/**
 * pack-3dtiles.mjs — package a 3D Tiles directory into .3tz and .3dtiles.
 * The writers live in packages/convert/pack.js (shared with `3dtiled export --pack` and POST /export).
 *
 *   node scripts/pack-3dtiles.mjs <tilesetDir> <outBaseName>
 *   → writes <outBaseName>.3tz and <outBaseName>.3dtiles
 */
import { packTileset } from '../packages/convert/pack.js';

const [, , tilesetDir, outBase] = process.argv;
if (!tilesetDir || !outBase) { console.error('Usage: node scripts/pack-3dtiles.mjs <tilesetDir> <outBaseName>'); process.exit(1); }
const r = await packTileset(tilesetDir, outBase);
console.log(`Packaged ${r.files} files → ${r.written.join(', ')}`);

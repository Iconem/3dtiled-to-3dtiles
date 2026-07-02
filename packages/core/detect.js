/**
 * 3dtiles-convert-core — input format detection. Sniffs a path (file or directory) → format id.
 * Cheap checks: index filenames for directory formats, magic bytes / extension for file formats.
 * Returns one of: 'rad' | 'sog' | 'lcc' | 'copc' | 'potree' | 'i3s' | null.
 */
import fs from 'fs/promises';
import path from 'path';

const exists = async p => !!(await fs.stat(p).catch(() => null));
const isDir  = async p => { const s = await fs.stat(p).catch(() => null); return s?.isDirectory(); };

/**
 * Detect format from a basename/URL alone (extension or index filename) — no filesystem access.
 * Used for remote inputs, where directory formats can't be recognised by stat-ing sibling files.
 * Returns a format id or null.
 */
export function detectFormatByName(name) {
  const l = name.toLowerCase().split('?')[0].split('#')[0];
  if (l.endsWith('.rad')) return 'rad';
  if (l.endsWith('.copc.laz') || l.endsWith('.copc') || l.endsWith('.laz') || l.endsWith('.las')) return 'copc';
  if (l.endsWith('.slpk')) return 'i3s';
  if (l.endsWith('metadata.json') || l.endsWith('cloud.js')) return 'potree';
  if (l.endsWith('lod-meta.json')) return 'sog';
  if (l.endsWith('.lcc')) return 'lcc';
  if (l.endsWith('3dscenelayer.json') || l.endsWith('3dscenelayer.json.gz')) return 'i3s';
  if (l.endsWith('.3tz') || l.endsWith('.3dtiles')) return 'package';
  if (l.endsWith('.3mx') || l.endsWith('.3mxb')) return 'threemx';
  return null;
}

export async function detectFormat(input) {
  const lower = input.toLowerCase();

  // ── file-based ──
  if (lower.endsWith('.rad')) return 'rad';
  if (lower.endsWith('.3tz') || lower.endsWith('.3dtiles')) return 'package';
  if (lower.endsWith('.copc.laz') || lower.endsWith('.copc')) return 'copc';
  if (lower.endsWith('.slpk')) return 'i3s';
  if (lower.endsWith('.laz') || lower.endsWith('.las')) {
    // COPC iff a "copc" VLR is present — sniff the header region cheaply.
    try { const fh = await fs.open(input, 'r'); const b = Buffer.alloc(8192); await fh.read(b, 0, 8192, 0); await fh.close();
      if (b.includes(Buffer.from('copc'))) return 'copc'; } catch {}
    return 'copc'; // best-effort: route LAS/LAZ to the copc converter
  }

  // ── directory- or index-file-based ──
  const dir = (await isDir(input)) ? input : path.dirname(input);
  const base = path.basename(input);
  if (base === 'lod-meta.json' || await exists(path.join(dir, 'lod-meta.json'))) return 'sog';
  if (await exists(path.join(dir, 'metadata.json')) && await exists(path.join(dir, 'octree.bin'))) return 'potree';
  if (await exists(path.join(dir, 'cloud.js'))) return 'potree';
  // I3S (extracted SLPK / REST mirror): Esri commonly gzips the layer doc → `.json.gz`.
  if (await exists(path.join(dir, '3dSceneLayer.json')) || await exists(path.join(dir, '3dSceneLayer.json.gz'))
      || await exists(path.join(dir, 'nodepages'))) return 'i3s';
  if (await exists(path.join(dir, 'index.bin')) && await exists(path.join(dir, 'data.bin'))) return 'lcc';
  // LCC meta file name is arbitrary (*.lcc)
  if (await isDir(input)) { const files = await fs.readdir(input).catch(() => []); if (files.some(f => f.toLowerCase().endsWith('.lcc'))) return 'lcc'; }
  // unbundled single-SOG chunk (meta.json + *.webp)
  if (await exists(path.join(dir, 'meta.json'))) { const files = await fs.readdir(dir).catch(() => []); if (files.some(f => f.toLowerCase().endsWith('.webp'))) return 'sog'; }

  return null;
}

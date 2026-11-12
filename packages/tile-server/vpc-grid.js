/**
 * vpc-grid.js — a national LiDAR campaign as a GRID, not as a list: the "grid VPC".
 *
 * A country's point cloud is published in tiles of a regular grid, and the tile's file name IS its place:
 * IGN's `LHD_FXX_0600_6833_PTS_C_LAMB93_IGN69.copc.laz` is the square kilometre whose north-west corner is
 * X 600 000, Y 6 833 000 in Lambert-93; swisstopo's `…_2671-1221` the one whose south-west corner is
 * E 2 671 000, N 1 221 000 in LV95. A STAC VPC over such a set repeats, 337 206 times for France, a URL, a
 * polygon, two boxes and a WKT that the grid already says: 557 MB of JSON, 30 MB gzipped in 563 files.
 *
 * The grid VPC says it once:
 *
 *   {
 *     "type": "3dtiled:GridVPC", "version": 1, "title": "…", "license": "…", "attribution": "…",
 *     "crs": "EPSG:2154",              the grid's CRS (and the `&crs=` of files that declare none)
 *     "unit": 1000,                    metres per unit of the indices in a name
 *     "cell": 1000,                    metres per side of a tile
 *     "anchor": "nw",                  the corner a name gives: "nw" (IGN) or "sw" (swisstopo)
 *     "url": "https://…/LHD_FXX_{x}_{y}_PTS_{v}_LAMB93_IGN69.copc.laz",   {x} {y} zero-padded to "pad", {v} a variant
 *     "pad": 4,
 *     "variants": ["C", "O"],          what {v} may be; a cell names one
 *     "x0": 99, "y0": 6050, "width": 1150, "height": 1070,
 *     "rows": ["....0011.0…", …],      one string per row from y0 upwards, one character per cell from x0:
 *                                      "." no tile, else the index of its variant (base 36)
 *     "z": { "min": […], "max": […] }, metres, per PRESENT cell in row order (optional; else "zRange": [lo, hi])
 *     "points": { "unit": 100000, "counts": […] },   per present cell (optional; else "pointsPerCell": n)
 *     "extra": [{ "url", "bbox": [x0, y0, z0, x1, y1, z1], "points" }]   files whose name is not of the grid
 *   }
 *
 * `rows` is the availability: which squares exist, and under which name. It is what a bare URL template
 * lacks — a campaign in progress has holes (the sea, the neighbours, the blocks not yet flown), and one
 * mirror names a square `_PTS_C_` or `_PTS_O_`, never both. All of France is 0.9 MB gzipped with exact
 * heights and counts, 40 KB without them. The server expands it in memory into the same entries a STAC VPC
 * gives (`parseGridVpc`), and /aggregate builds, cuts and serves the mosaic as for any other set.
 *
 * It is NOT a VPC that PDAL or QGIS open: `scripts/vpc-to-grid.mjs` writes one from a VPC, and the split
 * STAC VPCs remain for those readers.
 */
import { crsToEcef, ensureCrs } from '../core/index.js';

// ── the regular grids a tile name encodes ────────────────────────────────────────────────────────
//
// parse(name) → { x, y } in units of the grid, box(x, y) → [x0, y0, x1, y1] in metres of the grid's CRS,
// name(x, y) the file name of a cell. `unit`, `cell`, `anchor`, `pad` are what a grid VPC writes down.
export const GRIDS = {
  // IGN LiDAR HD: 1 km Lambert-93 tiles named by their NORTH-WEST corner in km (LHD_FXX_0600_6833 spans
  // X 600 000–601 000, Y 6 832 000–6 833 000). flai's mirror keeps IGN's names, plus 16 older
  // `LHD_C_LA93-IGN69_0932-6503_2021` ones, same convention. Verified on both forms' headers.
  'ign-lidarhd': {
    epsg: 2154, size: 1000, unit: 1000, cell: 1000, anchor: 'nw', pad: 4,
    parse: (name) => { const m = /LHD_(?:FXX_(\d{4})_(\d{4})|C_LA93-IGN69_(\d{4})-(\d{4}))/.exec(name); return m ? { x: +(m[1] ?? m[3]), y: +(m[2] ?? m[4]) } : null; },
    box: (x, y) => [x * 1000, (y - 1) * 1000, x * 1000 + 999.99, y * 1000 - 0.01],
    name: (x, y) => `LHD_FXX_${String(x).padStart(4, '0')}_${String(y).padStart(4, '0')}_PTS_C_LAMB93_IGN69`,
  },
  // swisstopo swissSURFACE3D: 1 km LV95 tiles named by their SOUTH-WEST corner in km
  // (swisssurface3d_2026_2671-1221 spans E 2 671 000–2 672 000, N 1 221 000–1 222 000). Verified on a header.
  'swisstopo': {
    epsg: 2056, size: 1000, unit: 1000, cell: 1000, anchor: 'sw', pad: 0,
    parse: (name) => { const m = /_(\d{4})-(\d{4})(?:_|\.|$)/.exec(name); return m ? { x: +m[1], y: +m[2] } : null; },
    box: (x, y) => [x * 1000, y * 1000, x * 1000 + 999.99, y * 1000 + 999.99],
    name: (x, y) => `swisssurface3d_${x}-${y}`,
  },
};

export const GRID_VPC_TYPE = '3dtiled:GridVPC';
const Z_CLAMP = [-1000, 9000];                     // metres: a header's noise points (IGN has ten tiles claiming ±1 000 km) do not size a tile
const ABSENT = '.';

export const isGridVpc = (doc) => doc?.type === GRID_VPC_TYPE;

/** The URL of cell (x, y) of variant `v` from a template. */
export function gridUrl(template, x, y, v = '', pad = 0) {
  return template.replace(/\{x\}/g, String(x).padStart(pad, '0')).replace(/\{y\}/g, String(y).padStart(pad, '0')).replace(/\{v\}/g, v);
}

/** A template → a RegExp over a file name or URL that captures what `{x}`, `{y}`, `{v}` stand for (named groups). */
export function templateRe(template) {
  const seen = new Set();
  const src = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(x|y|v)\}/g, (_, k) => {
    if (seen.has(k)) return `\\k<${k}>`;
    seen.add(k);
    return k === 'v' ? '(?<v>[^/]*?)' : `(?<${k}>\\d+)`;
  });
  return new RegExp(`^${src}$`);
}

/** The box [x0, y0, x1, y1] in metres of cell (x, y). */
export function cellBox(doc, x, y) {
  const unit = doc.unit ?? 1000, cell = doc.cell ?? unit;
  const x0 = x * unit, yRef = y * unit;
  return doc.anchor === 'nw' ? [x0, yRef - cell, x0 + cell, yRef] : [x0, yRef, x0 + cell, yRef + cell];
}

const bad = (msg) => Object.assign(new Error(`not a grid VPC: ${msg}`), { status: 422 });

/**
 * A grid VPC → the pieces of an /aggregate set, the shape vpc-live.js's `parseVpc` returns. Pure: no file
 * is opened. `boxBounds` is vpc-live's (a box in a CRS → `{ sphere, geometricError }`).
 */
export function parseGridVpc(doc, base, { boxBounds }) {
  if (doc.version !== 1) throw bad(`version ${doc.version} (this server reads version 1)`);
  if (typeof doc.url !== 'string' || !/\{x\}/.test(doc.url) || !/\{y\}/.test(doc.url)) throw bad('"url" must be a template with {x} and {y}');
  if (!Array.isArray(doc.rows) || !doc.rows.every((r) => typeof r === 'string')) throw bad('"rows" must be an array of strings');
  if (![doc.x0, doc.y0].every(Number.isInteger)) throw bad('"x0" and "y0" must be integers');
  if (typeof doc.crs !== 'string' || !ensureCrs(doc.crs, doc.wkt ?? null)) throw bad(`the CRS ${doc.crs} is not one this server reads (give "wkt")`);
  const toEcef = crsToEcef(doc.crs);
  if (!toEcef) throw bad(`the CRS ${doc.crs} does not project`);
  // a relative template resolves against the descriptor's own folder (braces must not go through URL())
  let template = doc.url;
  if (!/^https?:\/\//i.test(template)) {
    if (!base || !/^https?:\/\//i.test(base)) throw bad('a relative "url" template needs the descriptor to be read over http(s)');
    template = new URL('.', base).href + template.replace(/^\.\//, '');
  }
  const variants = Array.isArray(doc.variants) && doc.variants.length ? doc.variants.map(String) : [''];
  const pad = Number.isInteger(doc.pad) ? doc.pad : 0;
  const zMin = doc.z?.min, zMax = doc.z?.max, counts = doc.points?.counts, pUnit = doc.points?.unit ?? 1;
  const zRange = Array.isArray(doc.zRange) && doc.zRange.length === 2 ? doc.zRange : [0, 500];
  const entries = [];
  const entry = (url, box, points, from) => {
    const b = boxBounds(box, toEcef);
    if (!b) return;
    const e = { format: 'copc', url, name: decodeURIComponent(url.split(/[?#]/)[0].split('/').pop()), crs: doc.crs,
      ...(Number.isFinite(points) ? { points } : {}), bounds: { sphere: b.sphere, geometricError: b.geometricError } };
    Object.defineProperty(e, 'boundsFrom', { value: from, enumerable: false });
    entries.push(e);
  };
  let k = 0;
  for (let r = 0; r < doc.rows.length; r++) {
    const row = doc.rows[r], y = doc.y0 + r;
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ABSENT) continue;
      const v = variants[parseInt(ch, 36)];
      if (v === undefined) throw bad(`row ${r} names variant "${ch}", and there are ${variants.length}`);
      const [bx0, by0, bx1, by1] = cellBox(doc, doc.x0 + c, y);
      entry(gridUrl(template, doc.x0 + c, y, v, pad), [bx0, by0, zMin?.[k] ?? zRange[0], bx1, by1, zMax?.[k] ?? zRange[1]],
        counts ? counts[k] * pUnit : doc.pointsPerCell, 'grid');
      k++;
    }
  }
  if ((zMin && zMin.length !== k) || (zMax && zMax.length !== k) || (counts && counts.length !== k)) throw bad(`"z" / "points" must have one value per present cell (${k})`);
  for (const x of Array.isArray(doc.extra) ? doc.extra : []) {
    if (typeof x?.url === 'string' && Array.isArray(x.bbox) && x.bbox.length === 6) entry(x.url, x.bbox, x.points, 'grid:extra');
  }
  if (!entries.length) throw bad('no cell is present');
  const overview = typeof doc.overview === 'string' && /^https?:\/\//i.test(doc.overview) ? [doc.overview] : [];
  return { items: entries.length, entries, ambiguous: [], skipped: [], overviews: overview, nested: 0, label: doc.title ?? null };
}

/**
 * Cells → a grid VPC document. `cells`: [{ x, y, v?, z0?, z1?, count? }] (a cell given twice keeps the
 * first); `opts`: { crs, unit, cell, anchor, pad, url, title?, license?, attribution?, source?, overview?,
 * extra?, pointsUnit?, withStats? }. Pure.
 */
export function buildGridVpc(cells, opts) {
  const { pointsUnit = 100_000, withStats = true } = opts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const tally = new Map();
  for (const c of cells) {
    x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y);
    tally.set(c.v ?? '', (tally.get(c.v ?? '') ?? 0) + 1);
  }
  if (!Number.isFinite(x0)) throw new Error('no cell');
  const variants = [...tally].sort((a, b) => b[1] - a[1]).map(([v]) => v);   // the commonest first
  if (variants.length > 36) throw new Error(`${variants.length} variants: more than one character holds`);
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const grid = new Array(width * height).fill(null);
  let duplicates = 0;
  for (const c of cells) { const i = (c.y - y0) * width + (c.x - x0); if (grid[i]) duplicates++; else grid[i] = c; }
  const rows = [], zMin = [], zMax = [], counts = [];
  let points = 0;
  for (let r = 0; r < height; r++) {
    let s = '';
    for (let c = 0; c < width; c++) {
      const cellAt = grid[r * width + c];
      if (!cellAt) { s += ABSENT; continue; }
      s += variants.indexOf(cellAt.v ?? '').toString(36);
      zMin.push(Math.floor(Math.max(Z_CLAMP[0], Math.min(Z_CLAMP[1], cellAt.z0 ?? 0))));
      zMax.push(Math.ceil(Math.max(Z_CLAMP[0], Math.min(Z_CLAMP[1], cellAt.z1 ?? 0))));
      counts.push(Math.max(cellAt.count ? 1 : 0, Math.round((cellAt.count ?? 0) / pointsUnit)));
      points += cellAt.count ?? 0;
    }
    rows.push(s);
  }
  const present = zMin.length;
  const sorted = [...zMin].sort((a, b) => a - b), top = [...zMax].sort((a, b) => a - b);
  const doc = {
    type: GRID_VPC_TYPE, version: 1,
    ...(opts.title ? { title: opts.title } : {}), ...(opts.license ? { license: opts.license } : {}),
    ...(opts.attribution ? { attribution: opts.attribution } : {}), ...(opts.source ? { source: opts.source } : {}),
    crs: opts.crs, unit: opts.unit ?? 1000, cell: opts.cell ?? opts.unit ?? 1000, anchor: opts.anchor ?? 'sw',
    url: opts.url, pad: opts.pad ?? 0, variants,
    ...(opts.overview ? { overview: opts.overview } : {}),
    tiles: present + (opts.extra?.length ?? 0), 'pc:count': points,
    x0, y0, width, height,
    // what a cell without heights of its own is given: the 5th percentile of the lows and the 99th of the highs (2 % of
    // IGN's headers carry noise points a kilometre underground, which must not size every square of the country)
    zRange: [sorted[Math.floor(present * 0.05)], top[Math.min(present - 1, Math.floor(present * 0.99))]],
    pointsPerCell: Math.round(points / Math.max(1, present)),
    rows,
    ...(withStats ? { z: { min: zMin, max: zMax }, points: { unit: pointsUnit, counts } } : {}),
    ...(opts.extra?.length ? { extra: opts.extra } : {}),
  };
  return { doc, stats: { present, duplicates, variants: Object.fromEntries(tally), width, height, points } };
}

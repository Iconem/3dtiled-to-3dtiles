// debug-bing-coverage.mjs — probe Bing Maps 3D (tf=3dv4) mesh coverage by level at a lon/lat.
//   node scripts/debug-bing-coverage.mjs [lon] [lat] [maxLevel]
//   node scripts/debug-bing-coverage.mjs -0.1278 51.5074 20      # London
//
// Why: Bing's 3D mesh does not exist at low zoom — the td1 tree has tiles but no CONTENT until some
// depth, so a /bing tileset renders as empty space when zoomed out ("add a globe view" TODO). This
// prints the shallowest level that actually serves a GLB, which is what the globe shell has to span.
//
// Addressing: the td1 root's 4 children are the web-mercator quadrants, so a face-local (level,x,y)
// is the global mercator tile at (level+1). Bing indexes rows top-down via reverseY.
const BING_HOST = 't.ssl.ak.tiles.virtualearth.net';
const G = process.env.BING_G || '15530';
const api = (name) => `https://${BING_HOST}/tiles/${name}?g=${G}&cmt=cmpr3d&tf=3dv4&n=z&fallback=none`;

const lon = Number(process.argv[2] ?? -0.1278);
const lat = Number(process.argv[3] ?? 51.5074);
const maxLevel = Number(process.argv[4] ?? 20);

// standard slippy-map tile for lon/lat at zoom z (y is TOP-down, as OSM/Bing raster use)
function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

console.log(`Bing 3D coverage probe @ lon=${lon} lat=${lat}  (g=${G})\n`);
console.log('face-lvl  global-z   mtx name                       result');
console.log('-'.repeat(74));

let firstContent = null;
for (let faceLevel = 0; faceLevel <= maxLevel; faceLevel++) {
  const z = faceLevel + 1;                       // face-local level -> global mercator zoom
  const { x: gx, y: gyTop } = tileXY(lon, lat, z);
  // face = the level-1 quadrant containing this tile; face-local coords are the remainder
  const fx = gx >> (z - 1), fy = gyTop >> (z - 1);
  const face = fy * 2 + fx;                      // provisional; confirmed against td1 below
  const lx = gx - (fx << (z - 1)), lyTop = gyTop - (fy << (z - 1));
  const name = `mtx${face}-${faceLevel}-${lx}-${lyTop}`;   // Bing URIs are already reverseY (top-down)
  let result;
  try {
    const r = await fetch(api(name));
    if (!r.ok) result = `HTTP ${r.status}`;
    else {
      const b = Buffer.from(await r.arrayBuffer());
      const magic = b.toString('latin1', 0, 4);
      if (magic === 'glTF') { result = `GLB ${(b.length / 1024).toFixed(0)} KB`; firstContent ??= faceLevel; }
      else result = `no mesh (${b.length} B, magic="${magic.replace(/[^\x20-\x7e]/g, '.')}")`;
    }
  } catch (e) { result = `ERR ${e.message}`; }
  console.log(`${String(faceLevel).padStart(8)}  ${String(z).padStart(8)}   ${name.padEnd(30)} ${result}`);
}

console.log('-'.repeat(74));
console.log(firstContent == null
  ? 'No mesh content found at any probed level.'
  : `Shallowest level with Bing mesh content: ${firstContent} (face-local) / ${firstContent + 1} (global z).`);
console.log('Levels shallower than that are exactly the range the globe shell must cover.');

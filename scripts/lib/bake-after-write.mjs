/**
 * bake-after-write.mjs — run scripts/aggregate-bake-bounds.mjs on a manifest a script has just written,
 * so a regenerated manifest never ships entries without baked bounds.
 *
 * The bake keeps the bounds an entry already has and probes only the new ones. Potree and COPC entries
 * are probed through a running tile server's /stream (`--server=`, default http://localhost:3001); 3D
 * Tiles entries need no server. `--no-bake` on the calling script skips this step.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BAKE = fileURLToPath(new URL('../aggregate-bake-bounds.mjs', import.meta.url));

export async function bakeAfterWrite(file, argv = process.argv.slice(2)) {
  if (argv.includes('--no-bake')) { console.log('bounds not baked (--no-bake)'); return 0; }
  const server = (argv.find((a) => a.startsWith('--server=')) || '--server=http://localhost:3001').slice(9).replace(/\/$/, '');
  try { await fetch(`${server}/openapi.json`, { signal: AbortSignal.timeout(3000) }); }
  catch { console.warn(`no tile server at ${server}: Potree and COPC entries stay without bounds until the bake is re-run with one (--server=)`); }
  console.log(`\nbaking bounds → ${file}`);
  return spawnSync(process.execPath, [BAKE, file, `--server=${server}`], { stdio: 'inherit' }).status ?? 1;
}

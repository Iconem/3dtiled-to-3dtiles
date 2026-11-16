// GET /tilers and /tilers/files/<key>/…: the folder a tiler wrote is served as a static host would, and nothing else is.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handleTilers, outputKey } from './tilers-live.js';
import { RUN_MARKER } from '../tilers/index.js';

async function withServer(fn) {
  const server = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await handleTilers(req, res, u))) { res.writeHead(404); res.end('not handled'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('a tiler output folder is served; other folders, paths outside it and its record are not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilers-files-'));
  const out = path.join(dir, 'out é'), other = path.join(dir, 'other');
  fs.mkdirSync(path.join(out, 'data'), { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(path.join(out, RUN_MARKER), '{}');
  fs.writeFileSync(path.join(out, 'tileset.json'), '{"asset":{"version":"1.1"}}');
  fs.writeFileSync(path.join(out, 'data', '0.glb'), Buffer.from('glTF....'));
  fs.writeFileSync(path.join(other, 'tileset.json'), '{}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'no');
  const saved = process.env.TILED_ALLOW_EXPORT;
  try {
    await withServer(async (base) => {
      process.env.TILED_ALLOW_EXPORT = '1';
      const at = (d, rel) => `${base}/tilers/files/${outputKey(d)}/${rel}`;
      const ts = await fetch(at(out, 'tileset.json'));
      assert.equal(ts.status, 200); assert.equal(ts.headers.get('content-type'), 'application/json'); assert.equal(ts.headers.get('access-control-allow-origin'), '*');
      assert.equal((await ts.json()).asset.version, '1.1');
      const tile = await fetch(new URL('data/0.glb', at(out, 'tileset.json')));        // as a viewer resolves a tile next to the tileset
      assert.equal(tile.status, 200); assert.equal(tile.headers.get('content-type'), 'model/gltf-binary'); assert.equal((await tile.arrayBuffer()).byteLength, 8);
      assert.equal((await fetch(at(other, 'tileset.json'))).status, 404, 'a folder no tiler run finished in');
      assert.equal((await fetch(at(out, '..%2Fsecret.txt'))).status, 403, 'a path that leaves the folder');
      assert.equal((await fetch(at(out, RUN_MARKER))).status, 404, 'the run record itself');
      assert.equal((await fetch(at(out, 'data'))).status, 404, 'a folder is not a file');
      assert.equal((await fetch(`${base}/tilers/files/not-a-key`)).status, 404);

      const list = await (await fetch(`${base}/tilers?input=${encodeURIComponent(out)}`)).json();
      assert.ok(list.tools.length >= 12 && list.tools.every((t) => t.kind && t.found && Array.isArray(t.found.missing)));
      assert.deepEqual([list.input.dir, list.input.exts], [true, ['glb', 'json']]);
      assert.deepEqual(list.for, ['mago-3d-tiler'], 'a folder is matched by what it holds');

      process.env.TILED_ALLOW_EXPORT = '';
      assert.equal((await fetch(at(out, 'tileset.json'))).status, 403, 'off unless the server was started for it');
      assert.equal((await fetch(`${base}/tilers`)).status, 403);
    });
  } finally { if (saved === undefined) delete process.env.TILED_ALLOW_EXPORT; else process.env.TILED_ALLOW_EXPORT = saved; }
});

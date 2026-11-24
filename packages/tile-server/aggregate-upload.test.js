// Uploaded manifests outlive a restart (they are saved under AGGREGATE_CACHE_DIR), and an `unlisted`
// manifest in the sets directory opens by name but is never listed. Each "server" is a fresh Node
// process, so module state cannot carry anything over: only the file on disk can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE = pathToFileURL(fileURLToPath(new URL('./aggregate-live.js', import.meta.url))).href;

/** One request against a fresh process: { status, body }. */
function request(env, method, url, body = null) {
  const script = `
    import { handleAggregate } from ${JSON.stringify(MODULE)};
    const body = ${JSON.stringify(body)};
    const req = { method: ${JSON.stringify(method)}, headers: { host: 'test', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
    let status = 0, out = '';
    const res = { writeHead(s) { status = s; return res; }, setHeader() {}, write(c) { out += c; return true; }, end(c) { if (c) out += c; process.stdout.write(JSON.stringify({ status, body: out })); process.exit(0); } };
    await handleAggregate(req, res, new URL(${JSON.stringify(url)}, 'http://test'));
    setTimeout(() => { process.stdout.write(JSON.stringify({ status, body: out })); process.exit(0); }, 3000).unref();`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env }, timeout: 20000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`no answer: ${stdout}`)); }
    });
  });
}

test('an uploaded manifest survives a restart, and lives a week', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agg-upl-'));
  const env = { AGGREGATE_CACHE_DIR: dir, AGGREGATE_SETS_DIR: path.join(dir, 'sets') };
  try {
    const manifest = JSON.stringify({ label: 't', entries: [{ url: 'http://127.0.0.1:9/a/tileset.json', format: '3dtiles', name: 'a' }] });
    const up = await request(env, 'POST', '/aggregate/set', manifest);
    assert.equal(up.status, 201);
    const { set, expiresInS } = JSON.parse(up.body);
    assert.match(set, /^upload-[0-9a-f]{32}$/);
    assert.equal(expiresInS, 7 * 24 * 3600);
    const saved = JSON.parse(await readFile(path.join(dir, 'uploads.json'), 'utf8'));
    assert.ok(saved[set], 'saved to disk');

    // a second process: the upload is still there (whatever the unreachable child does next, it is not the 404)
    const again = await request(env, 'GET', `/aggregate/index.json?set=${set}`);
    assert.doesNotMatch(again.body, /no such uploaded manifest/);

    // older than a week: gone
    saved[set].at = Date.now() - 8 * 24 * 3600 * 1000;
    await writeFile(path.join(dir, 'uploads.json'), JSON.stringify(saved));
    const old = await request(env, 'GET', `/aggregate/index.json?set=${set}`);
    assert.equal(old.status, 404);
    assert.match(old.body, /no such uploaded manifest/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unlisted set opens by name and is never listed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agg-unl-'));
  const sets = path.join(dir, 'sets');
  const env = { AGGREGATE_CACHE_DIR: dir, AGGREGATE_SETS_DIR: sets };
  try {
    await import('node:fs/promises').then((fs) => fs.mkdir(sets));
    await writeFile(path.join(sets, 'secret-0123abcd.json'), JSON.stringify({ label: 's', unlisted: true, entries: [{ url: 'http://127.0.0.1:9/b/tileset.json', format: '3dtiles' }] }));
    const demo = await request(env, 'GET', '/aggregate/demo.json');
    assert.equal(demo.status, 200);
    assert.ok(!('secret-0123abcd' in JSON.parse(demo.body)));
    const wrong = await request(env, 'GET', '/aggregate/index.json?set=nope');
    assert.equal(wrong.status, 400);
    assert.doesNotMatch(wrong.body, /secret-0123abcd/);
    const right = await request(env, 'GET', '/aggregate/index.json?set=secret-0123abcd');
    assert.doesNotMatch(right.body, /unknown set/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

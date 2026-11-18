#!/usr/bin/env node
// The docs' screenshots live on a GitHub release of jo-chemla/3dtiled-to-3dtiles, not in git: every retake would add
// its full weight to the history for good. A tracked lock file names the archive the commit wants (content-addressed:
// screenshots-<sha256 prefix>.tar), and this script brings the folder in line with it. Same scheme as
// jo-chemla/blender_ogc3dtiles and jo-chemla/terrain-viewer.
//
//   folder   apps/docs/content/docs/guide/img   (git-ignored; the MDX pages import the pictures from it)
//   release  "Media: docs screenshots" (docs-media)
//   lock     apps/docs/media-screenshots.lock
//
//   node apps/docs/scripts/docs-media.mjs pull            download and unpack the archive when the folder is not at the lock
//   node apps/docs/scripts/docs-media.mjs pull --strict   same, and fail the process when it cannot (builds)
//   node apps/docs/scripts/docs-media.mjs push            pack the folder, upload it to the release (gh), rewrite the lock
//   node apps/docs/scripts/docs-media.mjs status          say whether the folder matches the lock
//
// `pull` runs before the docs dev server (lenient) and build (strict): package.json's predev and prebuild. After a
// retake: `push`, then commit the lock with the pages that use the pictures. Old archives stay on the release, so an
// older commit still builds. The pull is a public download, no login; the push needs `gh` with write access.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = 'content/docs/guide/img';          // relative to apps/docs, as the archive stores it
const DIR = join(DOCS, FOLDER);
const CACHE = join(DOCS, '.cache', 'docs-media');
const LOCK = join(DOCS, 'media-screenshots.lock');
const STAMP = join(DIR, '.media-sha');
const REPO = 'jo-chemla/3dtiled-to-3dtiles';
const TAG = 'docs-media', TITLE = 'Media: docs screenshots';
const NOTES = 'The screenshots of the docs site, as content-addressed tar archives (screenshots-<sha256 prefix>.tar). apps/docs/media-screenshots.lock in the repository names the one a commit uses; apps/docs/scripts/docs-media.mjs pulls and pushes them. Older archives stay so older commits still build.';

const mode = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'pull';
const strict = process.argv.includes('--strict');

const sha256 = (file) => new Promise((ok, ko) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', ko);
});
const readLock = async () => (existsSync(LOCK) ? JSON.parse(await readFile(LOCK, 'utf8')) : null);
const readStamp = async () => (existsSync(STAMP) ? (await readFile(STAMP, 'utf8')).trim() : null);
async function files() {
  if (!existsSync(DIR)) return [];
  const found = [];
  const walk = async (sub) => {
    for (const e of await readdir(join(DIR, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (rel !== '.media-sha') found.push(rel);
    }
  };
  await walk('');
  return found.sort();
}
// relative paths and a cwd: GNU tar (Git Bash) reads "C:\..." as a remote host
const tar = (args) => execFileSync('tar', args, { cwd: DOCS, stdio: ['ignore', 'inherit', 'inherit'] });

async function pull() {
  const lock = await readLock();
  if (!lock) { console.log('docs-media: no media-screenshots.lock, nothing to pull'); return; }
  if ((await readStamp()) === lock.sha256) { console.log(`docs-media: screenshots at ${lock.sha256.slice(0, 12)} (${lock.files} files), up to date`); return; }
  await mkdir(CACHE, { recursive: true });
  const archive = join(CACHE, lock.asset);
  if (!existsSync(archive) || (await sha256(archive)) !== lock.sha256) {
    const url = `https://github.com/${REPO}/releases/download/${lock.release}/${lock.asset}`;
    console.log(`docs-media: downloading ${lock.asset} (${(lock.size / 1e6).toFixed(1)} MB) from the ${lock.release} release`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
    const got = await sha256(archive);
    if (got !== lock.sha256) { await rm(archive, { force: true }); throw new Error(`checksum mismatch for ${lock.asset}: ${got}`); }
  }
  // a clean folder: a retake may have removed a picture
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  tar(['-xf', `.cache/docs-media/${lock.asset}`]);
  await writeFile(STAMP, lock.sha256 + '\n');
  console.log(`docs-media: unpacked ${lock.files} files into apps/docs/${FOLDER}`);
}

async function push() {
  const list = await files();
  if (!list.length) throw new Error(`apps/docs/${FOLDER} holds no file to pack`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, 'files.txt'), list.map((f) => `${FOLDER}/${f}`).join('\n') + '\n');
  const tmp = join(CACHE, 'new.tar');
  await rm(tmp, { force: true });
  // sorted names; an archive whose hash is the lock's is not uploaded again
  tar(['-cf', '.cache/docs-media/new.tar', '--format=ustar', '-T', '.cache/docs-media/files.txt']);
  const sha = await sha256(tmp);
  const lock = await readLock();
  if (lock?.sha256 === sha) { await writeFile(STAMP, sha + '\n'); console.log('docs-media: screenshots unchanged since the lock'); return; }
  const asset = `screenshots-${sha.slice(0, 12)}.tar`;
  const archive = join(CACHE, asset);
  await rm(archive, { force: true });
  await rename(tmp, archive);
  const gh = (a) => execFileSync('gh', a, { cwd: DOCS, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  try { gh(['release', 'view', TAG, '-R', REPO, '--json', 'tagName']); } catch {
    gh(['release', 'create', TAG, '-R', REPO, '--prerelease', '--latest=false', '--title', TITLE, '--notes', NOTES]);
  }
  gh(['release', 'upload', TAG, archive, '-R', REPO, '--clobber']);
  const size = (await stat(archive)).size;
  await writeFile(LOCK, JSON.stringify({ release: TAG, asset, sha256: sha, size, files: list.length, pushed: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  await writeFile(STAMP, sha + '\n');
  console.log(`docs-media: uploaded ${asset} (${(size / 1e6).toFixed(1)} MB, ${list.length} files); commit apps/docs/media-screenshots.lock`);
}

async function status() {
  const lock = await readLock(), at = await readStamp();
  const where = lock ? `lock ${lock.asset} (${lock.files} files, ${(lock.size / 1e6).toFixed(1)} MB, pushed ${lock.pushed})` : 'no lock';
  const state = at ? `folder at ${at.slice(0, 12)}${lock && at === lock.sha256 ? ', matches' : ', DIFFERS from the lock'}` : existsSync(DIR) ? 'folder present, never stamped' : 'folder missing';
  console.log(`screenshots: ${where}; ${state}`);
}

try {
  if (mode === 'pull') await pull();
  else if (mode === 'push') await push();
  else if (mode === 'status') await status();
  else throw new Error(`unknown mode "${mode}" (pull, push, status)`);
} catch (e) {
  // a dev server without network should still start, with missing or stale pictures
  if (mode === 'pull' && !strict) console.warn(`docs-media: ${e.message} - continuing without the current screenshots`);
  else { console.error(`docs-media: ${e.message}`); process.exit(1); }
}

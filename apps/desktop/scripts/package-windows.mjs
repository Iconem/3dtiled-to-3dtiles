#!/usr/bin/env node
/**
 * Turns a Windows `hutch electrobun build --env=stable` into the two files a user downloads, in artifacts/:
 *
 *   Setup.exe     One self-contained installer. Hutch's zip holds Setup.exe plus a hidden .installer folder,
 *                 and the exe fails on its own ("the installer package is incomplete"). The extractor also
 *                 reads a payload embedded in the exe, laid out as:
 *                 exe ++ "ELECTROBUN_METADATA_V1" ++ metadata.json ++ "ELECTROBUN_ARCHIVE_V1" ++ archive
 *   Portable.zip  The installed layout, which runs from any folder. build/.../3DTiled/bin/launcher.exe is NOT
 *                 the app: it is the installer stub, and Resources holds the real app as one .tar.zst.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const build = path.join(desktop, 'build', 'stable-win-x64');
const artifacts = path.join(desktop, 'artifacts');
const portable = path.join(desktop, 'build', 'portable');
const tar = 'C:\\Windows\\System32\\tar.exe';   // Git Bash's reads a C:\ path as a remote host

const setup = path.join(build, '3DTiled-Setup');
const out = fs.createWriteStream(path.join(artifacts, 'Setup.exe'));
for (const part of [`${setup}.exe`, 'ELECTROBUN_METADATA_V1', `${setup}.metadata.json`, 'ELECTROBUN_ARCHIVE_V1', `${setup}.tar.zst`]) {
  if (part.startsWith('ELECTROBUN_')) out.write(part);
  else await pipeline(fs.createReadStream(part), out, { end: false });
}
await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
fs.rmSync(path.join(artifacts, 'win-x64-3DTiled-Setup.zip'), { force: true });

fs.rmSync(portable, { recursive: true, force: true });
fs.mkdirSync(portable, { recursive: true });
const payload = path.join(portable, 'payload.tar');
const packed = fs.readdirSync(path.join(build, '3DTiled', 'Resources')).find((f) => f.endsWith('.tar.zst'));
await pipeline(fs.createReadStream(path.join(build, '3DTiled', 'Resources', packed)), zlib.createZstdDecompress(), fs.createWriteStream(payload));
execFileSync(tar, ['-xf', payload, '-C', portable], { stdio: 'inherit' });
fs.rmSync(payload);
const app = path.join(portable, fs.readdirSync(portable)[0]);
if (!fs.existsSync(path.join(app, 'bin', 'launcher.exe'))) throw new Error(`no launcher in ${app}`);
// The launcher finds Resources through ../Resources, so it stays in bin/ and a starter sits at the top.
fs.writeFileSync(path.join(app, '3DTiled.cmd'), '@echo off\r\nstart "" "%~dp0bin\\launcher.exe" %*\r\n');
// apps/desktop/src/bun/index.ts leaves the updater off when it sees this file.
fs.writeFileSync(path.join(app, 'portable.txt'), '3D Tiled, portable: no installation. Start it with "3DTiled.cmd". It does not update itself: download a newer zip.\r\n');
const zip = path.join(artifacts, 'Portable.zip');
fs.rmSync(zip, { force: true });
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', portable, path.basename(app)], { stdio: 'inherit' });
for (const f of ['Setup.exe', 'Portable.zip']) console.log(`[package-windows] ${f}: ${(fs.statSync(path.join(artifacts, f)).size / 1e6).toFixed(0)} MB`);

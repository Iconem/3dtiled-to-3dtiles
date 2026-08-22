// cdp-screenshot.mjs — headless-Chrome screenshot with a REAL readiness wait (no virtual time):
//   node scripts/cdp-screenshot.mjs <url> <out.png> [--wait-expr '<js expr, truthy when ready>']
//        [--width 1440] [--height 900] [--settle 1500] [--timeout 120000] [--eval '<js run after load>']
// Drives Chrome over the DevTools Protocol using Node's native WebSocket — no puppeteer dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const url = args[0], out = args[1];
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const width = Number(opt('width', 1440)), height = Number(opt('height', 900));
const waitExpr = opt('wait-expr', 'true');
const settle = Number(opt('settle', 1500));
const timeout = Number(opt('timeout', 120000));
const evalAfter = opt('eval', null);
if (!url || !out) { console.error('usage: cdp-screenshot.mjs <url> <out.png> [--wait-expr …]'); process.exit(1); }

const CHROME = await (async () => {
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  throw new Error('no chrome/edge found');
})();

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cdp-shot-'));
const chrome = spawn(CHROME, [
  `--headless=new`, `--remote-debugging-port=0`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, `--hide-scrollbars`, `--disable-gpu`, `--no-first-run`,
  `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let port = 0;
chrome.stderr.on('data', (d) => { const m = String(d).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) port = Number(m[1]); });
const t0 = Date.now();
while (!port) { if (Date.now() - t0 > 20000) throw new Error('chrome devtools port not found'); await new Promise(r => setTimeout(r, 200)); }

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
// wait for readiness expression
const t1 = Date.now();
for (;;) {
  if (Date.now() - t1 > timeout) { console.error(`TIMEOUT waiting for: ${waitExpr} — capturing anyway`); break; }
  const v = await evalJs(`(() => { try { return !!(${waitExpr}); } catch { return false; } })()`);
  if (v) break;
  await new Promise(r => setTimeout(r, 700));
}
if (evalAfter) await evalJs(evalAfter);
await new Promise(r => setTimeout(r, settle));
const shot = await send('Page.captureScreenshot', { format: 'png' });
await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'));
console.log(`written ${out}`);
ws.close(); chrome.kill();
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);

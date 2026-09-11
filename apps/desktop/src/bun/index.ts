/**
 * 3D Tiled — desktop companion (Electrobun main process).
 *
 * WHAT THIS IS. The "run the middleware on-device" app: it starts `packages/tile-server` locally,
 * waits until it actually answers, and opens a launcher window that turns a dataset on your disk (or
 * a remote URL) into a paste-ready 3D Tiles URL — the thing you hand to Cesium for Unreal/Unity, QGIS
 * or CesiumJS. Nothing is uploaded; conversion is on-the-fly (`/stream`) or cached to the local disk
 * cache (`/convert`), exactly as the CLI's `3dtiled serve` does. This is that workflow with a window.
 *
 * WHY ELECTROBUN, NOT ELECTRON/TAURI. Tauri needs a Rust + MSVC toolchain this repo otherwise has no
 * use for; Electron would add a ~200 MB dependency to a monorepo whose CI installs it on every build.
 * Electrobun ships a small native host (Hutch/Cottontail) with official Windows 11 / macOS 14 /
 * Ubuntu 24.04 support and pulls its toolchain into `.hutch/` (gitignored), so the repo stays clean.
 *
 * PROCESS MODEL. Two Node children, both reusing scripts already in this repo rather than
 * reimplementing anything:
 *   1. packages/tile-server/server.js — the middleware itself.
 *   2. scripts/static-server.mjs over scripts/ — serves `cesium-harness.html`, so the 3D preview is
 *      a plain http:// page. That deliberately avoids routing the preview through a `views://` URL,
 *      whose query-string handling is not something this app should depend on.
 * If a 3dtiled server is already listening on a candidate port (e.g. you have `pnpm dev` running),
 * we ADOPT it instead of starting a second copy, and leave it running on quit.
 */
import { BrowserWindow } from "electrobun/main";

const TILE_PORTS = [3001, 3031, 3032, 3033];
const STATIC_PORTS = [3041, 3042, 3043];

// Cottontail exposes Bun-style spawn; node:child_process is the fallback so this keeps working if the
// main process is switched to the Bun runtime (electrobun.config.ts `build.mainProcess`).
async function spawnDetached(cmd: string[], cwd: string): Promise<{ kill: () => void }> {
	const anyGlobal = globalThis as any;
	if (anyGlobal.Bun?.spawn) {
		const p = anyGlobal.Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
		return { kill: () => { try { p.kill(); } catch { /* already gone */ } } };
	}
	const { spawn } = await import("node:child_process");
	const p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
	return { kill: () => { try { p.kill(); } catch { /* already gone */ } } };
}

/**
 * Locate the repo root by walking up from cwd looking for the server we intend to run.
 *
 * Guessing a fixed depth does not work: `hutch electrobun dev` runs with cwd = apps/desktop, while
 * the built app runs from build/<target>/3DTiled-dev/bin — six levels down and a completely
 * different shape. Probing for the marker file handles both, and any future layout change, without
 * a second code path.
 */
async function repoRoot(): Promise<string> {
	const { existsSync } = await import("node:fs");
	let dir = (globalThis as any).process?.cwd?.() ?? ".";
	for (let i = 0; i < 10; i++) {
		if (existsSync(`${dir}/packages/tile-server/server.js`)) return dir;
		const parent = dir.replace(/[\\/][^\\/]+[\\/]*$/, "");
		if (!parent || parent === dir) break;
		dir = parent;
	}
	return (globalThis as any).process?.cwd?.() ?? ".";
}

/** Is a 3dtiled tile-server answering here? `/openapi.json` is the cheapest unambiguous probe. */
async function probeTileServer(port: number): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(1500) });
		if (!r.ok) return false;
		const j: any = await r.json();
		return typeof j?.info?.title === "string" && j.info.title.includes("3dtiled");
	} catch { return false; }
}

async function probeAny(port: number): Promise<boolean> {
	try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return true; }
	catch { return false; }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await check()) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

const children: { kill: () => void }[] = [];

/**
 * Bring up a server on the first workable port. The tile-server imports a heavy ESM graph and takes
 * ~15 s to bind on a cold start, which is why the wait window is generous — a short timeout here
 * reads as "crashed" when it is merely still loading.
 */
async function ensureServer(opts: {
	ports: number[]; cmd: (port: number) => string[]; cwd: string;
	ready: (port: number) => Promise<boolean>; timeoutMs: number;
}): Promise<number | null> {
	for (const port of opts.ports) {
		if (await opts.ready(port)) return port;                 // adopt an already-running instance
		if (await probeAny(port)) continue;                      // something else owns this port
		children.push(await spawnDetached(opts.cmd(port), opts.cwd));
		if (await waitFor(() => opts.ready(port), opts.timeoutMs)) return port;
	}
	return null;
}

const root = await repoRoot();

const tilePort = await ensureServer({
	ports: TILE_PORTS,
	cmd: (p) => ["node", "packages/tile-server/server.js", "--port", String(p)],
	cwd: root,
	ready: probeTileServer,
	timeoutMs: 45_000,
});

const staticPort = await ensureServer({
	ports: STATIC_PORTS,
	cmd: (p) => ["node", "scripts/static-server.mjs", String(p), "scripts"],
	cwd: root,
	ready: async (p) => {
		try {
			const r = await fetch(`http://127.0.0.1:${p}/cesium-harness.html`, { signal: AbortSignal.timeout(1500) });
			return r.ok;
		} catch { return false; }
	},
	timeoutMs: 15_000,
});

// The launcher is a bundled view; the ports travel in the query string so the UI needs no RPC round
// trip just to learn where the servers ended up.
const qs = `?tilePort=${tilePort ?? ""}&staticPort=${staticPort ?? ""}`;
const mainWindow = new BrowserWindow({
	title: "3D Tiled — local middleware",
	url: `views://mainview/index.html${qs}`,
	frame: { width: 1040, height: 880, x: 120, y: 60 },
});

console.log(`[3dtiled-desktop] tile-server=${tilePort ?? "FAILED"} static=${staticPort ?? "FAILED"} root=${root}`);

for (const sig of ["SIGINT", "SIGTERM", "exit"]) {
	try { (globalThis as any).process?.on?.(sig, () => children.forEach((c) => c.kill())); } catch { /* no process object */ }
}

export { mainWindow };

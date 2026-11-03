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
import Electrobun, { BrowserWindow, Updater, Utils, defineElectrobunRPC } from "electrobun/main";
import type { DesktopRPC } from "../shared/rpc-schema";
import { createCliRunner, defaultSpawn } from "./cli-runner";

const TILE_PORTS = [3001, 3031, 3032, 3033];
const STATIC_PORTS = [3041, 3042, 3043];

/**
 * Where the companion app sends you for the web viewer and the docs.
 *
 * Resolution is local-first: an explicit env var wins, then a locally-running `pnpm dev` instance,
 * then the public deployment. That ordering matters — a developer with the stack running should get
 * THEIR build, not production, while a plain user who installed only this app still gets working
 * links instead of a dead localhost URL.
 *
 * These are the project's own public deployments, and the only place in the desktop app where a
 * domain is written down; everything a third party self-hosts (the server, viewer and docs images)
 * builds its links from DOCS_URL/VIEWER_URL env vars instead. Override with the same env vars here.
 */
const LOCAL_VIEWER = 'http://127.0.0.1:3000';
const LOCAL_DOCS = 'http://127.0.0.1:3002/docs';
const PUBLIC_VIEWER = 'https://demo.3dtiled.iconem.com';
const PUBLIC_DOCS = 'https://docs.3dtiled.iconem.com';

// Cottontail exposes Bun-style spawn; node:child_process is the fallback so this keeps working if the
// main process is switched to the Bun runtime (electrobun.config.ts `build.mainProcess`).
async function spawnDetached(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ kill: () => void }> {
	const anyGlobal = globalThis as any;
	const env = { ...(anyGlobal.process?.env ?? {}), ...extraEnv };
	if (anyGlobal.Bun?.spawn) {
		const p = anyGlobal.Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit", windowsHide: true });
		return { kill: () => { try { p.kill(); } catch { /* already gone */ } } };
	}
	const { spawn } = await import("node:child_process");
	const p = spawn(cmd[0], cmd.slice(1), { cwd, env, stdio: "inherit", windowsHide: true });
	return { kill: () => { try { p.kill(); } catch { /* already gone */ } } };
}

/**
 * Locate the server by walking up from cwd and from the executable, looking for the file we intend to run.
 *
 * Guessing a fixed depth does not work: `hutch electrobun dev` runs with cwd = apps/desktop, while
 * the built app runs from build/<target>/3DTiled-dev/bin — six levels down and a completely
 * different shape. Probing for the marker file handles both, and any future layout change, without
 * a second code path.
 *
 * A distributable carries its own copy and Node (scripts/prepare-bundle.mjs) under Resources/app, which
 * wins over a repo further up, so that what runs is what ships.
 */
async function locateServer(): Promise<{ root: string; node: string; bundled: boolean }> {
	const { existsSync } = await import("node:fs");
	const proc = (globalThis as any).process;
	const starts: string[] = [proc?.cwd?.() ?? ".", ...(proc?.execPath ? [proc.execPath] : [])];
	const up = (dir: string) => dir.replace(/[\\/][^\\/]+[\\/]*$/, "");
	const walk = (found: (dir: string) => string | null) => {
		for (const start of starts) {
			let dir = start;
			for (let i = 0; i < 10; i++) {
				const hit = found(dir);
				if (hit) return hit;
				const parent = up(dir);
				if (!parent || parent === dir) break;
				dir = parent;
			}
		}
		return null;
	};
	const bundled = walk((d) => (existsSync(`${d}/Resources/app/3dtiled/packages/tile-server/server.js`) ? `${d}/Resources/app/3dtiled` : null));
	if (bundled) {
		const exe = `${bundled}/runtime/node${proc?.platform === "win32" ? ".exe" : ""}`;
		return { root: bundled, node: existsSync(exe) ? exe : "node", bundled: true };
	}
	const repo = walk((d) => (existsSync(`${d}/packages/tile-server/server.js`) ? d : null));
	return { root: repo ?? proc?.cwd?.() ?? ".", node: "node", bundled: false };
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
	env?: Record<string, string>;
}): Promise<number | null> {
	for (const port of opts.ports) {
		if (await opts.ready(port)) return port;                 // adopt an already-running instance
		if (await probeAny(port)) continue;                      // something else owns this port
		children.push(await spawnDetached(opts.cmd(port), opts.cwd, opts.env));
		if (await waitFor(() => opts.ready(port), opts.timeoutMs)) return port;
	}
	return null;
}

const { root, node, bundled } = await locateServer();

// A distributable's folder is replaced on every update: what the user adds or caches lives per user.
const userData = bundled && (globalThis as any).process?.env?.LOCALAPPDATA;
const userDirs: Record<string, string> = userData
	? { AGGREGATE_CACHE_DIR: `${userData}/3D Tiled/aggregate-cache`, AGGREGATE_SETS_DIR: `${userData}/3D Tiled/aggregate-sets` }
	: {};

const tilePort = await ensureServer({
	ports: TILE_PORTS,
	cmd: (p) => [node, "packages/tile-server/server.js", "--port", String(p)],
	cwd: root,
	ready: probeTileServer,
	timeoutMs: 45_000,
	// "Export to folder" writes to this machine's disk, so the server only enables it when asked; the
	// app is exactly the place that asks. (An ADOPTED dev server keeps whatever it was started with.)
	env: { TILED_ALLOW_EXPORT: "1", HOST: "127.0.0.1", ...userDirs },
});

const staticPort = await ensureServer({
	ports: STATIC_PORTS,
	cmd: (p) => [node, "scripts/static-server.mjs", String(p), "scripts"],
	cwd: root,
	ready: async (p) => {
		try {
			const r = await fetch(`http://127.0.0.1:${p}/cesium-harness.html`, { signal: AbortSignal.timeout(1500) });
			return r.ok;
		} catch { return false; }
	},
	timeoutMs: 15_000,
	env: { HOST: "127.0.0.1" },
});

/** Is something answering here at all? Used to prefer a local viewer/docs over the public one. */
async function reachable(url: string): Promise<boolean> {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(1200) });
		return r.ok;
	} catch { return false; }
}

const env = (globalThis as any).process?.env ?? {};
const viewerUrl = env.VIEWER_URL || (await reachable(LOCAL_VIEWER) ? LOCAL_VIEWER : PUBLIC_VIEWER);
const docsUrl = env.DOCS_URL || (await reachable(LOCAL_DOCS) ? LOCAL_DOCS : PUBLIC_DOCS);

// The launcher is a bundled view; the ports and resolved URLs travel in the query string so the UI
// needs no RPC round trip just to learn where things ended up.
const qs = `?tilePort=${tilePort ?? ""}&staticPort=${staticPort ?? ""}`
	+ `&viewerUrl=${encodeURIComponent(viewerUrl)}&docsUrl=${encodeURIComponent(docsUrl)}`;
/**
 * Native file/folder picker, exposed to the launcher view over RPC.
 *
 * It has to live in the main process: a webview `<input type=file>` yields a sandboxed File object
 * with no real path, and the middleware needs an actual filesystem path to hand to an adapter. The
 * OS dialog is the only way to get one.
 */
/** Window bounds, and the ceiling we will not grow past. */
const WIN = { x: 100, y: 40, width: 1120, height: 940, maxWidth: 1600, maxHeight: 1200 };

/**
 * "Export → Run in: CLI subprocess": the same `packages/convert/cli.js` the card shows, as an isolated
 * child of THIS process (not of the tile-server), so a crash or memory blow-up in a large conversion
 * cannot take the middleware down. Only the two allow-listed scripts can be run — see cli-runner.ts.
 */
const cli = createCliRunner({ spawn: await defaultSpawn(), cwd: root, node });
children.push({ kill: () => cli.killAll() });

// The library outlives the app's folder, which every update replaces, and is shared by a portable copy.
const libraryDir = env.LOCALAPPDATA ? `${env.LOCALAPPDATA}/3D Tiled` : `${env.HOME ?? "."}/.3dtiled`;
const libraryFile = `${libraryDir}/library.json`;

const rpc = defineElectrobunRPC<DesktopRPC, "bun">("bun", {
	handlers: {
		requests: {
			pickDataset: ({ directory, allowedFileTypes }) =>
				Utils.openFileDialog({
					canChooseFiles: !directory,
					canChooseDirectory: directory,
					allowsMultipleSelection: false,
					allowedFileTypes: allowedFileTypes || "*",
				}),

			/**
			 * Grow the window toward the content size.
			 *
			 * CSS px → frame px comes from the ratio the host can actually OBSERVE (the frame it asked
			 * for vs the viewport the view reports), not from devicePixelRatio, which reports 1 under
			 * Windows DPI virtualization — see the note on the RPC schema.
			 *
			 * One-directional on purpose: never shrink below the default, so switching from the long
			 * Samples tab back to the short Build tab does not collapse a window the user is using,
			 * and an under-estimate can never clip content. Capped so a 30-row catalogue cannot open a
			 * window taller than the screen.
			 */
			openFolder: ({ path }) => Utils.openPath(path),

			runCli: ({ args, then }) => ({ id: cli.run(then ? [args, then] : [args]) }),
			cliStatus: ({ id }) => cli.status(id),
			cancelCli: ({ id }) => cli.cancel(id),

			readLibrary: async () => {
				const { readFile } = await import("node:fs/promises");
				return readFile(libraryFile, "utf8").catch(() => null);
			},
			writeLibrary: async ({ json }) => {
				const { mkdir, rename, writeFile } = await import("node:fs/promises");
				await mkdir(libraryDir, { recursive: true });
				await writeFile(`${libraryFile}.tmp`, json);
				await rename(`${libraryFile}.tmp`, libraryFile);   // a crash mid-write leaves the previous file
				return true;
			},

			updateStatus: () => ({ version: updateVersion }),
			applyUpdate: async () => {
				stopChildren();   // the bundled node.exe is locked for as long as it runs
				await Updater.applyUpdate();
				return true;
			},

			fitWindow: ({ cssWidth, cssHeight, viewportWidth, viewportHeight }) => {
				const sx = viewportWidth > 0 ? WIN.width / viewportWidth : 1;
				const sy = viewportHeight > 0 ? WIN.height / viewportHeight : 1;
				const width = Math.min(WIN.maxWidth, Math.max(WIN.width, Math.ceil(cssWidth * sx)));
				const height = Math.min(WIN.maxHeight, Math.max(WIN.height, Math.ceil(cssHeight * sy)));
				mainWindow.setSize(width, height);
				return { width, height };
			},
		},
	},
});

const mainWindow = new BrowserWindow({
	title: "3D Tiled — local middleware",
	url: `views://mainview/index.html${qs}`,
	frame: { width: WIN.width, height: WIN.height, x: WIN.x, y: WIN.y },
	rpc,
});

console.log(`[3dtiled-desktop] tile-server=${tilePort ?? "FAILED"} static=${staticPort ?? "FAILED"} `
	+ `viewer=${viewerUrl} docs=${docsUrl} root=${root} node=${node}`);

const stopChildren = () => children.forEach((c) => c.kill());
for (const sig of ["SIGINT", "SIGTERM", "exit"]) {
	try { (globalThis as any).process?.on?.(sig, stopChildren); } catch { /* no process object */ }
}
// Closing the window quits without a process "exit" event, which left the servers running.
Electrobun.events.on("before-quit", stopChildren);

/**
 * Download a newer build in the background; the launcher offers to restart into it. Never restarts by
 * itself, as a conversion may be running. Not in a portable copy (package-windows.mjs leaves portable.txt
 * beside bin/): the updater only knows the installed folder.
 */
let updateVersion: string | null = null;
async function checkForUpdate() {
	const { existsSync } = await import("node:fs");
	const app = (globalThis as any).process?.execPath?.replace(/[\\/]bin[\\/][^\\/]+$/, "");
	if (!bundled || !app || existsSync(`${app}/portable.txt`)) return;
	try {
		const local = await Updater.getLocalInfo();
		if (!local.baseUrl || local.channel === "dev") return;
		const info = await Updater.checkForUpdate();
		if (info.error || !(info.updateAvailable || info.updateReady)) return;
		if (!info.updateReady) await Updater.downloadUpdate();
		if (Updater.updateInfo().updateReady) updateVersion = info.version ?? "";
	} catch (e) {
		console.warn("[3dtiled-desktop] update check failed:", e);
	}
}
setTimeout(() => { void checkForUpdate(); }, 4000);

export { mainWindow };

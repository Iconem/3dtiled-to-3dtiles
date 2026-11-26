/**
 * The Terrain tab's service: Terrain Viewer's tile service (Iconem, MIT, github.com/Iconem/terrain-viewer, `tile-server/`),
 * which turns a DEM (Terrarium or Terrain-RGB tiles, a COG, a VRT, LERC…) into quantized-mesh terrain and XYZ tiles of
 * its analyses, per tile, on request.
 *
 * GETTING IT. Not shipped in this app: its authors publish one zip per platform (Node plus the service), which the
 * one-stop tiler's machinery downloads and checks against a pinned SHA-256 (`SERVICES['terrain-service']` in
 * packages/tilers/tools.js). The view runs `packages/tilers/cli.js install terrain-service` through the CLI runner;
 * this module only asks the same CLI where it is (`detect --json`), so both agree on the tools folder.
 *
 * RUNNING IT. `bin/node server.mjs` in its folder, as a child of this process, the way Terrain Viewer's own desktop app
 * and its QGIS plugin start it: on 127.0.0.1 only, without its browser engine (flat, north-up tiles), reading no .env,
 * and stopping by itself when its standard input closes (TV_EXIT_WITH_STDIN), so a crashed or killed app leaves no
 * orphan on the port. A Terrain Viewer service already answering on one of the ports (its desktop app's, 3400 by
 * default) is adopted rather than doubled, and left running on Stop.
 */
import type { TerrainServiceStatus } from "../shared/rpc-schema";

export const TERRAIN_PORTS = [3400, 3401, 3402, 3403];

type Child = { pid?: number; kill: () => void; closeStdin: () => void; exited: Promise<number | null> };

/** Does a Terrain Viewer tile service answer here? Its /health names its direct engine. */
async function probe(port: number): Promise<"terrain" | "other" | null> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
		const body = await r.text();
		return r.ok && body.includes('"direct"') ? "terrain" : "other";
	} catch {
		try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) }); return "other"; }
		catch { return null; }
	}
}

export function createTerrainService(opts: { root: string; node: string }) {
	let state: TerrainServiceStatus["state"] = "stopped";
	let port: number | null = null;
	let owned = false;
	let message: string | undefined;
	let child: Child | null = null;
	let found: { installed: boolean; version?: string; downloadable: boolean; bytes: number | null; hint?: string; exe?: string } | null = null;
	const tail: string[] = [];
	// bumped by every start and stop: a start still waiting for /health knows it was overtaken
	let generation = 0;

	const remember = (chunk: unknown) => {
		for (const l of String(chunk).split(/\r?\n/)) if (l.trim()) tail.push(l);
		if (tail.length > 60) tail.splice(0, tail.length - 60);
	};

	/** Where the CLI says the service is (the same tools folder the install wrote to). */
	async function detect() {
		const { execFile } = await import("node:child_process");
		const out = await new Promise<string>((resolve) => {
			execFile(opts.node, ["packages/tilers/cli.js", "detect", "terrain-service", "--json"], { cwd: opts.root, windowsHide: true, timeout: 30_000 },
				(_err, stdout) => resolve(String(stdout ?? "")));
		});
		const line = out.split(/\r?\n/).find((l) => l.startsWith("TILER_JSON "));
		const d = line ? JSON.parse(line.slice("TILER_JSON ".length))?.tools?.[0] : null;
		found = d
			? { installed: d.status === "ready", version: d.version ?? undefined, downloadable: !!d.downloadable, bytes: d.bytes ?? null, hint: d.hint, exe: d.exe?.[0] }
			: { installed: false, downloadable: false, bytes: null, hint: "The tilers CLI did not answer." };
		return found;
	}

	async function spawnService(exe: string, p: number): Promise<Child> {
		const { spawn } = await import("node:child_process");
		const { dirname } = await import("node:path");
		const dir = dirname(dirname(exe));
		if (process.platform !== "win32") {
			// an unpacked zip may have lost the executable bit
			const { chmodSync, statSync } = await import("node:fs");
			try { if (!(statSync(exe).mode & 0o100)) chmodSync(exe, 0o755); } catch { /* tried */ }
		}
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PORT", "NODE_OPTIONS", "TV_ENV_FILE"].includes(k)) env[k] = v;
		Object.assign(env, { PORT: String(p), TV_HOST: "127.0.0.1", TV_EXIT_WITH_STDIN: "1", TV_NO_BROWSER: "1", TV_ENV_FILE: `${dir}/no-such.env` });
		const proc = spawn(exe, ["server.mjs"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		proc.stdout?.on("data", remember);
		proc.stderr?.on("data", remember);
		const exited = new Promise<number | null>((resolve) => {
			proc.on("error", (e) => { remember(`could not start: ${e}`); resolve(null); });
			proc.on("exit", (code) => resolve(code));
		});
		return {
			pid: proc.pid,
			kill: () => { try { proc.kill(); } catch { /* gone */ } },
			closeStdin: () => { try { proc.stdin?.end(); } catch { /* gone */ } },
			exited,
		};
	}

	async function start() {
		if (state === "starting" || state === "running") return;
		const gen = ++generation;
		state = "starting"; message = undefined; tail.length = 0;
		const d = await detect();
		if (gen !== generation) return;
		if (!d.installed || !d.exe) { state = "stopped"; message = d.hint ?? "Not installed."; return; }
		for (const p of TERRAIN_PORTS) {
			const there = await probe(p);
			if (gen !== generation) return;
			if (there === "terrain") { port = p; owned = false; state = "running"; message = `A Terrain Viewer tile service was already running on port ${p}: this app uses it and leaves it running.`; return; }
			if (there === "other") continue;
			let c: Child;
			try { c = await spawnService(d.exe, p); }
			catch (e) { state = "error"; message = `Could not start it: ${e}`; return; }
			child = c; port = p; owned = true;
			let gone = false;
			void c.exited.then((code) => {
				gone = true;
				if (child !== c) return;
				child = null;
				if (gen === generation && state !== "stopped") { state = "error"; message = `It stopped (exit code ${code}). ${tail.slice(-3).join(" ")}`.trim(); }
			});
			const t0 = Date.now();
			while (Date.now() - t0 < 60_000 && !gone && gen === generation) {
				if ((await probe(p)) === "terrain") { if (gen === generation) state = "running"; return; }
				await new Promise((r) => setTimeout(r, 400));
			}
			if (gen !== generation || gone) return;
			stopChild();
			state = "error"; message = `No answer on port ${p} within 60 s. ${tail.slice(-3).join(" ")}`.trim();
			return;
		}
		state = "error"; message = `Ports ${TERRAIN_PORTS.join(", ")} are all taken by other programs.`;
	}

	function stopChild() {
		const c = child;
		child = null;
		if (!c) return;
		c.closeStdin();                                   // the service stops when its input closes
		const timer = setTimeout(() => c.kill(), 3000);   // and is killed if it has not
		void c.exited.then(() => clearTimeout(timer));
	}

	function stop() {
		generation++;
		stopChild();
		state = "stopped"; message = undefined; port = null; owned = false;
	}

	async function status(): Promise<TerrainServiceStatus> {
		if (!found) await detect().catch(() => null);
		// an adopted service may have gone since (ours reports its own exit): the pill says what answers now. A busy
		// service that is slow to answer /health is not gone.
		if (state === "running" && port && !owned && (await probe(port)) === null) {
			state = "stopped";
			message = `The service on port ${port}, not started by this app, is gone.`;
			port = null;
		}
		return {
			state, port, owned, message,
			url: state === "running" && port ? `http://127.0.0.1:${port}` : null,
			pid: owned && child ? child.pid ?? null : null,
			installed: !!found?.installed, version: found?.version ?? null, downloadable: !!found?.downloadable, bytes: found?.bytes ?? null,
			hint: found?.hint ?? null,
			log: tail.slice(-20),
		};
	}

	return {
		async request(action: "status" | "start" | "stop" | "refresh"): Promise<TerrainServiceStatus> {
			if (action === "refresh") await detect().catch(() => null);
			if (action === "start") void start();   // answered at once: the view polls the status while it starts
			if (action === "stop") stop();
			return status();
		},
		kill: () => stopChild(),
	};
}

export default {
	// The view's dependencies (React, Tailwind, shadcn, Vite) come from pnpm, with its own lockfile here:
	// apps/desktop is outside the root workspace (pnpm-workspace.yaml), and Hutch's built-in resolver
	// refuses to run under a package.json that declares `workspaces`. Hence --ignore-workspace.
	packageManager: "pnpm",
	scripts: {
		install: ["pnpm", "install", "--frozen-lockfile", "--ignore-workspace"],
		// `electrobun prepare` unpacks the Electrobun API into .hutch/devkit, which vite.config.ts resolves
		// `electrobun/view` from; then Vite writes dist/, which electrobun.config.ts copies into the app.
		// `hutch pm exec` runs node_modules/.bin: Bun's shell cannot run pnpm's .cmd shim on Windows.
		view: "hutch electrobun prepare && hutch pm exec -- vite build",
		typecheck: "hutch electrobun prepare && hutch pm exec -- tsc --noEmit",
		start: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev --watch",
		build: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable",
	},
	electrobun: {
		// 2.0.2 is the first stable that can package on Windows: 2.0.1 pinned a cottontail whose
		// windows-x64 release has no `cottontail-core`, so `electrobun build` died with `CopySourceMissing`.
		// Stay on 2.0.2. 2.0.6 was tried on 2026-11-06 and taken back the same night: its update helper (uninstall.exe
		// --prepare-update) never finished on this app. Root cause found on 2026-11-08 by rebuilding its archive code in
		// Debug: package/src/extractor/archive_recipe.zig:716, `const count = @min(buffer.len, (literal.len - offset) / 2)`
		// is narrowed to a 17-bit integer by the comptime 65536, so `count * 2` wraps to 0 once a literal span (a run of
		// tar headers with no file content) reaches 64 KB, and the loop never advances. Our bundle has a run of 295
		// directories and empty files in node_modules/3d-tiles-tools (148 KB). `const count: usize = …` fixes it. Move
		// past 2.0.2 only once a release carries that fix, and test it with DESKTOP_UPDATE_BASE first (see docs).
		version: "2.0.2",
	},
};

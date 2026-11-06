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
		// --prepare-update) never finished on this app (14 000 files, 750 MB). From an install that came from 2.0.2 it read
		// the retained tar and then held a core for 49 minutes without writing anything; with that tar removed it downloaded
		// and staged the new app, then held a core again. Try a later release on an installed copy before moving.
		version: "2.0.2",
	},
};

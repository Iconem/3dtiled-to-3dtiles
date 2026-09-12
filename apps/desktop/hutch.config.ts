export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
	electrobun: {
		// A BETA, and deliberately so: Electrobun 2.0.1 (the current stable) cannot PACKAGE on
		// Windows. It pins cottontail 0.5.0, whose windows-x64 release ships only `cottontail.exe` —
		// not the `cottontail-core` binary that its own build step then tries to copy — so
		// `electrobun build` dies with `CopySourceMissing`. 2.0.2-beta.20 resolves cottontail
		// 0.7.0-canary.2, which does ship it. Both `dev` and `build` were verified on this pin.
		// Revisit when 2.0.2 ships stable.
		version: "2.0.2-beta.20",
	},
};

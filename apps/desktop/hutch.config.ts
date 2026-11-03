export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
	electrobun: {
		// 2.0.2 is the first stable that can package on Windows: 2.0.1 pinned a cottontail whose
		// windows-x64 release has no `cottontail-core`, so `electrobun build` died with `CopySourceMissing`.
		version: "2.0.2",
	},
};

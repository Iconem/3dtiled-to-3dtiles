import { readFileSync } from "node:fs";
import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		// One word, as the shortcut's name: Windows search for "3dtiled" does not match "3D Tiled".
		name: "3DTiled",
		identifier: "com.iconem.3dtiled.desktop",
		// The build day: a valid three-part version, as the updater compares bundle hashes, not versions.
		version: process.env.BUILD_VERSION ?? "0.1.0",
	},
	// The feed the installed app updates from: what .github/workflows/desktop.yml publishes, in the repo building it.
	release: {
		baseUrl: `https://github.com/${process.env.GITHUB_REPOSITORY ?? "jo-chemla/3dtiled-to-3dtiles"}/releases/download/desktop-latest`,
		generatePatch: false,
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
		},
		// The view is React + Tailwind, built by Vite into dist/ (vite.config.ts), because Electrobun's
		// own view bundler takes no plugins. `hutch run build` / `hutch run dev` run Vite first; a bare
		// `hutch electrobun build` copies whatever dist/ holds.
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// A distributable carries the tile-server and Node, from scripts/prepare-bundle.mjs.
			...(process.env.DESKTOP_BUNDLE_MAP ? JSON.parse(readFileSync(process.env.DESKTOP_BUNDLE_MAP, "utf8")) : {}),
		},
		// Vite's output is an input of this build, not something to watch for.
		watchIgnore: ["dist/**"],
		// Distributable artifacts (installers, .app/.dmg, update archives) land here. Gitignored
		// alongside build/ — they are large binaries rebuilt from source on demand.
		artifactFolder: "artifacts",
		mac: {
			bundleCEF: false,
			// SIGNING IS OPT-IN AND OFF BY DEFAULT, deliberately. Enabling it requires an Apple
			// Developer ID in the build machine's keychain plus notarization credentials in the
			// environment; with neither present the build FAILS rather than quietly shipping an
			// unsigned app, which is worse than not attempting it. Set ELECTROBUN_CODESIGN=1 on a
			// machine that has them. See the README for the full credential list.
			codesign: process.env.ELECTROBUN_CODESIGN === "1",
			notarize: process.env.ELECTROBUN_NOTARIZE === "1",
			// A DMG is only meaningful for a signed distributable; local prototype builds just want
			// the .app bundle, and building a DMG every time is slow.
			createDmg: process.env.ELECTROBUN_CODESIGN === "1",
		},
		linux: {
			bundleCEF: false,
			icon: "assets/icon.png",
		},
		win: {
			bundleCEF: false,
			icon: "assets/icon.ico",
			// Electrobun exposes no Windows signing option — Authenticode is a post-build step
			// (`signtool sign /fd sha256 /tr <timestamp-url> …` against the produced .exe). Left
			// undone rather than faked: this repo has no code-signing certificate.
		},
	},
} satisfies ElectrobunConfig;

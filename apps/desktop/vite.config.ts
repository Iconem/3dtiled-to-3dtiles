/**
 * Builds the view (src/mainview) to dist/, which electrobun.config.ts copies into the app as
 * views/mainview. Electrobun's own view bundler takes no plugins, so React, Tailwind and the
 * `@/` alias go through Vite, the way Electrobun's react-tailwind-vite template does.
 *
 * `electrobun/view` resolves into .hutch/devkit, the Electrobun API Hutch unpacks for the pinned
 * version (`hutch electrobun prepare`), so the view bundles the same RPC transport the main
 * process speaks and no `electrobun` npm package is needed.
 */
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: [
			...electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
			{ find: /^@\//, replacement: `${resolve(__dirname, "src/mainview").replaceAll("\\", "/")}/` },
		],
	},
	root: "src/mainview",
	// Relative asset URLs: the page is served from views://mainview/index.html, not from a host root.
	base: "./",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
});

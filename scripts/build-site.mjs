/**
 * Builds the writable surface on the project site.
 *
 * docs/ is served straight from the repo by GitHub Pages, so the bundle is
 * committed alongside the page it runs on. Rebuild it whenever anything under
 * src/ink/ changes, or the site quietly keeps drawing with an older ink path:
 *
 *   node scripts/build-site.mjs
 */
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/site/DemoInk.ts"],
	outfile: "docs/demo.js",
	bundle: true,
	minify: true,
	format: "iife",
	target: "es2018",
	legalComments: "none",
	logLevel: "info",
});

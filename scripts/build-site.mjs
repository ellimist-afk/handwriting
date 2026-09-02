/**
 * Builds the writable surface on the project site.
 *
 * docs/ is served straight from the repo by GitHub Pages, so the bundle is
 * committed alongside the page it runs on. Rebuild it whenever anything under
 * src/ink/ changes, or the site quietly keeps drawing with an older ink path:
 *
 *   node scripts/build-site.mjs
 *
 * siteBuildOptions is exported so scripts/check-site.mjs builds with the
 * exact options this script uses - a check that kept its own copy could
 * silently drift from what an actual build produces (audit doc §5e/F1).
 */
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";

export const siteBuildOptions = {
	entryPoints: ["src/site/DemoInk.ts"],
	bundle: true,
	minify: true,
	format: "iife",
	target: "es2018",
	legalComments: "none",
};

// Only build when this file is run directly. check-site.mjs imports
// siteBuildOptions above; importing it must not have the side effect of
// overwriting docs/demo.js out from under the check that reads it.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await esbuild.build({
		...siteBuildOptions,
		outfile: "docs/demo.js",
		logLevel: "info",
	});
}

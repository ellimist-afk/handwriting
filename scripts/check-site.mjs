/**
 * docs/demo.js is committed and served straight from docs/ by GitHub Pages -
 * nothing else rebuilds or checks it, so a source change under src/site/ or
 * src/ink/ with no rebuild ships a stale demo silently (audit doc §5e/F1: it
 * was 21 bytes stale on 2026-09-02, drawing with an older ink path than the
 * one users install).
 *
 * This builds the same bundle scripts/build-site.mjs produces - importing
 * its siteBuildOptions rather than a second copy, so the two cannot drift -
 * to a file under os.tmpdir(), and compares it byte-for-byte against what's
 * committed.
 *
 * Run by CI and by `npm run check:site`. Exits non-zero with the exact
 * disagreement rather than a generic failure.
 */

import esbuild from "esbuild";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { siteBuildOptions } from "./build-site.mjs";

const tmpOut = join(tmpdir(), `handwriting-demo-check-${randomUUID()}.js`);

try {
	await esbuild.build({
		...siteBuildOptions,
		outfile: tmpOut,
		logLevel: "silent",
	});

	const built = readFileSync(tmpOut);
	const committed = readFileSync("docs/demo.js");

	if (!built.equals(committed)) {
		const shared = Math.min(built.length, committed.length);
		let firstDiff = shared;
		for (let i = 0; i < shared; i++) {
			if (built[i] !== committed[i]) {
				firstDiff = i;
				break;
			}
		}
		console.error(
			`docs/demo.js is stale: a fresh build is ${built.length} bytes, ` +
				`the committed file is ${committed.length} bytes, diverging at byte ${firstDiff}`
		);
		process.exit(1);
	}

	console.log("site bundle is current");
} finally {
	try {
		unlinkSync(tmpOut);
	} catch {
		// Nothing to clean up if the build above failed before writing it.
	}
}

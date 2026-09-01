/**
 * The version is written in three files and they must agree.
 *
 * Twice in one day a release stalled half-made because they did not: the
 * packager checks this too, but it checks at PACKAGING time, which is after
 * the commit, the push and the decision to ship. Checking it on every push
 * moves the failure to where it costs nothing.
 *
 * Run by CI and by `npm run check:versions`. Exits non-zero with the exact
 * disagreement rather than a generic failure.
 */

import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json");

const problems = [];

if (manifest.version !== pkg.version) {
	problems.push(`manifest.json says ${manifest.version}, package.json says ${pkg.version}`);
}

const mapped = versions[manifest.version];
if (mapped === undefined) {
	problems.push(`versions.json has no entry for ${manifest.version}`);
} else if (mapped !== manifest.minAppVersion) {
	problems.push(
		`versions.json maps ${manifest.version} to Obsidian ${mapped}, ` +
			`but manifest.json's minAppVersion is ${manifest.minAppVersion}`
	);
}

if (problems.length > 0) {
	for (const p of problems) console.error(`version mismatch: ${p}`);
	process.exit(1);
}

console.log(`versions agree: ${manifest.version} (Obsidian ${manifest.minAppVersion})`);

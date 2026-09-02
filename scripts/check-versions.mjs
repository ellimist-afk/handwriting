/**
 * The version is written in several files and they must agree.
 *
 * Twice in one day a release stalled half-made because they did not: the
 * packager checks this too, but it checks at PACKAGING time, which is after
 * the commit, the push and the decision to ship. Checking it on every push
 * moves the failure to where it costs nothing.
 *
 * Everything is derived from `manifest.json`, which is the one file Obsidian
 * itself reads. Nothing here hardcodes a version — a checker that has to be
 * edited at every bump is one more thing to forget, and forgetting is what
 * aborted the 1.4.2 provenance job.
 *
 * Run by CI and by `npm run check:versions`. Exits non-zero with the exact
 * disagreement rather than a generic failure.
 */

import { readFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const manifest = read("manifest.json");
const pkg = read("package.json");
const lock = read("package-lock.json");
const versions = read("versions.json");

const problems = [];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// The shape first, so a corrupt manifest cannot make every comparison below
// trivially true by agreeing with nothing.
if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
	problems.push(`manifest.json version is not a version: ${JSON.stringify(manifest.version)}`);
}
if (typeof manifest.minAppVersion !== "string" || !SEMVER.test(manifest.minAppVersion)) {
	problems.push(
		`manifest.json minAppVersion is not a version: ${JSON.stringify(manifest.minAppVersion)}`
	);
}

if (manifest.version !== pkg.version) {
	problems.push(`manifest.json says ${manifest.version}, package.json says ${pkg.version}`);
}

// npm maintains both of these on a version bump, and only if it is run. The
// lock drifted from 0.13.10 to 1.4.5 unnoticed because nothing compared them,
// and the lockfile is what a provenance build installs from.
if (lock.version !== pkg.version) {
	problems.push(`package-lock.json says ${lock.version}, package.json says ${pkg.version}`);
}
const lockRoot = lock.packages?.[""]?.version;
if (lockRoot !== pkg.version) {
	problems.push(
		`package-lock.json root package says ${lockRoot}, package.json says ${pkg.version}`
	);
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

// Obsidian reads this file to decide which release an older app may install.
// One malformed entry is enough to make that decision wrong, and it would be
// wrong silently, for the users on the oldest apps.
for (const [release, minApp] of Object.entries(versions)) {
	if (!SEMVER.test(release)) problems.push(`versions.json has a bad release key: ${release}`);
	if (typeof minApp !== "string" || !SEMVER.test(minApp)) {
		problems.push(`versions.json maps ${release} to a bad minAppVersion: ${JSON.stringify(minApp)}`);
	}
}

// A tag build must be packaging the version it is tagged as. The tag is the
// one claim about a release that does not come from the commit, so it is the
// one worth checking against it; the repo's tags carry a leading "v" and
// sometimes a label (v0.12.8-probe), so the version is the tag's prefix.
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
	const tag = process.env.GITHUB_REF_NAME.replace(/^v/, "");
	if (tag !== manifest.version && !tag.startsWith(`${manifest.version}-`)) {
		problems.push(
			`the build is tagged ${process.env.GITHUB_REF_NAME}, but manifest.json says ${manifest.version}`
		);
	}
}

// The packager must keep deriving its version rather than being told one. It
// carried two hand-edited constants until 2026-09-01, and forgetting to bump
// them is exactly what aborted the 1.4.2 provenance job; this is the guard
// against them coming back.
const release = readFileSync("scripts/release.mjs", "utf8");
for (const banned of ["EXPECT_VERSION", "EXPECT_MIN_APP"]) {
	if (release.includes(banned)) {
		problems.push(
			`scripts/release.mjs mentions ${banned}: the packager must read the version from manifest.json, not hold its own copy`
		);
	}
}

if (problems.length > 0) {
	for (const p of problems) console.error(`version mismatch: ${p}`);
	process.exit(1);
}

console.log(`versions agree: ${manifest.version} (Obsidian ${manifest.minAppVersion})`);

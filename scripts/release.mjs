/**
 * Handwriting release packager: one commit, one build, three files.
 *
 * The failure this exists to make impossible: v0.13.6 RC3 was a correct
 * `main.js` sitting in a checkout whose `manifest.json` and `styles.css`
 * were still v0.12.4, because the build and the metadata came from different
 * commits. Everything below is derived from ONE worktree, the one this
 * script itself lives in, and the run aborts before writing anything if any
 * precondition fails. There is no flag to skip a check.
 *
 *   node scripts/release.mjs        (or: npm run release)
 *
 * Output: release/{main.js,manifest.json,styles.css} plus release/RECEIPT.txt,
 * which records the commit and the full SHA-256 of each asset. The receipt is
 * local: this script does not tag, push, publish or deploy.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPECT_VERSION = "1.0.11";
const EXPECT_MIN_APP = "1.12.3";
const ASSETS = ["main.js", "manifest.json", "styles.css"];

/**
 * Stylesheet rules the v0.13.x code depends on. A stale styles.css is the
 * quietest possible packaging fault: the plugin loads, the version string
 * looks right, and the damage shows up as input bugs. So each rule is
 * asserted by a fragment that only that rule contains.
 */
const REQUIRED_CSS = [
	[".cm-scroller.handwriting-touch-guard *", "RC3 nested-scroll-container guard (backlinks dead band)"],
	[".cm-scroller.handwriting-hscroll::-webkit-scrollbar", "v0.13.0 horizontal bearings"],
	[".cm-scroller.handwriting-hscroll-axis", "v0.13.8 horizontal axis patch (moved off inline styles)"],
	[".embedded-backlinks", "v0.13.0 backlinks border removal on Handwriting pages"],
	['.metadata-property[data-property-key="handwriting-page-id"]', "page-id property hidden from Properties UI"],
	["body.handwriting-active-page .status-bar", "status bar kept off the writing surface"],
];

const problems = [];
function require_(ok, message) {
	if (!ok) problems.push(message);
	return ok;
}
function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
/**
 * A tracked file's content AS COMMITTED, bytes and all.
 *
 * Not the working copy: with core.autocrlf=true (the default this was built
 * on) a Windows checkout holds CRLF, so packaging from disk would ship bytes
 * that depend on who cloned the repo and would hash differently on every
 * platform. Reading the blob makes "came from this commit" literal rather
 * than inferred, and makes the receipt hashes mean the same thing everywhere.
 */
function blobAt(commit, relPath, cwd) {
	return execFileSync("git", ["show", `${commit}:${relPath}`], {
		cwd,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
	});
}
/** LF, so a build is not fingerprinted by the checkout it came from. */
function normalizeEol(buf) {
	return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}
function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---- 1. one worktree, and it is THIS one ------------------------------------
// Resolved from the script's own location, never from cwd: running it from
// another checkout must not let that checkout's assets into the package.

let root;
try {
	root = path.resolve(git(["rev-parse", "--show-toplevel"], SCRIPT_DIR));
} catch {
	console.error("FATAL: scripts/release.mjs is not inside a git worktree.");
	process.exit(1);
}
const expectedRoot = path.resolve(SCRIPT_DIR, "..");
if (root !== expectedRoot) {
	console.error(
		`FATAL: worktree root ${root} is not this script's parent ${expectedRoot}.\n` +
			"Refusing to package assets that may come from a different checkout."
	);
	process.exit(1);
}

const commit = git(["rev-parse", "HEAD"], root);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root);

// ---- 2. preconditions -------------------------------------------------------

const dirty = git(["status", "--porcelain"], root);
require_(
	dirty === "",
	`the worktree has uncommitted changes, so the package would not correspond to ${commit.slice(0, 12)}:\n` +
		dirty.split("\n").map((l) => `      ${l}`).join("\n")
);

// Read the COMMITTED content, not the checkout, for everything tracked.
const manifestBytes = normalizeEol(blobAt(commit, "manifest.json", root));
const stylesBytes = normalizeEol(blobAt(commit, "styles.css", root));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const pkg = JSON.parse(blobAt(commit, "package.json", root).toString("utf8"));
const versions = JSON.parse(blobAt(commit, "versions.json", root).toString("utf8"));

require_(
	manifest.version === EXPECT_VERSION,
	`manifest.json version is "${manifest.version}", expected "${EXPECT_VERSION}"`
);
require_(
	pkg.version === EXPECT_VERSION,
	`package.json version is "${pkg.version}", expected "${EXPECT_VERSION}"`
);
require_(
	manifest.minAppVersion === EXPECT_MIN_APP,
	`manifest.json minAppVersion is "${manifest.minAppVersion}", expected "${EXPECT_MIN_APP}"`
);
require_(
	versions[EXPECT_VERSION] === EXPECT_MIN_APP,
	`versions.json maps ${EXPECT_VERSION} to "${versions[EXPECT_VERSION]}", expected "${EXPECT_MIN_APP}"`
);

const css = stylesBytes.toString("utf8");
for (const [fragment, why] of REQUIRED_CSS) {
	require_(css.includes(fragment), `styles.css is missing "${fragment}" (${why})`);
}

if (problems.length > 0) {
	console.error("RELEASE ABORTED. Nothing was built or written.\n");
	for (const p of problems) console.error(`  ✗ ${p}`);
	console.error(`\n  worktree: ${root}\n  commit:   ${commit}\n`);
	process.exit(1);
}

// ---- 3. fresh build ---------------------------------------------------------
// The bundle is rebuilt from this worktree's src/, never reused: a main.js
// left lying in the tree is exactly the artefact that cannot be trusted.

const out = path.join(root, "release");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const builtMarker = Date.now();
const staleBundle = path.join(root, "main.js");
fs.rmSync(staleBundle, { force: true });

console.log(`building ${EXPECT_VERSION} from ${commit.slice(0, 12)} (${branch})…`);
execFileSync("node", ["esbuild.config.mjs", "production"], { cwd: root, stdio: "inherit" });

if (!fs.existsSync(staleBundle) || fs.statSync(staleBundle).mtimeMs < builtMarker) {
	console.error("FATAL: esbuild did not produce a fresh main.js. Nothing packaged.");
	process.exit(1);
}

// ---- 4. package + receipt ---------------------------------------------------

// main.js is the build output (untracked); manifest.json and styles.css are
// the commit's own bytes. All three normalized to LF so the receipt hashes
// identify the RELEASE, not the machine that produced it.
const payload = {
	"main.js": normalizeEol(fs.readFileSync(staleBundle)),
	"manifest.json": manifestBytes,
	"styles.css": stylesBytes,
};
const receipt = [];
for (const name of ASSETS) {
	const to = path.join(out, name);
	fs.writeFileSync(to, payload[name]);
	receipt.push({ name, sha256: sha256(to), bytes: fs.statSync(to).size });
}

const text = [
	"Handwriting release receipt",
	"=====================",
	`plugin id     : ${manifest.id}`,
	`version       : ${manifest.version}`,
	`minAppVersion : ${manifest.minAppVersion}`,
	`commit        : ${commit}`,
	`branch        : ${branch}`,
	`worktree      : ${root}`,
	`built at      : ${new Date().toISOString()}`,
	"",
	"All three assets come from the single worktree and single commit above.",
	"main.js was rebuilt from that worktree's src/ in this run; manifest.json",
	"and styles.css are the commit's own blobs, not the checkout's copies.",
	"Line endings are normalized to LF, so these hashes identify the release",
	"rather than the machine that produced it.",
	"",
	"Preconditions checked and passed: clean worktree; manifest/package",
	"version; versions.json mapping; minAppVersion; all required v0.13.x",
	"stylesheet rules present; bundle freshly built in this run.",
	"",
	"SHA-256",
	"-------",
	...receipt.map((r) => `${r.sha256}  ${r.name}  (${r.bytes} bytes)`),
	"",
	"Install/update: copy ALL THREE files together into",
	"<vault>/.obsidian/plugins/handwriting/ and reload Obsidian.",
	"",
].join("\n");

fs.writeFileSync(path.join(out, "RECEIPT.txt"), text, "utf8");

console.log(`\n${text}`);
console.log(`packaged -> ${out}`);

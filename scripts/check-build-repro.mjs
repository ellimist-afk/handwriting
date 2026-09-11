import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalBuildInputDigest } from "./build-provenance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildInputs = ["src", "esbuild.config.mjs", "scripts/build-provenance.mjs", "package.json", "package-lock.json", "tsconfig.json"];
const tempRoots = [];
const fixtureParent = path.resolve(process.env.HANDWRITING_BUILD_CHECK_DIR || os.tmpdir());
const checkoutOutput = path.resolve(root, process.env.HANDWRITING_BUILD_OUTFILE || "main.js");
mkdirSync(fixtureParent, { recursive: true });

function tempRoot(label) {
	const dir = mkdtempSync(path.join(fixtureParent, `handwriting-${label}-`));
	tempRoots.push(dir);
	return dir;
}
function copyInputs(to) {
	for (const input of buildInputs) cpSync(path.join(root, input), path.join(to, input), { recursive: true });
	symlinkSync(
		path.join(root, "node_modules"),
		path.join(to, "node_modules"),
		process.platform === "win32" ? "junction" : "dir"
	);
}
function digest(dir) {
	return canonicalBuildInputDigest(dir);
}
function hash(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function textFiles(dir) {
	const files = [];
	// The build inputs are all text; walk only the source tree for EOL parity.
	function walk(current) {
		for (const name of readdirSync(current, { withFileTypes: true })) {
			const file = path.join(current, name.name);
			if (name.isDirectory()) walk(file);
			else files.push(file);
		}
	}
	walk(path.join(dir, "src"));
	return files;
}
function normalizeBuildInputs(dir, eol) {
	const files = [...textFiles(dir), path.join(dir, "esbuild.config.mjs"), path.join(dir, "scripts", "build-provenance.mjs"), path.join(dir, "package.json"), path.join(dir, "package-lock.json"), path.join(dir, "tsconfig.json")];
	for (const file of files) {
		const normalized = readFileSync(file, "utf8").replace(/\r\n?|\n/g, "\n");
		writeFileSync(file, normalized.replace(/\n/g, eol));
	}
}
try {
	execFileSync("node", ["esbuild.config.mjs", "production"], { cwd: root, stdio: "inherit" });
	const checkoutHash = hash(checkoutOutput);

	const archive = tempRoot("gitless");
	copyInputs(archive);
	execFileSync("node", ["esbuild.config.mjs", "production"], {
		cwd: archive, stdio: "inherit",
		env: { ...process.env, HANDWRITING_BUILD_OUTFILE: path.join(archive, "main.js") },
	});
	const gitlessHash = hash(path.join(archive, "main.js"));
	if (checkoutHash !== gitlessHash) throw new Error(`checkout/gitless bundles differ: ${checkoutHash} != ${gitlessHash}`);

	const lf = tempRoot("lf");
	const crlf = tempRoot("crlf");
	copyInputs(lf); copyInputs(crlf);
	normalizeBuildInputs(lf, "\n");
	normalizeBuildInputs(crlf, "\r\n");
	if (readFileSync(path.join(lf, "tsconfig.json"), "utf8") === readFileSync(path.join(crlf, "tsconfig.json"), "utf8")) {
		throw new Error("LF/CRLF fixtures are byte-identical");
	}
	if (digest(lf) !== digest(crlf)) throw new Error("LF/CRLF canonical digests differ");

	const sourceChanged = tempRoot("source-change");
	copyInputs(sourceChanged);
	const sourceFile = path.join(sourceChanged, "src", "main.ts");
	writeFileSync(sourceFile, readFileSync(sourceFile, "utf8") + "\n");
	if (digest(lf) === digest(sourceChanged)) throw new Error("source mutation did not change digest");

	const configChanged = tempRoot("config-change");
	copyInputs(configChanged);
	const tsconfig = path.join(configChanged, "tsconfig.json");
	writeFileSync(tsconfig, readFileSync(tsconfig, "utf8") + "\n");
	if (digest(lf) === digest(configChanged)) throw new Error("tsconfig mutation did not change digest");

	const helperChanged = tempRoot("helper-change");
	copyInputs(helperChanged);
	const helper = path.join(helperChanged, "scripts", "build-provenance.mjs");
	writeFileSync(helper, readFileSync(helper, "utf8") + "\n");
	if (digest(lf) === digest(helperChanged)) throw new Error("provenance helper mutation did not change digest");

	const dev = tempRoot("dev");
	copyInputs(dev);
	// Dev/watch mode intentionally does not claim a frozen production identity.
	const config = readFileSync(path.join(root, "esbuild.config.mjs"), "utf8");
	if (!config.includes('prod ? canonicalBuildInputDigest() : "unverified"')) {
		throw new Error("dev/watch provenance is not explicitly unverified");
	}
	console.log(`build reproducibility passed: ${checkoutHash}`);
} finally {
	for (const dir of tempRoots) {
		// Only remove the direct temporary child created above, never its parent.
		if (path.dirname(path.resolve(dir)) !== fixtureParent || !path.basename(dir).startsWith("handwriting-")) {
			throw new Error(`Refusing unexpected fixture cleanup path: ${dir}`);
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

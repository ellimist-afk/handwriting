import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Stable identity for the exact files esbuild and TypeScript consume. Git
 * metadata is intentionally excluded so a checkout and source archive agree.
 */
export function canonicalBuildInputDigest(root = process.cwd()) {
	const files = [];
	function collect(relPath) {
		const absolute = path.join(root, relPath);
		if (statSync(absolute).isDirectory()) {
			for (const child of readdirSync(absolute).sort()) collect(path.join(relPath, child));
		} else {
			files.push(relPath.split(path.sep).join("/"));
		}
	}
	for (const input of ["src", "esbuild.config.mjs", "scripts/build-provenance.mjs", "package.json", "package-lock.json", "tsconfig.json"]) {
		collect(input);
	}
	const hash = createHash("sha256");
	for (const file of files.sort()) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(path.join(root, file)).toString("utf8").replace(/\r\n?|\n/g, "\n"));
		hash.update("\0");
	}
	return `content-sha256:${hash.digest("hex")}`;
}

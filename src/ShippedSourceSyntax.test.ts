/** Scans each file esbuild bundles from src/main.ts for a regex lookbehind and names every hit by file and line. */
import { expect, it } from "vitest";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

it("no file the plugin's bundle is built from holds a regex lookbehind", () => {
	const { metafile } = buildSync({
		absWorkingDir: ROOT,
		entryPoints: ["src/main.ts"],
		bundle: true,
		write: false,
		metafile: true,
		packages: "external",
		format: "cjs",
		target: "es2022",
		logLevel: "silent",
	});
	const files = Object.keys(metafile.inputs);
	// The scan reads the bundle's own files: the entry and the table-cell reader among them, no test file.
	expect(files).toContain("src/main.ts");
	expect(files).toContain("src/inline/InkAttachments.ts");
	expect(files.filter((f) => /\.test\.|testutil|test\.util|testUtils\//.test(f))).toEqual([]);
	const hits: string[] = [];
	for (const file of files) {
		const lines = readFileSync(fileURLToPath(new URL("../" + file, import.meta.url)), "utf8").split("\n");
		lines.forEach((line, i) => {
			if (line.includes("(?<=") || line.includes("(?<!")) hits.push(`${file}:${i + 1}`);
		});
	}
	expect(hits).toEqual([]);
});

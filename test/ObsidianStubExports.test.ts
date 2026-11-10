import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import * as stub from "./obsidian-stub";

// Every render file bundles src with esbuild and aliases `obsidian` to
// test/obsidian-stub.ts (the three render stubs re-export it). esbuild fails
// the whole bundle on a named import the alias target does not export, so a
// src file that starts using a new obsidian value breaks every render file
// that reaches it, while the unit suite stays green wherever a test mocks
// the name. This cell asks esbuild which obsidian imports survive type
// elision in each src file, the same names a bundle needs at runtime, and
// checks each against the stub's exports.

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "src");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

const OBSIDIAN_IMPORT = /\b(?:import|export)\s*(?:type\s*)?([^;]*?)\s*from\s*["']obsidian["']/g;

function runtimeObsidianNames(path: string): { names: string[]; unsupported: string[] } {
	const code = transformSync(readFileSync(path, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
	const names: string[] = [];
	const unsupported: string[] = [];
	for (const match of code.matchAll(OBSIDIAN_IMPORT)) {
		const clause = (match[1] ?? "").trim();
		const braced = /^\{([^}]*)\}$/.exec(clause);
		if (!braced) { unsupported.push(clause); continue; }
		for (const part of (braced[1] ?? "").split(",")) {
			const spec = part.trim();
			if (spec === "") continue;
			names.push((spec.split(/\s+as\s+/)[0] ?? "").trim());
		}
	}
	return { names, unsupported };
}

describe("test/obsidian-stub.ts covers every obsidian value src imports", () => {
	const files = sourceFiles(srcDir);
	const needs = new Map<string, string[]>();
	const unsupported: string[] = [];
	let filesWithImports = 0;
	for (const file of files) {
		const found = runtimeObsidianNames(file);
		const rel = file.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
		if (found.names.length > 0) filesWithImports++;
		for (const clause of found.unsupported) unsupported.push(`${rel}: ${clause}`);
		for (const name of found.names) needs.set(name, [...(needs.get(name) ?? []), rel]);
	}

	it("reads enough of src for the check to mean something", () => {
		// A broken walk or pattern would pass with nothing found.
		expect(files.length).toBeGreaterThan(100);
		expect(filesWithImports).toBeGreaterThan(20);
		expect(needs.has("setIcon")).toBe(true);
		expect(needs.has("Notice")).toBe(true);
	});

	it("finds only named obsidian imports, which it can check", () => {
		expect(unsupported).toEqual([]);
	});

	it("has a stub export for every obsidian value a src file uses at runtime", () => {
		const exported = new Set(Object.keys(stub));
		const missing = [...needs.entries()]
			.filter(([name]) => !exported.has(name))
			.map(([name, users]) => `${name} (${users.join(", ")})`)
			.sort();
		expect(missing).toEqual([]);
	});
});

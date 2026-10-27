import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo carries no @types/node, so the one directory listing this cell needs is declared here, as narrowly as the others. */
declare module "node:fs" {
	export function readdirSync(path: string, options: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>;
}

/**
 * docs/ARCHITECTURE.md is the map a new reader uses to find their way around src/. A map that falls behind the code is
 * worse than none, so these cells hold it to the folders that exist: every folder under src/ has a section with a
 * paragraph in it that names a file really in that folder, and no section describes a folder that is gone.
 *
 * It lives under test/ and not src/ because the build digest walks src/**: a test file added there would change main.js.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = join(ROOT, "docs", "ARCHITECTURE.md");

/** A folder with no source of its own to describe: the snapshot store of a test. */
const SKIPPED = new Set(["__snapshots__"]);

/** Every folder under src/, as "src" and "src/x/y", in a stable order. */
export function sourceFolders(root: string = ROOT): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		out.push(rel);
		const names = readdirSync(join(root, rel), { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !SKIPPED.has(entry.name))
			.map(entry => entry.name)
			.sort();
		for (const name of names) walk(`${rel}/${name}`);
	};
	walk("src");
	return out;
}

export interface FolderSection {
	/** The folder the heading names, without a trailing slash. */
	folder: string;
	/** The text under the heading, up to the next heading. */
	body: string;
}

/** The sections whose heading is a folder path in backticks, such as ### `src/camera/`. */
export function folderSections(doc: string): FolderSection[] {
	const sections: FolderSection[] = [];
	let current: FolderSection | null = null;
	for (const line of doc.split(/\r?\n/)) {
		if (/^#{1,6}\s/.test(line)) {
			const m = /^#{1,6}\s+`(src(?:\/[^`]*)?)`\s*$/.exec(line);
			current = m ? { folder: m[1]!.replace(/\/+$/, ""), body: "" } : null;
			if (current) sections.push(current);
		} else if (current) {
			current.body += line + "\n";
		}
	}
	return sections;
}

/** True when the body is a real paragraph and names, in backticks, a file that sits in the folder. */
export function describesFolder(section: FolderSection, root: string = ROOT): boolean {
	const body = section.body.trim();
	if (body.length < 120) return false;
	const names = [...body.matchAll(/`([^`/\s]+\.[A-Za-z.]+)`/g)].map(m => m[1]!);
	return names.some(name => existsSync(join(root, section.folder, name)));
}

describe("docs/ARCHITECTURE.md covers every folder under src/", () => {
	it("the document exists", () => {
		expect(existsSync(DOC), "docs/ARCHITECTURE.md is missing").toBe(true);
	});

	it("every folder under src/ has a section, and each section holds a paragraph naming a file in it", () => {
		const sections = folderSections(readFileSync(DOC, "utf8"));
		const missing: string[] = [];
		const thin: string[] = [];
		for (const folder of sourceFolders()) {
			const section = sections.find(s => s.folder === folder);
			if (!section) missing.push(folder);
			else if (!describesFolder(section)) thin.push(folder);
		}
		expect(missing, `folders with no section in docs/ARCHITECTURE.md: ${missing.join(", ")}`).toEqual([]);
		expect(thin, `sections that are not a paragraph naming a file in the folder: ${thin.join(", ")}`).toEqual([]);
	});

	it("no section describes a folder that is not there", () => {
		const folders = new Set(sourceFolders());
		const stale = folderSections(readFileSync(DOC, "utf8")).map(s => s.folder).filter(f => !folders.has(f));
		expect(stale, `sections for folders that no longer exist: ${stale.join(", ")}`).toEqual([]);
	});

	it("no folder has two sections", () => {
		const seen = new Set<string>();
		const twice: string[] = [];
		for (const s of folderSections(readFileSync(DOC, "utf8"))) {
			if (seen.has(s.folder)) twice.push(s.folder);
			seen.add(s.folder);
		}
		expect(twice, `folders described twice: ${twice.join(", ")}`).toEqual([]);
	});
});

describe("the checks themselves can fail", () => {
	const root = ROOT;
	const good = "`PageStore.ts` writes one sidecar file for each page and keeps the writes ordered so that nothing already on disk is lost.";

	it("a folder that has no section is not found", () => {
		const sections = folderSections("### `src/camera`\n\n" + good + "\n");
		expect(sections.map(s => s.folder)).toEqual(["src/camera"]);
		expect(sections.find(s => s.folder === "src/ink")).toBeUndefined();
	});

	it("a heading with no paragraph, or a paragraph naming no file of the folder, is thin", () => {
		expect(describesFolder({ folder: "src/persistence", body: "\n" }, root)).toBe(false);
		expect(describesFolder({ folder: "src/persistence", body: good.replace("PageStore.ts", "Nothing.ts") }, root)).toBe(false);
		expect(describesFolder({ folder: "src/camera", body: good }, root)).toBe(false);
		expect(describesFolder({ folder: "src/persistence", body: good }, root)).toBe(true);
	});

	it("the walk finds the real folders", () => {
		const folders = sourceFolders();
		expect(folders[0]).toBe("src");
		for (const f of ["src/ink", "src/inline", "src/pdf", "src/persistence"]) expect(folders).toContain(f);
	});
});

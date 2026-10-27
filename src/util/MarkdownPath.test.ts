/**
 * A note is a markdown file whatever the case of its extension (audit 195): Obsidian lower-cases
 * file.extension, so README.MD is a note, and every place that tests or strips ".md" has to agree.
 */
import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import { isMarkdownPath, stripMarkdownExtension } from "./MarkdownPath";

describe("markdown path helpers", () => {
	it("accepts .md in any case", () => {
		for (const p of ["a.md", "dir/README.MD", "b.Md", "c.mD"]) expect(isMarkdownPath(p), p).toBe(true);
	});
	it("refuses other extensions and a bare md", () => {
		for (const p of ["a.pdf", "a.md.bak", "md", "a.markdown", ""]) expect(isMarkdownPath(p), p).toBe(false);
	});
	it("strips only a trailing .md, in any case", () => {
		expect(stripMarkdownExtension("dir/README.MD")).toBe("dir/README");
		expect(stripMarkdownExtension("a.md")).toBe("a");
		expect(stripMarkdownExtension("a.md.bak")).toBe("a.md.bak");
		expect(stripMarkdownExtension("a.pdf")).toBe("a.pdf");
	});
});

// The whole source tree, read as text, the way InkSurfaceRules.test.ts reads it. This used to read
// three named files joined (main.ts, export/Snips.ts, commands/RegisterCommands.ts): every call that
// moved out of them was read by nobody, and the floor below sat at the count those three held. Reading
// the tree means a call site that moves is still counted wherever it lands.
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

// Production code only: tests and test helpers (any basename with ".test"), declaration files, and the
// helper module itself, which defines the functions rather than calling them. Comments are blanked, so a
// comment that quotes the bad form (MarkdownPath.ts's own header does) cannot trip the needle, and a
// comment that mentions a call cannot satisfy a floor.
const SCANNED = Object.keys(ALL_TS)
	.filter((f) => !f.endsWith(".d.ts") && !(f.split("/").pop() ?? "").includes(".test") && f !== "/src/util/MarkdownPath.ts")
	.sort();

/** Matches per scanned file, files with none left out. */
function perFile(needle: RegExp): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of SCANNED) {
		const n = codeOnly(ALL_TS[f]!).replace(/\r\n/g, "\n").match(needle)?.length ?? 0;
		if (n > 0) out[f] = n;
	}
	return out;
}
const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);
const show = (counts: Record<string, number>): string =>
	Object.entries(counts)
		.map(([f, n]) => `${f}: ${n}`)
		.join("; ") || "no file";

// The case-sensitive spellings: a test or a strip that only sees a lower-case ".md". The string forms
// take any quote kind (double, single, backtick); the regex form is the unflagged /\.md$/ literal.
const CASE_SENSITIVE_NEEDLES: readonly RegExp[] = [
	/endsWith\(["'`]\.md["'`]\)/g,
	/replace\(["'`]\.md["'`],/g,
	/replace\(\/\\\.md\$\/,/g,
];

describe("the tree uses the helpers", () => {
	it("read the source tree, not an empty scan", () => {
		// A glob that matched nothing would make every needle below pass by finding nothing.
		expect(SCANNED.length).toBeGreaterThan(100);
	});

	it("has no case-sensitive .md test or strip anywhere", () => {
		for (const needle of CASE_SENSITIVE_NEEDLES) {
			const found = perFile(needle);
			expect(Object.keys(found), `case-sensitive .md form ${needle} in: ${show(found)}`).toEqual([]);
		}
	});

	// A FLOOR, not an exact count: it says a call site was lost, and the message lists where the rest
	// are so the file that lost one is the one missing from the list. Four today: commands/RegisterCommands.ts
	// (two), export/Snips.ts, ink/RecycleOnDelete.ts. Raise it, with the reason in the commit, when a call
	// site is added; never lower it to make a red go away.
	it("strips the extension through stripMarkdownExtension at every call site", () => {
		const found = perFile(/stripMarkdownExtension\(/g);
		expect(sum(found), `stripMarkdownExtension( calls: ${show(found)}`).toBeGreaterThanOrEqual(4);
	});

	it("tests the extension through isMarkdownPath", () => {
		const found = perFile(/isMarkdownPath\(/g);
		expect(sum(found), `isMarkdownPath( calls: ${show(found)}`).toBeGreaterThanOrEqual(1);
	});

	it("the needles still match the forms they name", () => {
		// Pinned so a rewritten needle cannot make the cells above pass by matching nothing.
		const hit = (src: string): boolean => CASE_SENSITIVE_NEEDLES.some((n) => src.match(n) !== null);
		for (const bad of [
			'if (p.endsWith(".md")) return;',
			"if (p.endsWith('.md')) return;",
			"if (p.endsWith(`.md`)) return;",
			'const s = p.replace(/\\.md$/, "");',
			"const s = p.replace('.md', '');",
			'const s = p.replace(".md", "");',
		]) {
			expect(hit(bad), bad).toBe(true);
		}
		// The forms that are right: the case-insensitive regex, and other extensions.
		for (const good of ['p.replace(/\\.md$/i, "")', 'p.endsWith(".pdf")', "p.replace('.pdf', '')"]) {
			expect(hit(good), good).toBe(false);
		}
	});
});

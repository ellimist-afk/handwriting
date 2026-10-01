/**
 * A note is a markdown file whatever the case of its extension (audit 195): Obsidian lower-cases
 * file.extension, so README.MD is a note, and every place that tests or strips ".md" has to agree.
 */
import { describe, expect, it } from "vitest";
import mainSource from "../main.ts?raw";
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

describe("main.ts uses them", () => {
	const source = mainSource.replace(/\r\n/g, "\n");
	it("has no case-sensitive .md test or strip left", () => {
		expect(source).not.toMatch(/endsWith\("\.md"\)/);
		expect(source).not.toMatch(/replace\(\/\\.md\$\/,/);
	});
	it("routes the reading-view post-processor, snip and both exports through the helpers", () => {
		expect(source.match(/isMarkdownPath\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
		expect(source.match(/stripMarkdownExtension\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});
});

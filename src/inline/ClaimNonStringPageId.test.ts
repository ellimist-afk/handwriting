/**
 * A page id YAML reads as something other than text is
 * not adopted at claim. Obsidian's cache hands such a value to the id reads
 * as a boolean, null or number, and every read rejects it, so ink saved under
 * it was never found again. The claim writes a fresh id instead, the same rule
 * as a numeric id (Job1B_E_49 part B). The same value in quotes is text and
 * is kept. One cell per kind.
 */
import { describe, expect, it } from "vitest";
import { claimMarkdown } from "./InlineClaim";
import { parseMarkdownPage } from "../model/MarkdownPage";

const note = (value: string): string => `---\nhandwriting-page-id: ${value}\ntags: x\n---\nBody\n`;

describe("claimMarkdown and a page id YAML does not read as text", () => {
	it.each([
		["a boolean", "true"],
		["null", "null"],
		["a float written with an exponent", "1e5"],
		["an octal integer", "0o17"],
	])("replaces %s (%s) with a fresh id", (_kind, value) => {
		const md = note(value);
		expect(parseMarkdownPage(md).pageId, "the parser reports it as no id").toBeUndefined();
		const r = claimMarkdown(md, "fresh-id");
		expect(r.pageId).toBe("fresh-id");
		expect(r.changed).toBe(true);
		expect(r.content).toBe(note("fresh-id"));
	});

	it("control: the same value in quotes is text, and kept byte-untouched", () => {
		const md = note('"true"');
		const r = claimMarkdown(md, "fresh-id");
		expect(r).toEqual({ content: md, pageId: "true", changed: false });
	});
});

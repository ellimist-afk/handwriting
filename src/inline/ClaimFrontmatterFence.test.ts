/**
 * The first stroke on a note stamps `handwriting-page-id` into its
 * frontmatter through claimMarkdown. Its parser decides where the
 * frontmatter ends with `line.trim() === "---"`, so an INDENTED `---` counts
 * as a fence. hasFrontmatterBlock (the plugin's own guard, and YAML) does not.
 */
import { describe, expect, it } from "vitest";
import { claimMarkdown, hasFrontmatterBlock } from "./InlineClaim";

describe("claimMarkdown and an indented ---", () => {
	it("inside a block-scalar property: adds the id line and changes nothing else", () => {
		const md = "---\nnotes: |\n  ---\n  keep me\ntags: work\n---\nBody text\n";
		expect(hasFrontmatterBlock(md)).toBe(true);
		const r = claimMarkdown(md, "abc-123");
		// Today: "---\nnotes: |\nhandwriting-page-id: abc-123\n---\n  keep me\ntags: work\n---\nBody text\n"
		// - the frontmatter now ends early; `notes` and `tags` fall into the body.
		expect(r.content).toBe(
			"---\nnotes: |\n  ---\n  keep me\ntags: work\nhandwriting-page-id: abc-123\n---\nBody text\n"
		);
	});

	it("as the first line: body text is not pulled into the new frontmatter", () => {
		const md = "  ---\nMy paragraph\n---\nrest\n";
		expect(hasFrontmatterBlock(md)).toBe(false);
		const r = claimMarkdown(md, "abc-123");
		// Today: "---\nMy paragraph\nhandwriting-page-id: abc-123\n---\nrest\n"
		// - the paragraph is now (invalid) YAML, and the id inside it is unreadable.
		expect(r.content).toBe("---\nhandwriting-page-id: abc-123\n---\n" + md);
	});
});

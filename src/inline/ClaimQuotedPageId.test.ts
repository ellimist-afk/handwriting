/**
 * claimMarkdown's contract: "If the file turns out to already carry an id
 * ... that id WINS and the content comes back unchanged." The flat
 * frontmatter reader keeps YAML quotes and trailing comments as part of the
 * value, so a valid id written as `"<uuid>"`, `'<uuid>'` or `<uuid> # note`
 * fails isSafePageId and is REPLACED, which orphans that id's sidecar.
 * Obsidian's metadataCache (what notePageId reads) returns the bare uuid.
 */
import { describe, expect, it } from "vitest";
import { claimMarkdown } from "./InlineClaim";

const ID = "9201c8e4-1111-4222-8333-444455556666";

describe("claimMarkdown with an existing id written in other YAML forms", () => {
	it.each([`"${ID}"`, `'${ID}'`, `${ID} # do not edit`])("keeps %s", (value) => {
		const md = `---\nhandwriting-page-id: ${value}\n---\nbody\n`;
		const r = claimMarkdown(md, "fresh-id");
		expect(r.pageId).toBe(ID);
		expect(r.changed).toBe(false);
		expect(r.content).toBe(md);
	});
});

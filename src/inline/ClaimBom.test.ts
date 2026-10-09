import { describe, expect, it } from "vitest";
import { claimMarkdown } from "./InlineClaim";
import { parseMarkdownPage } from "../model/MarkdownPage";

describe("claimMarkdown on a UTF-8 BOM note with no frontmatter", () => {
	it("keeps the user's first line intact: no BOM stranded in the body", () => {
		const md = "﻿# Lecture 3\n\nNotes.\n";
		const r = claimMarkdown(md, "pid-bom");
		expect(r.changed).toBe(true);
		expect(parseMarkdownPage(r.content).pageId).toBe("pid-bom");
		expect(r.content).toBe("---\nhandwriting-page-id: pid-bom\n---\n# Lecture 3\n\nNotes.\n");
	});
});

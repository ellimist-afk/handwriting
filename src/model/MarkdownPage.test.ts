import { describe, expect, it } from "vitest";
import { composeMarkdownPage, parseMarkdownPage } from "./MarkdownPage";

/**
 * Image-block prose loss (ported from 1.5.0's box-marker-safety fix,
 * da1c161, image half only — the box half touches src/inline/BoxOrder.ts,
 * which does not exist on this branch).
 *
 * `parseMarkdownPage` used to find the embed by scanning the WHOLE joined
 * block body (`EMBED_RE.exec(body.join("\n"))`), then discard every other
 * line in the body once it found one. Harmless for a block the plugin wrote
 * (embed and nothing else), but:
 *
 *  - a closing marker torn off by a sync conflict/merge/outside edit makes
 *    the close-scan run to EOF, so `body` becomes the rest of the note and
 *    every other paragraph is deleted on the next compose;
 *  - a hand-typed caption inside the block dies the same way with no torn
 *    marker needed;
 *  - a two-line pseudo-embed (`![[a` / `b]]`) matched across the join,
 *    inventing a link target out of two of the user's lines while keeping
 *    neither.
 */

const wrap = (body: string[]) =>
	["---", "handwriting: page", "handwriting-page-id: p1", "---", "", ...body].join("\n");

describe("image block prose loss (torn markers, captions, pseudo-embeds)", () => {
	it("keeps every line after the embed when the closing marker is torn off", () => {
		// No "<!-- /handwriting:image -->" anywhere below: the close-scan runs
		// to EOF, so body is the embed line plus both prose paragraphs.
		const md = wrap([
			"<!-- handwriting:image id=im-1 -->",
			"![[cat.png]]",
			"",
			"First paragraph the user wrote after the image.",
			"",
			"Second paragraph, still theirs.",
		]);
		const parsed = parseMarkdownPage(md);
		expect(parsed.images).toEqual([{ id: "im-1", target: "cat.png" }]);
		expect(parsed.extra).toContain("First paragraph the user wrote after the image.");
		expect(parsed.extra).toContain("Second paragraph, still theirs.");

		// Round-trip: compose the parse back out, then parse that. Both
		// paragraphs must still be there, and now inside a well-formed file
		// (the compose step writes a proper closing marker for the image).
		const composed = composeMarkdownPage({
			pageId: "p1",
			frontmatter: parsed.frontmatter,
			blocks: parsed.blocks,
			images: parsed.images,
			extra: parsed.extra,
		});
		expect(composed).toContain("First paragraph the user wrote after the image.");
		expect(composed).toContain("Second paragraph, still theirs.");
		const reparsed = parseMarkdownPage(composed);
		expect(reparsed.images).toEqual([{ id: "im-1", target: "cat.png" }]);
		expect(reparsed.extra).toContain("First paragraph the user wrote after the image.");
		expect(reparsed.extra).toContain("Second paragraph, still theirs.");
	});

	it("finds the embed when it is NOT the first line of the block", () => {
		// The case every other fixture here misses: all of them put the embed
		// on body line 0, so a scan that always answered 0 would pass this
		// whole file. Found by mutating `embedLine` to a hard `0` during
		// review - four green, which is a test suite agreeing with itself.
		//
		// A caption typed ABOVE the embed is the ordinary way a real file
		// gets here, and the failure is quieter than the one this file was
		// written for: the prose still survives, but `EMBED_RE` is asked
		// about the wrong line, finds no target, and the whole block falls to
		// `extra` - so the IMAGE silently disappears from the page instead.
		const md = wrap([
			"<!-- handwriting:image id=im-1 -->",
			"A caption typed above it.",
			"![[cat.png]]",
			"<!-- /handwriting:image -->",
		]);
		const parsed = parseMarkdownPage(md);
		expect(parsed.images).toEqual([{ id: "im-1", target: "cat.png" }]);
		expect(parsed.extra).toContain("A caption typed above it.");
	});

	it("keeps a hand-typed caption beside the embed", () => {
		const md = wrap([
			"<!-- handwriting:image id=im-1 -->",
			"![[cat.png]]",
			"A caption I typed by hand.",
			"<!-- /handwriting:image -->",
		]);
		const parsed = parseMarkdownPage(md);
		expect(parsed.images).toEqual([{ id: "im-1", target: "cat.png" }]);
		expect(parsed.extra).toContain("A caption I typed by hand.");

		const composed = composeMarkdownPage({
			pageId: "p1",
			frontmatter: parsed.frontmatter,
			blocks: parsed.blocks,
			images: parsed.images,
			extra: parsed.extra,
		});
		expect(composed).toContain("A caption I typed by hand.");
	});

	it("leaves an ordinary well-formed block byte-identical (fix is inert on real files)", () => {
		// A block the plugin wrote: the embed and nothing else. Every line in
		// `body` is the embed line itself, so the fix's "keep every other
		// line" loop pushes nothing to extra — same output as before the fix.
		// Build the canonical file the same way the plugin itself would (via
		// composeMarkdownPage), then round-trip it: parsing and composing
		// again must reproduce those exact bytes.
		const canonical = composeMarkdownPage({
			pageId: "p1",
			frontmatter: ["handwriting: page"],
			blocks: [],
			images: [{ id: "im-1", target: "cat.png" }],
		});
		const parsed = parseMarkdownPage(canonical);
		expect(parsed.images).toEqual([{ id: "im-1", target: "cat.png" }]);
		expect(parsed.extra).toBe("");

		const composed = composeMarkdownPage({
			pageId: "p1",
			frontmatter: parsed.frontmatter,
			blocks: parsed.blocks,
			images: parsed.images,
			extra: parsed.extra,
		});
		expect(composed).toBe(canonical);
	});

	it("does not invent a link out of a two-line pseudo-embed, and keeps both lines", () => {
		// "![[a" and "b]]" only form a match when the whole body is joined
		// with "\n" and scanned as one string. Line-by-line, neither line
		// alone matches EMBED_RE, so this must fall through to extra intact.
		const md = wrap([
			"<!-- handwriting:image id=im-1 -->",
			"![[a",
			"b]]",
			"<!-- /handwriting:image -->",
		]);
		const parsed = parseMarkdownPage(md);
		expect(parsed.images).toEqual([]);
		expect(parsed.extra).toContain("![[a");
		expect(parsed.extra).toContain("b]]");

		const composed = composeMarkdownPage({
			pageId: "p1",
			frontmatter: parsed.frontmatter,
			blocks: parsed.blocks,
			images: parsed.images,
			extra: parsed.extra,
		});
		expect(composed).toContain("![[a");
		expect(composed).toContain("b]]");
	});
});

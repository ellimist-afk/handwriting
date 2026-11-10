/**
 * A target that starts or ends with whitespace is found again at reopen. Attach on a whole line takes the line from its
 * start to its end, indent and trailing spaces included; the stored text and its context are each collapsed to single
 * spaces, so the whitespace where they meet is one run in the document and must be matched once, over the context and
 * the target together. Pure functions; nothing is mounted.
 */
import { describe, expect, it } from "vitest";
import { resolveTarget, targetAt, type AttachmentTarget } from "./InkAttachments";

/** Three-line documents with the target line in the middle: its start and end as Attach takes a whole line. */
const CASES: Array<{ name: string; doc: string }> = [
	{ name: "a nested list item", doc: "- parent\n  - nested child\n- next" },
	{ name: "a tab-indented line", doc: "first\n\tchild text\nlast" },
	{ name: "a line with trailing spaces", doc: "first\nchild text   \nlast" },
];

function middleLine(doc: string): { from: number; to: number } {
	const from = doc.indexOf("\n") + 1;
	return { from, to: doc.indexOf("\n", from) };
}

describe("a target that starts or ends with whitespace is found again at reopen", () => {
	for (const { name, doc } of CASES) {
		it(`${name}, one character typed above it: found at its line`, () => {
			// Defect: the context's last space and the target's first are matched as two characters where the document has
			// one run, so the search finds nothing and the group needs reattachment.
			const { from, to } = middleLine(doc);
			const t = targetAt(doc, from, to, "paragraph");
			expect(resolveTarget(t, "x" + doc)).toEqual({ ...t, from: from + 1, to: to + 1 });
		});
	}

	it("a target as this version stored it before the fix: found at the same place", () => {
		// Defect: a fix that changes how targets are written finds only targets written after it.
		const stored: AttachmentTarget = { kind: "paragraph", from: 9, to: 25, text: " - nested child", before: "- parent ", after: " - next" };
		const doc = CASES[0]!.doc;
		const { from, to } = middleLine(doc);
		expect(resolveTarget(stored, "x" + doc)).toEqual({ ...stored, from: from + 1, to: to + 1 });
	});

	it("control: a plain paragraph with no edge whitespace is found after the same shift", () => {
		const doc = "first\nchild text\nlast";
		const t = targetAt(doc, 6, 16, "paragraph");
		expect(resolveTarget(t, "x" + doc)).toEqual({ ...t, from: 7, to: 17 });
	});

	it("control: a target whose text occurs twice with the same context is not found", () => {
		// Each copy sits between lines longer than the stored context, so both copies have the same text before and after.
		const fill = "a filler line longer than the stored context";
		const doc = `${fill}\n  - item\n${fill}\n  - item\n${fill}`;
		const first = fill.length + 1, second = doc.lastIndexOf("  - item");
		const t = targetAt(doc, first, first + 8, "paragraph");
		const u = targetAt(doc, second, second + 8, "paragraph");
		expect([u.text, u.before, u.after]).toEqual([t.text, t.before, t.after]);
		expect(resolveTarget(t, "x" + doc)).toBeNull();
	});

	it("control: a target whose context no longer matches is not found", () => {
		const doc = CASES[0]!.doc;
		const { from, to } = middleLine(doc);
		const t = targetAt(doc, from, to, "paragraph");
		expect(resolveTarget(t, "x" + doc.replace("parent", "others"))).toBeNull();
	});

	it("control: a target of only whitespace is not found", () => {
		const doc = "first\n   \nlast";
		const t = targetAt(doc, 6, 9, "paragraph");
		expect(resolveTarget(t, "x" + doc)).toBeNull();
	});
});

/**
 * refindInTables on the cell replace the app writes for a typed character (the app's record, changes/case-1-type.json: the cell's
 * whole span between its pipes replaced). Text
 * typed in front of the word keeps the target on the word; a rewrite that leaves the word in its cell keeps it there; the
 * word gone, its cell. A word the edit leaves at two places it cannot tell apart cannot be placed one to one: its cell
 * (a reading of the table rule's shape line).
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { mapTarget, refindInTables, type AttachmentRecord } from "./InkAttachments";

const HEAD = "Text above\n\n| Name | Note |\n| --- | --- |\n";
/** A note whose table's row 1 has `cell` in its Note column, and the offset of that cell's text. */
const noteWith = (cell: string) => {
	const doc = `${HEAD}| alpha | ${cell} |\n| delta | epsilon |\n\nText below\n`;
	return { doc, at: HEAD.length + "| alpha | ".length };
};
const record = (from: number, to: number, text: string): AttachmentRecord => ({
	v: 1, id: "att-1", strokeIds: ["s1"], target: { kind: "range", from, to, text, before: "", after: "" },
	ref: { x: 0, y: 0 }, layout: { width: 1180, font: 26 }, probe: { id: "s1", x: 0, y: 0 },
});

/** The cell `was` written as `now` by one replace of its whole span between the pipes; the target `word` (nth) in it. */
function refound(was: string, now: string, word: string, nth = 0) {
	const o = noteWith(was), n = noteWith(now);
	let i = -1;
	for (let k = 0; k <= nth; k++) i = was.indexOf(word, i + 1);
	if (i < 0) throw new Error(`premise: ${word} in ${was}`);
	const before = [record(o.at + i, o.at + i + word.length, word)];
	// The span between the pipes: one space each side, as the app's span " beta gamma   " (the pad is the trailing space).
	const changes = ChangeSet.of([{ from: o.at - 1, to: o.at + was.length + 1, insert: ` ${now} ` }], o.doc.length);
	expect(changes.apply(Text.of(o.doc.split("\n"))).toString(), "premise: the replace writes the new note").toBe(n.doc);
	const mapped = [{ ...before[0]!, target: mapTarget(before[0]!.target, changes) }];
	expect(mapped[0]!.target.from === mapped[0]!.target.to, "premise: the cell replace collapsed the target").toBe(true);
	const out = refindInTables(before, mapped, () => o.doc, () => n.doc, changes)[0] as AttachmentRecord;
	return n.doc.slice(out.target.from, out.target.to) + `@${out.target.from - n.at}`;
}

describe("refindInTables: text typed in front of a word, as the app writes it (the cell's whole span replaced)", () => {
	it("control: typed text that shares no letter with the word (\"huge \"): the word, moved by it", () => {
		expect(refound("beta gamma", "huge beta gamma", "beta")).toBe("beta@5");
	});
	it("\"big \" in front (shares beta's first letter): the word, moved by it", () => {
		expect(refound("beta gamma", "big beta gamma", "beta")).toBe("beta@4");
	});
	it("\"be \" in front (shares two letters): the word, moved by it", () => {
		expect(refound("beta gamma", "be beta gamma", "beta")).toBe("beta@3");
	});
	it("control: text typed after the word: the word where it was", () => {
		expect(refound("beta gamma", "beta big gamma", "beta")).toBe("beta@0");
	});
	it("control: the word itself edited: its cell", () => {
		expect(refound("beta gamma", "bexta gamma", "beta")).toBe("bexta gamma@0");
	});
	it("text deleted in front that shares the word's first letter (\"big \" taken out): the word, moved by it", () => {
		// At base the shared letter caps the suffix short of the word, so the word looks reached: the whole cell.
		expect(refound("big beta gamma", "beta gamma", "beta")).toBe("beta@0");
	});
	// The cell holds more than the word, so the whole-cell branch (the target was its cell's whole text) does not take it.
	it("the word left at two places the edit cannot tell apart (\"ab x\" to \"abab x\"): its cell, where base kept the first copy (\"ab@0\")", () => {
		expect(refound("ab x", "abab x", "ab")).toBe("abab x@0");
	});
});

/**
 * A target a change collapsed is found again only where that change put its words. A note with two weeks of the same
 * checklist holds the same words with the same context twice; the stored offsets pick the group's own week. When a
 * change rewrites the group's line (a list item moved by two replaces, a paste over the line, a replace over the
 * words), the other week's words become the one place holding the old text and context, and the group must not take
 * them: it stays Needs reattachment. Words the change itself put back (an undo of a delete, a cut line pasted, a moved
 * line whose context lies within it) are still taken. The overlay's editor update on a bare overlay over a fake view;
 * no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { mapTarget, refindCollapsed, resolveTarget, targetAt, type AttachmentData, type AttachmentRecord, type InsertedText } from "./InkAttachments";

const WATER = "- [ ] water plants", BANK = "- [ ] call the bank about the card", SAM = "- [ ] email Sam";
const WEEK = `${WATER}\n${BANK}\n${SAM}\n- [ ] buy milk\n`;
/** Two weeks with the same checklist: "bank" holds the same 32-character context in both. */
const DOC = `## Week 1\n${WEEK}\n## Week 2\n${WEEK}`;
const W1 = DOC.indexOf("bank"), W2 = DOC.indexOf("bank", W1 + 1);
const WATER1 = DOC.indexOf(WATER), BANK1 = DOC.indexOf(BANK), SAM1 = DOC.indexOf(SAM);

/** A long line whose target's context lies within it. */
const LONG = "Intro line here.\nA long line where the chemist wrote benzene beside the ring and kept going on.\nNext line one.\nNext line two.\nLast line.\n";
const BENZ = LONG.indexOf("benzene");
const LH = 30;

/** Week 1's "bank" line swapped with the line above it, by two replaces, as a list item moved up is written. */
const swapUp = (len: number) => ChangeSet.of([{ from: WATER1, to: WATER1 + WATER.length, insert: BANK }, { from: BANK1, to: BANK1 + BANK.length, insert: WATER }], len);

function rig(path: string, doc: string, groups: { id: string; from: number; to: number }[]) {
	const text = Text.of(doc.split("\n"));
	const records: AttachmentRecord[] = groups.map((g, i) => {
		const top = (text.lineAt(g.from).number - 1) * LH;
		return { v: 1, id: g.id, strokeIds: [`s${i + 1}`], target: targetAt(doc, g.from, g.to, "range"), ref: { x: 0, y: top }, layout: { width: 600, font: 16 }, probe: { id: `s${i + 1}`, x: 1, y: top + 10 } };
	});
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: records };
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: text };
	const view = { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: () => {}, followMoved: () => {} });
	const follow = overlay.lineAnchors.follow;
	follow.setList(inlineInk.attachments(path));
	for (const r of records) follow.attached(r, r.ref.y);
	/** One editor change; returns its inverse against the document before it, as CodeMirror's undo builds it. */
	const apply = (changes: ChangeSet): ChangeSet => {
		const startState = { doc: state.doc };
		const inverse = changes.invert(state.doc);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
		return inverse;
	};
	const find = (list: readonly AttachmentData[], id: string) => (list.find((a) => a.id === id) as AttachmentRecord).target;
	return {
		apply,
		follows: (id: string) => follow.followsText(id),
		/** The follow's target and the session's stored one, as offsets. */
		at: (id: string) => ({ from: find(follow.attachments, id).from, to: find(follow.attachments, id).to }),
		stored: (id: string) => ({ from: find(inlineInk.attachments(path), id).from, to: find(inlineInk.attachments(path), id).to }),
		doc: () => state.doc.toString(),
	};
}

/** Week 2's "bank" in the document now: the twin, never to be taken by week 1's group. */
const twin = (doc: string) => {
	const at = doc.lastIndexOf("bank");
	return { from: at, to: at + 4 };
};

/** The group is tagged, and neither its follow nor its stored target sits on week 2's word. */
function expectTaggedOffTwin(r: ReturnType<typeof rig>, id: string): void {
	const tw = twin(r.doc());
	expect(r.at(id), "the follow's target is not the twin").not.toEqual(tw);
	expect(r.stored(id), "the stored target is not the twin").not.toEqual(tw);
	expect(r.follows(id), "Needs reattachment").toBe(false);
	expect(r.at(id).from, "collapsed").toBe(r.at(id).to);
}

describe("a collapsed target is found again only where the change put its words", () => {
	it("premise: both weeks' words hold the same text and context, so the search alone finds neither", () => {
		const t = targetAt(DOC, W1, W1 + 4, "range");
		expect(targetAt(DOC, W2, W2 + 4, "range")).toEqual({ ...t, from: W2, to: W2 + 4 });
		expect(resolveTarget({ ...t, to: t.from }, DOC)).toBeNull();
	});

	it("week 1's line moved up by two replaces: the group stays tagged, off week 2's word", () => {
		const r = rig("refind-twin-up.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }]);
		r.apply(swapUp(DOC.length));
		expect(r.doc().startsWith(`## Week 1\n${BANK}\n${WATER}\n`), "premise: the line moved up").toBe(true);
		expectTaggedOffTwin(r, "x");
	});

	it("week 1's line moved down by two replaces: the group stays tagged, off week 2's word", () => {
		const r = rig("refind-twin-down.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }]);
		r.apply(ChangeSet.of([{ from: BANK1, to: BANK1 + BANK.length, insert: SAM }, { from: SAM1, to: SAM1 + SAM.length, insert: BANK }], DOC.length));
		expect(r.doc().startsWith(`## Week 1\n${WATER}\n${SAM}\n${BANK}\n`), "premise: the line moved down").toBe(true);
		expectTaggedOffTwin(r, "x");
	});

	it("the move undone: two places hold the words again, so the group stays tagged, never on week 2's word", () => {
		const r = rig("refind-twin-undo.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }]);
		const undo = r.apply(swapUp(DOC.length));
		r.apply(undo);
		expect(r.doc(), "premise: undone").toBe(DOC);
		expect(r.at("x"), "the follow's target is not the twin").not.toEqual({ from: W2, to: W2 + 4 });
		expect(r.stored("x"), "the stored target is not the twin").not.toEqual({ from: W2, to: W2 + 4 });
		expect(r.follows("x"), "tagged: two places match").toBe(false);
	});

	it("a line pasted over week 1's line, the word in new context: the group stays tagged, off week 2's word", () => {
		const r = rig("refind-twin-paste.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }]);
		r.apply(ChangeSet.of([{ from: BANK1, to: BANK1 + BANK.length, insert: "- [ ] call the bank about the loan" }], DOC.length));
		expectTaggedOffTwin(r, "x");
	});

	it("one replace over the words around the target: the group stays tagged, off week 2's word", () => {
		const r = rig("refind-twin-replace.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }]);
		const from = W1 - "the ".length, to = W1 + "bank about the card".length;
		r.apply(ChangeSet.of([{ from, to, insert: "the bank about the cards" }], DOC.length));
		expectTaggedOffTwin(r, "x");
	});

	it("a group on each week's word, week 1's line moved up: week 1's is tagged, week 2's stays on its word", () => {
		const r = rig("refind-twin-two.md", DOC, [{ id: "x", from: W1, to: W1 + 4 }, { id: "y", from: W2, to: W2 + 4 }]);
		r.apply(swapUp(DOC.length));
		const tw = twin(r.doc());
		expect(r.at("y"), "week 2's group on its word").toEqual(tw);
		expect(r.follows("y")).toBe(true);
		expect(r.at("x"), "never the same place").not.toEqual(r.at("y"));
		expect(r.stored("x")).not.toEqual(tw);
		expect(r.follows("x"), "Needs reattachment").toBe(false);
	});
});

describe("words the change itself put back are still found", () => {
	it("a delete with two cursors (the first word and the target) undone: found in the second inserted range", () => {
		const r = rig("refind-two-cursor-undo.md", LONG, [{ id: "x", from: BENZ, to: BENZ + 7 }]);
		const undo = r.apply(ChangeSet.of([{ from: 0, to: "Intro".length }, { from: BENZ, to: BENZ + 7 }], LONG.length));
		expect(r.follows("x"), "premise: deleted, tagged").toBe(false);
		r.apply(undo);
		expect(r.doc()).toBe(LONG);
		expect(r.follows("x")).toBe(true);
		expect(r.at("x")).toEqual({ from: BENZ, to: BENZ + 7 });
		expect(r.stored("x")).toEqual({ from: BENZ, to: BENZ + 7 });
	});

	it("a long line moved up by two replaces: the group follows its words to the moved line", () => {
		const r = rig("refind-long-up.md", LONG, [{ id: "x", from: BENZ, to: BENZ + 7 }]);
		const one = LONG.indexOf("\n"), two = LONG.indexOf("\n", one + 1);
		const first = LONG.slice(0, one), second = LONG.slice(one + 1, two);
		r.apply(ChangeSet.of([{ from: 0, to: one, insert: second }, { from: one + 1, to: two, insert: first }], LONG.length));
		const now = r.doc(), at = now.indexOf("benzene");
		expect(now.startsWith(second), "premise: moved up").toBe(true);
		expect(r.follows("x")).toBe(true);
		expect(r.at("x")).toEqual({ from: at, to: at + 7 });
	});

	it("two groups on one word, its line cut and pasted lower: both follow the pasted word", () => {
		const r = rig("refind-two-groups-paste.md", LONG, [{ id: "x", from: BENZ, to: BENZ + 7 }, { id: "y", from: BENZ, to: BENZ + 7 }]);
		const lineFrom = LONG.indexOf("A long line"), lineTo = LONG.indexOf("\n", lineFrom) + 1;
		const line = LONG.slice(lineFrom, lineTo);
		r.apply(ChangeSet.of([{ from: lineFrom, to: lineTo }], LONG.length));
		expect(r.follows("x") || r.follows("y"), "premise: cut, both tagged").toBe(false);
		const cut = r.doc(), at = cut.indexOf("Last line.");
		r.apply(ChangeSet.of([{ from: at, insert: line }], cut.length));
		const now = r.doc(), word = { from: now.indexOf("benzene"), to: now.indexOf("benzene") + 7 };
		expect(r.follows("x")).toBe(true);
		expect(r.follows("y")).toBe(true);
		expect(r.at("x")).toEqual(word);
		expect(r.at("y")).toEqual(word);
	});
});

describe("refindCollapsed takes a place only inside an inserted range", () => {
	const swap = swapUp(DOC.length);
	const doc = swap.apply(Text.of(DOC.split("\n"))).toString();
	const target = mapTarget(targetAt(DOC, W1, W1 + 4, "range"), swap);
	const list: AttachmentData[] = [{ v: 1, id: "x", strokeIds: ["s1"], target, ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } }];

	it("the moved line's ranges hold no place found: the same list comes back", () => {
		expect(target.from, "premise: collapsed").toBe(target.to);
		const inserted: InsertedText[] = [];
		swap.iterChanges((_fa, _ta, fb, tb, text) => { if (text.length > 0) inserted.push({ from: fb, to: tb, text: text.toString() }); });
		expect(inserted.some((t) => t.text.includes("bank")), "premise: the change inserts the word").toBe(true);
		expect(refindCollapsed(list, inserted, () => doc)).toBe(list);
	});

	it("a range that is exactly the place found: the target takes it", () => {
		const tw = twin(doc);
		const out = refindCollapsed(list, [{ ...tw, text: "bank" }], () => doc);
		expect(out).not.toBe(list);
		const t = (out[0] as AttachmentRecord).target;
		expect({ from: t.from, to: t.to }).toEqual(tw);
	});
});

/**
 * Undo of a deleted attached target brings the group back in the session. Deleting a target's text collapses it and
 * the group needs reattachment; the undo puts the same words back where they were, and the target takes them again,
 * with its old text and context, with no reopen. A line cut and pasted lower is found again the same way. The overlay's
 * editor update on a bare overlay over a fake view; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

/** The target's line is long, so its context lies within the line, as does the target. */
const DOC = "Intro line here.\nA long line where the chemist wrote benzene beside the ring and kept going on.\nNext line one.\nNext line two.\nLast line.\n";
const LH = 30;
const FROM = DOC.indexOf("benzene");

function rig(path: string) {
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, FROM, FROM + 7, "range"), ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record] };
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: () => {}, followMoved: () => {} });
	const follow = overlay.lineAnchors.follow;
	follow.setList(inlineInk.attachments(path));
	follow.attached(record, LH);
	/** One editor change; returns its inverse against the document before it, as CodeMirror's undo builds it. */
	const apply = (changes: ChangeSet): ChangeSet => {
		const startState = { doc: state.doc };
		const inverse = changes.invert(state.doc);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
		return inverse;
	};
	const target = () => (follow.attachments.find((a) => a.id === "att-1") as AttachmentRecord).target;
	return { apply, follow, target, doc: () => state.doc.toString() };
}

describe("undo of a deleted attached target brings the group back", () => {
	it("delete the target's word, then undo: the group follows the word again at its old place", () => {
		// Defect: the collapsed target maps past the reinserted word (from mapped with assoc 1), so it stays collapsed after
		// it and the group keeps its Needs reattachment tag until the note is reopened.
		const path = "attach-undo-delete.md";
		const r = rig(path);
		const undo = r.apply(ChangeSet.of([{ from: FROM, to: FROM + 7 }], DOC.length));
		expect(r.follow.followsText("att-1"), "premise: deleted, tagged").toBe(false);
		r.apply(undo);
		expect(r.doc()).toBe(DOC);
		expect(r.follow.followsText("att-1")).toBe(true);
		expect({ from: r.target().from, to: r.target().to }).toEqual({ from: FROM, to: FROM + 7 });
		const stored = inlineInk.attachments(path)[0] as AttachmentRecord;
		expect({ from: stored.target.from, to: stored.target.to }).toEqual({ from: FROM, to: FROM + 7 });
	});

	it("cut the target's line and paste it two lines lower: the group follows the pasted words", () => {
		// Defect: the cut collapses the target and nothing looks for its words again in the session.
		const path = "attach-cut-paste.md";
		const r = rig(path);
		const lineFrom = DOC.indexOf("A long line"), lineTo = DOC.indexOf("\n", lineFrom) + 1;
		const text = DOC.slice(lineFrom, lineTo);
		r.apply(ChangeSet.of([{ from: lineFrom, to: lineTo }], DOC.length));
		expect(r.follow.followsText("att-1"), "premise: cut, tagged").toBe(false);
		const cut = r.doc();
		const at = cut.indexOf("Last line.");
		r.apply(ChangeSet.of([{ from: at, insert: text }], cut.length));
		const now = r.doc();
		expect(r.follow.followsText("att-1")).toBe(true);
		expect(now.slice(r.target().from, r.target().to)).toBe("benzene");
		expect(r.target().from).toBe(now.indexOf("benzene"));
	});

	it("control: a delete with no undo leaves the group tagged", () => {
		const path = "attach-delete-only.md";
		const r = rig(path);
		r.apply(ChangeSet.of([{ from: FROM, to: FROM + 7 }], DOC.length));
		r.apply(ChangeSet.of([{ from: 0, insert: "more\n" }], DOC.length - 7));
		expect(r.follow.followsText("att-1")).toBe(false);
	});
});

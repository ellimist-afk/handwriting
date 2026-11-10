/**
 * Attached ink and text that moves. A group attached to a whole line keeps to its own words when the line moves: a move
 * that replaces the target's whole range with other words (Obsidian's list-aware Move line up/down swaps two lines by
 * two replaces) takes the target off, the same as a delete, so the group is found again by its words or marked, and
 * never re-hooks onto the neighbour's words. The overlay's editor update on a bare overlay over a fake view; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { resolveAttachments, targetAt, type AttachmentRecord } from "./InkAttachments";

const LH = 30;

/** The whole of the line holding `line` in `doc`, as Attach takes a paragraph: no line break. */
function lineRange(doc: string, line: string): { from: number; to: number } {
	const from = doc.indexOf(line);
	if (from < 0 || (from > 0 && doc[from - 1] !== "\n")) throw new Error(`no line ${line}`);
	return { from, to: from + line.length };
}

function rig(path: string, DOC: string, line: string) {
	const { from, to } = lineRange(DOC, line);
	const lines = Text.of(DOC.split("\n"));
	const top = lines.lineAt(from).number * LH - LH;
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, to, "paragraph"), ref: { x: 0, y: top }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: top + 10 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record] };
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: lines };
	const view = { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: () => {}, followMoved: () => {} });
	const follow = overlay.lineAnchors.follow;
	follow.setList(inlineInk.attachments(path));
	follow.attached(record, top);
	/** One editor change; returns its inverse against the document before it, as CodeMirror's undo builds it. */
	const apply = (changes: ChangeSet): ChangeSet => {
		const startState = { doc: state.doc };
		const inverse = changes.invert(state.doc);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
		return inverse;
	};
	const target = () => (follow.attachments.find((a) => a.id === "att-1") as AttachmentRecord).target;
	const stored = () => inlineInk.attachments(path)[0] as AttachmentRecord;
	const doc = () => state.doc.toString();
	/** What a reopen of the note as it is now resolves the stored record to: null when it needs reattachment. */
	const reopened = (): { from: number; to: number } | null => {
		const { list, status } = resolveAttachments(inlineInk.attachments(path).slice(), doc());
		if (status.get("att-1") !== "resolved") return null;
		const t = (list[0] as AttachmentRecord).target;
		return { from: t.from, to: t.to };
	};
	return { apply, follow, target, stored, doc, reopened };
}

/**
 * Obsidian's list-aware Move line up/down (Smart lists on): the two lines swap by two replaces in one change, each
 * line's range replaced by the other line's text.
 */
function swapLines(doc: string, upper: string, lower: string): ChangeSet {
	const u = lineRange(doc, upper), l = lineRange(doc, lower);
	return ChangeSet.of([{ from: u.from, to: u.to, insert: lower }, { from: l.from, to: l.to, insert: upper }], doc.length);
}

/** CodeMirror's Move line down for one line: the line below is deleted and put back above it. */
function moveLineDown(doc: string, line: string): ChangeSet {
	const at = lineRange(doc, line);
	const nextEnd = doc.indexOf("\n", at.to + 1);
	const next = doc.slice(at.to + 1, nextEnd < 0 ? doc.length : nextEnd);
	return ChangeSet.of([{ from: at.to, to: at.to + 1 + next.length }, { from: at.from, insert: next + "\n" }], doc.length);
}

describe("a moved line never hands its ink to the neighbour's words", () => {
	it("move an attached list item up: the group does not take the item now in its place", () => {
		// Defect: the swap replaces the target's range with the neighbour's text, the target keeps the range, and the
		// next refresh stores the neighbour's words as the target's; a reopen then resolves the group on them.
		const DOC = "- a\n- b\n- c\n";
		const r = rig("moved-swap-up.md", DOC, "- b");
		r.apply(swapLines(DOC, "- a", "- b"));
		expect(r.doc()).toBe("- b\n- a\n- c\n");
		expect(r.target().text).toBe("- b");
		expect(r.stored().target.text).toBe("- b");
		expect(r.follow.followsText("att-1")).toBe(false);
		expect(r.reopened()).toBeNull();
	});

	it("move an attached list item down: the same", () => {
		const DOC = "- a\n- b\n- c\n";
		const r = rig("moved-swap-down.md", DOC, "- b");
		r.apply(swapLines(DOC, "- b", "- c"));
		expect(r.doc()).toBe("- a\n- c\n- b\n");
		expect(r.target().text).toBe("- b");
		expect(r.stored().target.text).toBe("- b");
		expect(r.follow.followsText("att-1")).toBe(false);
		expect(r.reopened()).toBeNull();
	});

	it("control: a plain paragraph moved down by CodeMirror's move keeps its words and follows them", () => {
		const DOC = "First line here.\nThe attached line.\nThe line below.\nLast line.\n";
		const r = rig("moved-plain-down.md", DOC, "The attached line.");
		r.apply(moveLineDown(DOC, "The attached line."));
		const now = r.doc();
		expect(now).toBe("First line here.\nThe line below.\nThe attached line.\nLast line.\n");
		expect(r.follow.followsText("att-1")).toBe(true);
		expect(now.slice(r.target().from, r.target().to)).toBe("The attached line.");
	});

	it("control: rewriting the whole line with the same words finds it again where it is", () => {
		const DOC = "First line here.\nThe attached line.\nLast line.\n";
		const r = rig("moved-same-words.md", DOC, "The attached line.");
		const at = lineRange(DOC, "The attached line.");
		r.apply(ChangeSet.of([{ from: at.from, to: at.to, insert: "The attached line." }], DOC.length));
		expect(r.doc()).toBe(DOC);
		expect(r.follow.followsText("att-1")).toBe(true);
		expect({ from: r.target().from, to: r.target().to }).toEqual(at);
		expect(r.reopened()).toEqual(at);
	});

	it("control: typing a line above moves the target with its words", () => {
		const DOC = "First line here.\nThe attached line.\nLast line.\n";
		const r = rig("moved-typed-above.md", DOC, "The attached line.");
		r.apply(ChangeSet.of([{ from: 0, insert: "A new line.\n" }], DOC.length));
		const now = r.doc();
		expect(r.follow.followsText("att-1")).toBe(true);
		expect(r.target().from).toBe(now.indexOf("The attached line."));
		expect(now.slice(r.target().from, r.target().to)).toBe("The attached line.");
		expect(r.follow.groupOffset("att-1")?.dy).toBe(LH);
	});

	it("control: deleting the attached line then undoing it takes the line back", () => {
		const DOC = "First line here.\nThe attached line.\nLast line.\n";
		const r = rig("moved-delete-undo.md", DOC, "The attached line.");
		const at = lineRange(DOC, "The attached line.");
		const undo = r.apply(ChangeSet.of([{ from: at.from, to: at.to + 1 }], DOC.length));
		expect(r.follow.followsText("att-1"), "premise: deleted, marked").toBe(false);
		r.apply(undo);
		expect(r.doc()).toBe(DOC);
		expect(r.follow.followsText("att-1")).toBe(true);
		expect({ from: r.target().from, to: r.target().to }).toEqual(at);
	});
});

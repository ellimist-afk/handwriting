/**
 * The undo of a Detach after the note's text changed since: the group comes back on its words where they are now. A line
 * typed above in the other pane, or a change that is not in this pane's history, moves the words; the step that puts the
 * record back still holds the offsets of the Detach. If the words are gone, the group comes back as needing
 * reattachment and nothing moves. Two bare overlays on one note, each with its own fake view and editor history over the
 * real ink load; no DOM.
 */
import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { resolveAttachments, targetAt, type AttachmentRecord } from "./InkAttachments";

const DOC = "Intro line with many more words so the context ends here.\nParagraph A has its own words.\nParagraph B has other words.\nLast line.\n";
const LH = 30;
const ID = "att-detach-undo";
/** The line typed above the group. */
const TOP = "Top.\n";
/** A word inside paragraph B, and the longer one the other pane types over it. */
const OLD_WORD = "other";
const NEW_WORD = "some fresh";
/** A line typed directly above the target: inside its context, which a put-back record can then not be found by. */
const ABOVE = "A new line right above.\n";
/** Two lines typed at the top: the old offsets then fall on another line. */
const TWO_TOP = "Top.\nTop.\n";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** One pane over the note: its own editor state and history (the real inkHistorySupport), its own anchors, the store shared. */
function pane(path: string, focused: () => boolean) {
	let state = EditorState.create({ doc: DOC, extensions: [history(), inkHistorySupport()] });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null, focused);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		const startState = state;
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
		// A text change reaches the follow as the editor's update does (updateLineAnchors): moved by the change, then read.
		if (tr.docChanged) {
			overlay.followDocChanged(path, { changes: tr.changes, startState, state } as unknown as ViewUpdate);
			overlay.requestFollowMeasure();
		}
	};
	const view = {
		scaleY: 1,
		get state() { return state; },
		dispatch,
		viewport: { from: 0, to: DOC.length + 200 },
		lineBlockAt: (pos: number) => {
			const n = state.doc.lineAt(pos).number;
			return { from: state.doc.line(n).from, to: state.doc.line(n).to, top: n * LH - LH, bottom: n * LH };
		},
		coordsAtPos: (pos: number) => {
			const top = (state.doc.lineAt(pos).number - 1) * LH;
			return { left: 0, right: 0, top, bottom: top + LH };
		},
		// The measure runs its read and write at once.
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
		get hasFocus() { return focused(); },
		focus() {},
		dom: { isConnected: true, ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame() {} } } },
	};
	Object.assign(overlay, {
		view, fontZoom: 1, lineAnchorState: anchors, selection: new SelectionModel(),
		// A resting pane: no pinch held, zoom 1, no pan. The follow read refuses a held pinch, so these must be set.
		pinchRefScale: null, pinchPreview: false, pinchScaleNow: 1, cssScale: 1, scale: 1, inkInputPanX: () => 0, inkInputPanY: () => 0,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600 }) },
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path, lineAnchorsMoved() {}, followMoved() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
		adoptStoredFontRef() {}, lineAnchorPassTimer: 0, lineDrawnAt: 0,
	});
	// The ink load's quiet-pass timer is never let fire here.
	Object.assign(overlay.winRef, { setTimeout: () => 1, clearTimeout() {} });
	anchors.tracks(path, inlineInk.strokes(path));
	const store = (id = "s1") => inlineInk.strokes(path).find((s) => s.id === id)!;
	return {
		overlay, anchors,
		get doc() { return state.doc; },
		dispatch,
		run: (c: StateCommand) => c({ state, dispatch }),
		redraw: () => overlay.attachedGroups(path),
		/** Where this pane shows a stroke's first point, after a redraw. */
		shown: (id = "s1") => {
			overlay.attachedGroups(path);
			const p = anchors.shownOf(store(id)).points[0]!;
			return { x: p.x, y: p.y };
		},
		/** A stroke's first point as stored. */
		stored: (id = "s1") => ({ x: store(id).points[0]!.x, y: store(id).points[0]!.y }),
		/** A paragraph's target, and its words' place read as Attach reads it. */
		para: (n: number) => {
			const line = state.doc.line(n);
			return { target: targetAt(state.doc.toString(), line.from, line.to, "paragraph"), ref: overlay.followRefAt(line.from)! };
		},
		follows: (id = ID) => anchors.follow.followsText(id),
	};
}

/**
 * The note with one free stroke on paragraph B, open in panes A and B. A attaches it to paragraph B (line 3), then
 * detaches it; the store holds no record of it after. B is told of each step as a redraw. `held`: a second group the
 * file already holds, its stroke s2 on paragraph A, its words in no line of the text, so both panes hold it from the load.
 */
function attachedThenDetached(path: string, held?: AttachmentRecord) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.strokes = held ? [strokeAt("s1", 1, 66), strokeAt("s2", 1, 36)] : [strokeAt("s1", 1, 66)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	rec.basePage = { ...emptyPage(rec.pageId), attachments: held ? [held] : [] };
	const focus = { on: "a" as "a" | "b" };
	const a = pane(path, () => focus.on === "a"), b = pane(path, () => focus.on === "b");
	a.overlay.lineAnchorInkLoaded(path);
	b.overlay.lineAnchorInkLoaded(path);
	a.redraw();
	b.redraw();
	const p = a.para(3);
	a.overlay.attachAt(path, ID, ["s1"], p.target, p.ref);
	b.redraw();
	const attached = inlineInk.attachments(path).find((x) => x.id === ID) as AttachmentRecord;
	expect(attached?.target.text, "premise: attached to paragraph B").toBe(p.target.text);
	expect(a.overlay.detachAttachment(path, ID), "the Detach ran").toBe(true);
	b.redraw();
	expect(inlineInk.attachments(path).filter((x) => x.id === ID), "premise: no record after the Detach").toEqual([]);
	return { a, b, focus, path, attached };
}

/** One text change typed in `from`'s pane and carried to the other pane's editor, as two panes on one note are kept. */
function typeIn(from: ReturnType<typeof pane>, to: ReturnType<typeof pane>, spec: { from: number; to?: number; insert: string }): void {
	from.dispatch({ changes: spec });
	to.dispatch({ changes: spec, annotations: Transaction.addToHistory.of(false) });
}

const at = (r: AttachmentRecord | undefined) => r && { from: r.target.from, to: r.target.to, text: r.target.text };

const HELD = "att-held-before";
/** A group the file holds on paragraph A (line 2), its words in no line of DOC: held from the load. */
const heldRecord = (): AttachmentRecord => ({
	v: 1, id: HELD, strokeIds: ["s2"],
	target: { kind: "paragraph", from: 58, to: 88, text: "Words that are not in the note.", before: "", after: "" },
	ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s2", x: 1, y: 40 },
});

describe("the undo of a Detach after the text changed", () => {
	it("two panes: Detach in A, a line typed above in B, undo in A puts the group back on its words", () => {
		const r = attachedThenDetached("undo-detach-after-typing-ab.md");
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.focus.on = "a";
		const stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(now.text, "premise: paragraph B is line 4 after the typing").toBe(r.attached.target.text);
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		r.a.redraw();
		expect.soft(r.a.follows(), "A follows its words").toBe(true);
		expect.soft(r.a.shown(), "the ink shows on its words, one line lower").toEqual({ x: stored.x, y: stored.y + LH });
	});

	it("one pane: a change not in its history between the Detach and the undo, the group back on its words", () => {
		const r = attachedThenDetached("undo-detach-after-outside-change.md");
		r.a.dispatch({ changes: { from: 0, insert: TOP }, annotations: Transaction.addToHistory.of(false) });
		const stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		r.a.redraw();
		expect.soft(r.a.follows(), "A follows its words").toBe(true);
		expect.soft(r.a.shown(), "the ink shows on its words, one line lower").toEqual({ x: stored.x, y: stored.y + LH });
	});

	it("control: one pane, nothing changed between, the undo puts back the record as it was", () => {
		const r = attachedThenDetached("undo-detach-unchanged.md");
		const shown = r.a.shown();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(inlineInk.attachments(r.path), "the record as it was at the Detach").toEqual([r.attached]);
		r.a.redraw();
		expect.soft(r.a.follows(), "A follows its words").toBe(true);
		expect.soft(r.a.shown(), "the ink shows where it was").toEqual(shown);
	});

	it("control: the words changed in B, the undo in A puts the group back as needing reattachment and nothing moves", () => {
		const r = attachedThenDetached("undo-detach-after-word-edit.md");
		r.focus.on = "b";
		const w = r.attached.target.from + r.attached.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: w, to: w + OLD_WORD.length, insert: NEW_WORD });
		r.focus.on = "a";
		const shown = r.a.shown(), stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(inlineInk.attachments(r.path).length, "premise: the record is back").toBe(1);
		expect(resolveAttachments([...inlineInk.attachments(r.path)], r.a.doc.toString()).status.get(ID), "premise: its words are nowhere in the text").toBe("needs-reattachment");
		r.a.redraw();
		expect.soft(r.a.follows(), "A holds the group: it needs reattachment").toBe(false);
		expect.soft(r.a.shown(), "the ink shows where it was").toEqual(shown);
		expect.soft(r.a.stored(), "the ink is stored where it was").toEqual(stored);
	});

	it("two panes: after the undo in A puts the group back on its words, the redo in A takes the record away and nothing moves", () => {
		const r = attachedThenDetached("undo-redo-detach-after-typing-ab.md");
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "premise: the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		const shown = r.a.shown();
		expect(r.a.run(redo), "the redo ran").toBe(true);
		expect(inlineInk.attachments(r.path), "the redo of the Detach takes the record away").toEqual([]);
		r.a.redraw();
		expect.soft(r.a.follows(), "A no longer follows: the group is free ink").toBe(false);
		expect.soft(r.a.shown(), "the ink shows where it was").toEqual(shown);
		expect.soft(r.a.stored(), "the ink is stored where it shows").toEqual(shown);
		expect(r.a.run(undo), "the second undo ran").toBe(true);
		expect.soft(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "the second undo puts the record back on its words").toEqual({ from: now.from, to: now.to, text: now.text });
	});

	it("one pane: a change not in its history, then the undo and the redo of the Detach, the redo takes the record away and nothing moves", () => {
		const r = attachedThenDetached("undo-redo-detach-after-outside-change.md");
		r.a.dispatch({ changes: { from: 0, insert: TOP }, annotations: Transaction.addToHistory.of(false) });
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "premise: the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		const shown = r.a.shown();
		expect(r.a.run(redo), "the redo ran").toBe(true);
		expect(inlineInk.attachments(r.path), "the redo of the Detach takes the record away").toEqual([]);
		r.a.redraw();
		expect.soft(r.a.follows(), "A no longer follows: the group is free ink").toBe(false);
		expect.soft(r.a.shown(), "the ink shows where it was").toEqual(shown);
		expect.soft(r.a.stored(), "the ink is stored where it shows").toEqual(shown);
	});

	it("control: the words gone, a second group held before the undo stays held and does not move when a line is typed above", () => {
		const r = attachedThenDetached("undo-detach-gone-other-held.md", heldRecord());
		r.a.redraw();
		expect(r.a.follows(HELD), "premise: A holds the second group from the load").toBe(false);
		r.focus.on = "b";
		const w = r.attached.target.from + r.attached.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: w, to: w + OLD_WORD.length, insert: NEW_WORD });
		r.focus.on = "a";
		const shown = r.a.shown("s2"), stored = r.a.stored("s2");
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(resolveAttachments([...inlineInk.attachments(r.path)], r.a.doc.toString()).status.get(ID), "premise: the first group's words are nowhere in the text").toBe("needs-reattachment");
		r.a.redraw();
		expect(r.a.follows(ID), "premise: A holds the first group").toBe(false);
		expect.soft(r.a.follows(HELD), "A still holds the second group").toBe(false);
		r.a.dispatch({ changes: { from: 0, insert: TOP } });
		r.a.redraw();
		expect.soft(r.a.follows(HELD), "A still holds the second group after the line typed above").toBe(false);
		expect.soft(r.a.shown("s2"), "the second group's ink shows where it was").toEqual(shown);
		expect.soft(r.a.stored("s2"), "the second group's ink is stored where it was").toEqual(stored);
	});

	it("two panes: a line typed directly above the target in B, the undo in A puts the group back on its words", () => {
		const r = attachedThenDetached("undo-detach-line-right-above-ab.md");
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: r.attached.target.from, insert: ABOVE });
		r.focus.on = "a";
		const stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(now.text, "premise: paragraph B is line 4 after the typing").toBe(r.attached.target.text);
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		expect((inlineInk.attachments(r.path)[0] as AttachmentRecord).target.before, "its context is read again from the text now").toBe(now.before);
		r.a.redraw();
		expect.soft(r.a.follows(), "A follows its words").toBe(true);
		expect.soft(r.a.shown(), "the ink shows on its words, one line lower").toEqual({ x: stored.x, y: stored.y + LH });
		expect(r.a.run(redo), "the redo ran").toBe(true);
		expect.soft(inlineInk.attachments(r.path), "the redo of the Detach takes the record away").toEqual([]);
	});

	it("one pane: a change not in its history typed directly above the target, the undo puts the group back on its words", () => {
		const r = attachedThenDetached("undo-detach-outside-line-right-above.md");
		r.a.dispatch({ changes: { from: r.attached.target.from, insert: ABOVE }, annotations: Transaction.addToHistory.of(false) });
		const stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		const now = r.a.para(4).target;
		expect(at(inlineInk.attachments(r.path)[0] as AttachmentRecord), "the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		r.a.redraw();
		expect.soft(r.a.follows(), "A follows its words").toBe(true);
		expect.soft(r.a.shown(), "the ink shows on its words, one line lower").toEqual({ x: stored.x, y: stored.y + LH });
	});

	it("two panes: the words gone and two lines typed at the top in B, the undo in A: B holds the group too and nothing in B moves", () => {
		const r = attachedThenDetached("undo-detach-gone-b-holds.md");
		r.focus.on = "b";
		const w = r.attached.target.from + r.attached.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: w, to: w + OLD_WORD.length, insert: NEW_WORD });
		typeIn(r.b, r.a, { from: 0, insert: TWO_TOP });
		r.focus.on = "a";
		const shownB = r.b.shown(), storedB = r.b.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(inlineInk.attachments(r.path).length, "premise: the record is back").toBe(1);
		r.a.redraw();
		expect(r.a.follows(), "premise: A holds the group").toBe(false);
		r.b.redraw();
		expect(r.b.follows(), "B holds the group: its words are not in B's text").toBe(false);
		expect.soft(r.b.shown(), "B shows the ink where it was").toEqual(shownB);
		expect.soft(r.b.stored(), "the ink is stored where it was").toEqual(storedB);
	});

	it("the words gone, B holds the group, then a line typed at the top in B: B still holds it and its ink stays", () => {
		const r = attachedThenDetached("undo-detach-gone-b-types.md");
		r.focus.on = "b";
		const w = r.attached.target.from + r.attached.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: w, to: w + OLD_WORD.length, insert: NEW_WORD });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		r.a.redraw();
		r.b.redraw();
		expect(r.b.follows(), "premise: B holds the group").toBe(false);
		const shownB = r.b.shown();
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.b.redraw();
		expect(r.b.follows(), "B still holds the group after its own change: its words are still gone").toBe(false);
		expect.soft(r.b.shown(), "B shows the ink where it was").toEqual(shownB);
	});

	it("control: the target's words edited and its old words typed once elsewhere, the undo holds the group and nothing moves", () => {
		const r = attachedThenDetached("undo-detach-words-edited-copy-elsewhere.md");
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: r.b.doc.length, insert: `${r.attached.target.text}\n` });
		const w = r.attached.target.from + r.attached.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: w, to: w + OLD_WORD.length, insert: NEW_WORD });
		r.focus.on = "a";
		expect(r.a.doc.toString().split(r.attached.target.text).length - 1, "premise: the old words stand once in the text, on another line").toBe(1);
		const shown = r.a.shown(), stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(inlineInk.attachments(r.path).length, "premise: the record is back").toBe(1);
		expect(resolveAttachments([...inlineInk.attachments(r.path)], r.a.doc.toString()).status.get(ID), "premise: found nowhere by its words and context").toBe("needs-reattachment");
		r.a.redraw();
		expect.soft(r.a.follows(), "A holds the group: it needs reattachment").toBe(false);
		expect.soft(r.a.shown(), "the ink shows where it was").toEqual(shown);
		expect.soft(r.a.stored(), "the ink is stored where it was").toEqual(stored);
	});

	it("two panes: the undo in A, then a line typed above in A that B hears after A shares the list: B follows the group", () => {
		const r = attachedThenDetached("undo-detach-b-behind-at-share.md");
		const stored = r.a.stored();
		expect(r.a.run(undo), "the undo ran").toBe(true);
		r.a.redraw();
		expect(r.a.follows(), "premise: A follows the group after the undo").toBe(true);
		expect(r.b.anchors.follow.attachments.some((x) => x.id === ID), "premise: B has not taken the record before the share").toBe(false);
		r.a.dispatch({ changes: { from: 0, insert: TOP } });
		expect(r.b.doc.length, "premise: B's text is one change behind when A shares the list").toBe(r.a.doc.length - TOP.length);
		r.b.dispatch({ changes: { from: 0, insert: TOP }, annotations: Transaction.addToHistory.of(false) });
		r.b.redraw();
		expect(r.b.follows(), "B follows the group once it hears the change").toBe(true);
		expect.soft(r.b.shown(), "B shows the ink on its words, one line lower").toEqual({ x: stored.x, y: stored.y + LH });
	});
});

/**
 * A note opened in two panes whose attached group lost its words, so it opens on hold in both. Attach in one pane, a line
 * typed above the group in the other, then the undo of the Attach in the first: the hold comes back, in the pane that
 * undid and in the other. The text change moved the group's new target after the Attach, so the undo finds the record at
 * a target other than the one its step left. Two bare overlays on one note, each with its own fake view and editor
 * history over the real ink load; no DOM.
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
import { resolveAttachments, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const DOC = "Intro line with many more words so the context ends here.\nParagraph A has its own words.\nParagraph B has other words.\nLast line.\n";
const LH = 30;
const ID = "att-two-panes";
const GONE = "Paragraph A has its own words.";
const WORDS = "Words cut from the note since.";
/** The line typed above the group in the other pane. */
const TOP = "Top.\n";
/** A word inside paragraph B, and the longer one the other pane types over it. */
const OLD_WORD = "other";
const NEW_WORD = "some fresh";

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
	const store = () => inlineInk.strokes(path).find((s) => s.id === "s1")!;
	return {
		overlay, anchors,
		get doc() { return state.doc; },
		dispatch,
		run: (c: StateCommand) => c({ state, dispatch }),
		/** This pane's redraw: its groups through attachedGroups, as its paint takes the list. */
		redraw: () => overlay.attachedGroups(path),
		/** Where this pane shows the stroke's first point, after a redraw. */
		shown: () => {
			overlay.attachedGroups(path);
			const p = anchors.shownOf(store()).points[0]!;
			return { x: p.x, y: p.y };
		},
		/** A paragraph's target, and its words' place read as Attach reads it. */
		para: (n: number) => {
			const line = state.doc.line(n);
			return { target: targetAt(state.doc.toString(), line.from, line.to, "paragraph"), ref: overlay.followRefAt(line.from)! };
		},
		follows: () => anchors.follow.followsText(ID),
	};
}

/**
 * The note saved with the group on words since cut from it: the stored record's target is nowhere in the text, so the ink
 * load holds it in each pane. Pane B has focus unless told otherwise.
 */
function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.strokes = [strokeAt("s1", 1, 36)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const cut = DOC.replace(GONE, WORDS);
	const from = cut.indexOf(WORDS), to = from + WORDS.length;
	const stale: AttachmentRecord = { v: 1, id: ID, strokeIds: ["s1"], target: targetAt(cut, from, to, "paragraph"), ref: { x: 0, y: 30 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [stale] };
	const focus = { on: "b" as "a" | "b" };
	const a = pane(path, () => focus.on === "a"), b = pane(path, () => focus.on === "b");
	a.overlay.lineAnchorInkLoaded(path);
	b.overlay.lineAnchorInkLoaded(path);
	a.redraw();
	b.redraw();
	return { a, b, focus, stale, path };
}

/** One text change typed in `from`'s pane and carried to the other pane's editor, as two panes on one note are kept. */
function typeIn(from: ReturnType<typeof pane>, to: ReturnType<typeof pane>, spec: { from: number; to?: number; insert: string }): void {
	from.dispatch({ changes: spec });
	to.dispatch({ changes: spec, annotations: Transaction.addToHistory.of(false) });
}

describe("undo of an Attach after a text change", () => {
	it("one pane: Attach in A, type above in B, undo in A puts the hold back in A", () => {
		const r = rig("undo-attach-after-typing-a.md");
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		expect(r.a.follows(), "A follows after the Attach").toBe(true);
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		// The held record comes back as the note's list would hold it had it stayed: its target moved by the line typed above.
		const moved = { ...r.stale, target: { ...r.stale.target, from: r.stale.target.from + TOP.length, to: r.stale.target.to + TOP.length } };
		expect.soft(inlineInk.attachments(r.path), "the store holds the held record, moved by the typing, after the undo").toEqual([moved]);
		r.a.redraw();
		expect.soft(r.a.follows(), "hold back in A").toBe(false);
	});

	it("two panes: Attach in A, type above in B, undo in A puts the hold back in both", () => {
		const r = rig("undo-attach-after-typing-ab.md");
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		r.b.redraw();
		expect(r.b.follows(), "B follows after the Attach").toBe(true);
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		r.a.redraw();
		r.b.redraw();
		expect.soft(r.a.follows(), "hold back in A").toBe(false);
		expect.soft(r.b.follows(), "hold back in B").toBe(false);
	});

	it("two panes: the redo after that undo attaches again at the paragraph where the typing moved it", () => {
		const r = rig("redo-attach-after-typing-ab.md");
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		r.b.redraw();
		r.focus.on = "b";
		typeIn(r.b, r.a, { from: 0, insert: TOP });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		expect(r.a.run(redo), "the redo ran").toBe(true);
		const now = r.a.para(4).target;
		expect.soft(now.text, "premise: paragraph B is line 4 after the typing").toBe(p.target.text);
		const got = inlineInk.attachments(r.path)[0] as AttachmentRecord;
		expect.soft({ from: got.target.from, to: got.target.to, text: got.target.text }, "the record is on paragraph B where it is now").toEqual({ from: now.from, to: now.to, text: now.text });
		r.a.redraw();
		r.b.redraw();
		expect.soft(r.a.follows(), "A follows again").toBe(true);
		expect.soft(r.b.follows(), "B follows again").toBe(true);
	});
});

describe("redo of an Attach after the words changed in the other pane", () => {
	/** Attach in A on paragraph B, then in B a word inside it changed for a longer one: the offsets move and the words too. */
	function editedThenUndone(path: string) {
		const r = rig(path);
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		r.b.redraw();
		r.focus.on = "b";
		const at = p.target.from + p.target.text.indexOf(OLD_WORD);
		typeIn(r.b, r.a, { from: at, to: at + OLD_WORD.length, insert: NEW_WORD });
		r.focus.on = "a";
		expect(r.a.run(undo), "the undo ran").toBe(true);
		return r;
	}

	it("the undo puts back the held record with its stored words", () => {
		const r = editedThenUndone("undo-attach-after-word-edit.md");
		expect.soft(inlineInk.attachments(r.path), "the held record as stored, words and context unread").toEqual([r.stale]);
	});

	it("the redo saves the words the paragraph has now, and a reopen finds the group attached", () => {
		const r = editedThenUndone("redo-attach-after-word-edit.md");
		expect(r.a.run(redo), "the redo ran").toBe(true);
		const now = r.a.para(3).target;
		expect.soft(now.text.includes(NEW_WORD), "premise: the paragraph holds the new word").toBe(true);
		const got = inlineInk.attachments(r.path)[0] as AttachmentRecord;
		expect.soft(got.target, "the saved target is the paragraph as it reads now").toEqual(now);
		const reopened = resolveAttachments([...inlineInk.attachments(r.path)], r.a.doc.toString());
		expect.soft(reopened.status.get(ID), "a reopen finds the group").toBe("resolved");
	});
});

/**
 * A note opened in two panes whose attached group lost its words, so it opens on hold in both. An Attach in one pane
 * ends the hold in the other as well: that pane's ink follows its text and shows no "Needs reattachment" tag. The undo
 * of the Attach puts the hold back in both. A synced copy adopted once the words are back is the fresh truth: the group
 * follows its words, whatever an earlier Attach and its undo left behind. Two bare overlays on one note, each with its
 * own fake view and editor history over the real ink load, Attach and undo; no DOM.
 */
import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { InkOverlayPlugin } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const DOC = "Intro line with many more words so the context ends here.\nParagraph A has its own words.\nParagraph B has other words.\nLast line.\n";
const LH = 30;
const ID = "att-two-panes";
const GONE = "Paragraph A has its own words.";
const WORDS = "Words cut from the note since.";

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

const close = (got: { x: number; y: number }, want: { x: number; y: number }, what: string) => {
	expect(got.x, `${what} x`).toBeCloseTo(want.x, 9);
	expect(got.y, `${what} y`).toBeCloseTo(want.y, 9);
};

describe("a group on hold in two panes on one note", () => {
	it("Attach in pane A, type a line above in pane B: B follows its text and shows no tag", () => {
		// Defect: B learns of A's Attach only through a list with no status, which keeps B's hold, so B shows the tag and
		// its ink stays put while the text moves.
		const r = rig("attach-hold-two-panes-follow.md");
		expect(r.a.follows(), "premise: on hold in A at load").toBe(false);
		expect(r.b.follows(), "premise: on hold in B at load").toBe(false);
		const at = r.b.shown();
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		expect(r.a.follows(), "premise: attached in A, it follows its text in A").toBe(true);
		r.b.redraw();
		expect(r.b.follows(), "B follows its text after the Attach in A: no tag").toBe(true);
		close(r.b.shown(), at, "B's ink stays put at the Attach");
		r.focus.on = "b";
		const line = r.b.doc.line(3);
		typeIn(r.b, r.a, { from: line.from, insert: "A new line typed above.\n" });
		close(r.b.shown(), { x: at.x, y: at.y + LH }, "B's ink moves down one line with its words");
		close(r.a.shown(), { x: at.x, y: at.y + LH }, "A's ink moves down one line with its words");
	});

	it("the undo of the Attach in pane A puts the hold back in both panes", () => {
		const r = rig("attach-hold-two-panes-undo.md");
		const at = r.b.shown();
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		r.b.redraw();
		expect(r.b.follows(), "premise: B follows after the Attach in A").toBe(true);
		expect(r.a.run(undo)).toBe(true);
		expect(inlineInk.attachments(r.path), "the undo puts the old record back, and only it").toEqual([r.stale]);
		r.b.redraw();
		expect(r.a.follows(), "the undo puts the hold back in A").toBe(false);
		expect(r.b.follows(), "the undo puts the hold back in B").toBe(false);
		close(r.a.shown(), at, "A's ink stays put at the undo");
		close(r.b.shown(), at, "B's ink stays put at the undo");
	});

	it("words typed back after the Attach and its undo: a synced copy adopted then follows its words", () => {
		// Defect: the Attach's record of the hold it ended outlives the undo, and puts the hold back over the adoption's
		// fresh finding that the words are in the text.
		const r = rig("attach-hold-adopted-after-undo.md");
		const p = r.a.para(3);
		r.focus.on = "a";
		r.a.overlay.attachAt(r.path, ID, ["s1"], p.target, p.ref);
		expect(r.a.run(undo)).toBe(true);
		expect(r.a.follows(), "premise: the undo puts the hold back").toBe(false);
		const line = r.a.doc.line(2);
		expect(line.text, "premise: the stored words are not in the text").toBe(GONE);
		typeIn(r.a, r.b, { from: line.from, to: line.to, insert: WORDS });
		// A synced copy of the note's ink, the same record in it, is adopted: its list is found again in the text.
		const copy = JSON.parse(JSON.stringify(inlineInk.attachments(r.path))) as AttachmentData[];
		expect(copy, "premise: the copy holds the same record").toEqual(inlineInk.attachments(r.path));
		inlineInk.setAttachments(r.path, copy, false);
		r.a.overlay.noteExternallyReloaded(r.path);
		expect(r.a.follows(), "the adopted group follows its words in A").toBe(true);
	});

	it("control: a group never on hold, attached in pane A, follows in pane B", () => {
		const path = "attach-hold-two-panes-control.md";
		const rec = inlineInk.record(path);
		rec.pageId = `page-${path}`;
		rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
		rec.strokes = [strokeAt("s1", 1, 36)];
		const a = pane(path, () => true), b = pane(path, () => false);
		a.overlay.lineAnchorInkLoaded(path);
		b.overlay.lineAnchorInkLoaded(path);
		const p = a.para(3);
		a.overlay.attachAt(path, ID, ["s1"], p.target, p.ref);
		b.redraw();
		expect(b.follows(), "B follows a group attached in A").toBe(true);
	});
});

/**
 * The undo of a "change attachment" puts the group back on its first paragraph, and the ink stays where it is shown: at
 * the step, at the step's own read, and at the next edit of the note, on screen and in the saved page. A group whose
 * words were gone when the note opened needs reattachment again after the undo of its Attach, and not after the redo.
 * One bare overlay over a fake view whose line tops follow its document, with the real editor history; no DOM.
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
const ID = "att-change";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** One pane over the note: its own editor state and history (the real inkHistorySupport), its own anchors. */
function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [strokeAt("s1", 1, 36)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	let state = EditorState.create({ doc: DOC, extensions: [history(), inkHistorySupport()] });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const reads = { n: 0 };
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
		viewport: { from: 0, to: DOC.length + 10 },
		lineBlockAt: (pos: number) => {
			const n = state.doc.lineAt(pos).number;
			return { from: state.doc.line(n).from, to: state.doc.line(n).to, top: n * LH - LH, bottom: n * LH };
		},
		coordsAtPos: (pos: number) => {
			const top = (state.doc.lineAt(pos).number - 1) * LH;
			return { left: 0, right: 0, top, bottom: top + LH };
		},
		// The measure runs its read and write at once, and counts itself.
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => {
			reads.n++;
			req.write(req.read());
		},
		hasFocus: true,
		focus() {},
		dom: { isConnected: true, ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame() {} } } },
	};
	Object.assign(overlay, {
		view, fontZoom: 1, lineAnchorState: anchors, selection: new SelectionModel(),
		pinchRefScale: null, pinchPreview: false, pinchScaleNow: 1, cssScale: 1, scale: 1, inkInputPanX: () => 0, inkInputPanY: () => 0,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600 }) },
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path, lineAnchorsMoved() {}, followMoved() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	anchors.tracks(path, inlineInk.strokes(path));
	/** A paragraph's target, and its words' place read as Attach reads it. */
	const para = (n: number) => {
		const line = state.doc.line(n);
		return { target: targetAt(state.doc.toString(), line.from, line.to, "paragraph"), ref: overlay.followRefAt(line.from)! };
	};
	const store = () => inlineInk.strokes(path).find((s) => s.id === "s1")!;
	/** Where this pane shows the stroke's first point. */
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		const p = anchors.shownOf(store()).points[0]!;
		return { x: p.x, y: p.y };
	};
	const record = () => inlineInk.attachments(path).find((a) => a.id === ID) as AttachmentRecord | undefined;
	/**
	 * Where the saved page shows the stroke's first point: its stored point, moved by the correction its record takes to its
	 * words as they lie now (a reopen's read). Free ink, and a group whose words are gone, shows at its stored point.
	 */
	const saved = () => {
		const p = store().points[0]!, r = record();
		if (!r) return { x: p.x, y: p.y };
		// A record whose words are gone is held at its stored points when the note opens.
		if (resolveAttachments([r], state.doc.toString()).status.get(r.id) === "needs-reattachment") return { x: p.x, y: p.y };
		const now = overlay.followRefAt(r.target.from)!;
		return { x: p.x + now.x - r.ref.x, y: p.y + now.y - r.ref.y };
	};
	/** One keystroke at the start of the first line: the line count stays. */
	const type = () => dispatch({ changes: { from: 0, insert: "x" } });
	return { overlay, anchors, path, para, shown, saved, record, type, reads, run: (c: StateCommand) => c({ state, dispatch }) };
}

const close = (got: { x: number; y: number }, want: { x: number; y: number }, what: string) => {
	expect(got.x, `${what} x`).toBeCloseTo(want.x, 9);
	expect(got.y, `${what} y`).toBeCloseTo(want.y, 9);
};

describe("the undo of a change of attachment keeps the ink where it is shown", () => {
	it("attach to A, change to B, undo, type: the ink stays put on screen and in the saved page", () => {
		// Guard: were the undo to take the read made for B as the read of A's record, the group would be stored one
		// paragraph's distance off, and the next edit would read A again and jump the ink by that distance.
		const r = rig("attach-change-undo.md");
		const a = r.para(2), b = r.para(3);
		const at = r.shown();
		r.overlay.attachAt(r.path, ID, ["s1"], a.target, a.ref);
		close(r.shown(), at, "premise: shown after the attach to A");
		r.overlay.attachAt(r.path, ID, ["s1"], b.target, b.ref);
		expect(r.record()?.target.from, "premise: the group hooks B").toBe(b.target.from);
		close(r.shown(), at, "premise: shown after the change to B");
		expect(r.run(undo)).toBe(true);
		expect(r.record()?.target.from, "the undo puts the group back on A").toBe(a.target.from);
		close(r.shown(), at, "shown after the undo");
		close(r.saved(), at, "saved after the undo");
		r.type();
		close(r.shown(), at, "shown after a keystroke");
		close(r.saved(), at, "saved after a keystroke");
	});

	it("control: the undo of a drop of the group keeps its own read and asks none", () => {
		// The live read of the layout the drop was made in is the record's own: the undo takes it, and nothing is read again.
		const r = rig("attach-drop-undo.md");
		const a = r.para(2);
		r.overlay.attachAt(r.path, ID, ["s1"], a.target, a.ref);
		const at = r.shown();
		const before = r.record()!;
		const follow = r.anchors.follow as unknown as { seeded(rec: AttachmentRecord, blockTop: number): boolean };
		// The drop moved the group 5 right and 7 down with its probe; its undo puts the record back as it was, in place.
		const dropped: AttachmentRecord = { ...before, probe: { ...before.probe, x: before.probe.x + 5, y: before.probe.y + 7 } };
		r.anchors.follow.setList([dropped]);
		r.anchors.follow.setList([before]);
		const reads = r.reads.n;
		expect(follow.seeded(before, r.overlay.view.lineBlockAt(before.target.from).top), "the undo asks no read").toBe(false);
		expect(r.reads.n - reads).toBe(0);
		close(r.shown(), at, "shown after the undo of the drop");
	});

	it("a group whose words are gone at load, attached to B and undone, needs reattachment again; the redo follows B", () => {
		// Defect: the Attach takes the group off hold and its undo never puts it back, so the old record follows text it
		// cannot find.
		const r = rig("attach-reattach-undo.md");
		const b = r.para(3);
		// The note was saved with the group on words since cut from it: the stored record's target is nowhere in the text.
		const cut = DOC.replace("Paragraph A has its own words.", "Words cut from the note since.");
		const from = cut.indexOf("Words cut"), to = from + "Words cut from the note since.".length;
		const stale: AttachmentRecord = { v: 1, id: ID, strokeIds: ["s1"], target: targetAt(cut, from, to, "paragraph"), ref: { x: 0, y: 30 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
		const rec = inlineInk.record(r.path);
		rec.basePage = { ...emptyPage(rec.pageId!), attachments: [stale] };
		// The ink load, as the note opens: the resolve finds no target and holds the group.
		// Its quiet-pass timer is never let fire here.
		Object.assign(r.overlay, { lineAnchorPassTimer: 0, lineDrawnAt: 0 });
		Object.assign(r.overlay.winRef, { setTimeout: () => 1, clearTimeout() {} });
		r.overlay.lineAnchorInkLoaded(r.path);
		expect(r.anchors.follow.followsText(ID), "premise: on hold at load").toBe(false);
		const at = r.shown();
		close(r.saved(), at, "premise: saved at its stored points");
		r.overlay.attachAt(r.path, ID, ["s1"], b.target, b.ref);
		expect(r.anchors.follow.followsText(ID), "premise: attached to B, it follows B").toBe(true);
		close(r.shown(), at, "premise: shown after the attach to B");
		expect(r.run(undo)).toBe(true);
		expect(r.record()?.target.from, "the undo puts the old record back").toBe(stale.target.from);
		expect(inlineInk.attachments(r.path), "the undo rewrites no record beyond its own").toEqual([stale]);
		expect(r.anchors.follow.followsText(ID), "the undo puts the hold back").toBe(false);
		close(r.shown(), at, "shown after the undo");
		close(r.saved(), at, "saved after the undo");
		expect(r.run(redo)).toBe(true);
		expect(r.record()?.target.from, "the redo hooks B again").toBe(b.target.from);
		expect(r.anchors.follow.followsText(ID), "the redo ends the hold again").toBe(true);
		close(r.shown(), at, "shown after the redo");
		close(r.saved(), at, "saved after the redo");
		r.type();
		close(r.shown(), at, "shown after a keystroke");
		close(r.saved(), at, "saved after a keystroke");
	});
});

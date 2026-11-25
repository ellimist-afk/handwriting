/**
 * A history step with no read of this layout seeds its group at the correction the step carries (AttachFollow.seeded).
 * The seed's reference point and its correction must agree: every later reader takes the correction from the point (a
 * new list, a text change, the undo that frees the members), so a seed that keeps the carry beside the record's own
 * point loses it at the first new list, and saved ink moves. A zero carry must be the shared zero, as every other
 * correction is, or the surface shows a copy where it should show the stroke itself and the hit index keeps a stale
 * entry. Unit cells on a bare follow, overlay cells on bare overlays over the real ink load, a fake view; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, EditorState, Text, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { AttachFollow, type FollowMeasure } from "./AttachFollow";
import { InkOverlayPlugin } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { StrokeIndex } from "../ink/StrokeIndex";
import { emptyPage } from "../model/PageData";
import { computeBBox, type BBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

// ---- Unit: a bare follow, a fake layout (a line is 40 editor px, 2 px per world unit: 20 world units).

const DOC = "Intro line here.\nThe word benzene sits in this line.\nLast line of the note.\n";
const LH = 40, PX = 2;
const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length - 1;
const blockTopIn = (doc: string) => (pos: number) => lineOf(doc, pos) * LH;
const record = (doc = DOC, ref = { x: 36, y: 20 }): AttachmentRecord => {
	const from = doc.indexOf("benzene");
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(doc, from, from + 7, "range"), ref, layout: { width: 672, font: 19 }, probe: { id: "s1", x: 40, y: 24 } };
};
const apply = (doc: string, cs: ChangeSet) => cs.apply(Text.of(doc.split("\n"))).toString();
function measureOver(doc: string, refAt: (pos: number) => { x: number; y: number } | null): FollowMeasure & { reads: number[] } {
	return {
		reads: [],
		inView: () => true,
		refAt(pos) {
			this.reads.push(pos);
			return refAt(pos);
		},
		blockTop: blockTopIn(doc),
	};
}

describe("a seed's reference point and correction agree", () => {
	it("F1 a new list after the seed keeps the carried correction", () => {
		// Defect: the seed sets the correction alone and leaves the record's own point, so the new list's recompute takes
		// the correction from that point: zero, and the group jumps back to its stored points.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		expect(f.seeded(r, blockTopIn(DOC)(r.target.from), { dx: 6, dy: 40 }), "premise: no read of this layout, the seed is left to be read").toBe(true);
		expect(f.groupOffset(r.id), "premise: the seed shows the carry").toEqual({ dx: 6, dy: 40 });
		f.setList([r]);
		expect(f.groupOffset(r.id), "F1 claim: the carried correction after a new list").toEqual({ dx: 6, dy: 40 });
	});

	it("F2 a text change after the seed moves the group from the carried correction, by the block's move", () => {
		// Defect: the text change's new list drops the carry, then adds the block's move to the record's own point, so the
		// group shows at the move alone (here 40 up instead of at no correction). A cure that only keeps the carry through
		// the recompute still adds the move to the record's own point and fails here.
		const doc0 = "a\nb\n" + DOC;
		const f = new AttachFollow();
		const r = record(doc0);
		f.setList([r]);
		expect(f.seeded(r, blockTopIn(doc0)(r.target.from), { dx: 0, dy: 40 }), "premise: the seed is left to be read").toBe(true);
		expect(f.groupOffset(r.id), "premise: the seed shows the carry").toEqual({ dx: 0, dy: 40 });
		const cs = ChangeSet.of([{ from: 0, to: 4 }], doc0.length), doc1 = apply(doc0, cs);
		const before = f.attachments;
		const mapped = f.docChanged(cs, blockTopIn(doc1), PX);
		expect(mapped, "premise: the change moved the target").not.toBe(before);
		expect(blockTopIn(doc1)((mapped[0] as AttachmentRecord).target.from), "premise: the block moved two lines up (40 world units)").toBe(blockTopIn(doc0)(r.target.from) - 2 * LH);
		expect(f.groupOffset(r.id), "F2 claim: carry 40 plus the block's move -40 is no correction").toEqual({ dx: 0, dy: 0 });
	});

	it("F5 a zero carry shows the store's own stroke and moves nothing", () => {
		// Defect: the zero carry is a new object, not the shared zero, so the surface shows a copy at no shift and counts
		// the member as moved.
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		expect(f.seeded(r, blockTopIn(DOC)(r.target.from), { dx: 0, dy: 0 }), "premise: the seed is left to be read").toBe(true);
		const s = strokeAt("s1", 40, 20);
		expect.soft(f.shown(s), "F5 claim: the member is shown as the store's own stroke").toBe(s);
		expect.soft(f.moves("s1"), "F5 claim: the member is not moved").toBe(false);
	});

	it("F7b control: a record changed in place keeps this layout's read (the first branch)", () => {
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		f.measure(measureOver(DOC, () => ({ x: r.ref.x + 6, y: r.ref.y + 12 })));
		const r2: AttachmentRecord = { ...r, ref: { x: r.ref.x, y: r.ref.y + 2 } };
		f.setList([r2]);
		expect(f.seeded(r2, blockTopIn(DOC)(r2.target.from), { dx: 99, dy: 99 }), "the read of this layout stands: nothing to ask").toBe(false);
		expect(f.groupOffset(r2.id), "the correction from this layout's read against the changed record").toEqual({ dx: 6, dy: 10 });
	});

	it("F7e control: the next measure after a seed reads the real point and moves the group once", () => {
		const f = new AttachFollow();
		const r = record();
		f.setList([r]);
		expect(f.seeded(r, blockTopIn(DOC)(r.target.from), { dx: 6, dy: 40 }), "premise: the seed is left to be read").toBe(true);
		const view = measureOver(DOC, () => ({ x: r.ref.x + 6, y: r.ref.y + 52 }));
		expect(f.measure(view).changed, "the read moves the group").toBe(true);
		expect(f.groupOffset(r.id), "at the real point").toEqual({ dx: 6, dy: 52 });
		expect(f.measure(view).changed, "a second measure moves nothing").toBe(false);
		expect(view.reads, "one read in all").toHaveLength(1);
		f.setList([r]);
		expect(f.groupOffset(r.id), "a new list keeps the read").toEqual({ dx: 6, dy: 52 });
	});
});

// ---- Overlay: the hit index after a zero-carry seed (one bare overlay, the real index, followMoved and its rebuild).

describe("the hit index after a zero-carry seed", () => {
	it("F6 a text change after the seed leaves no entry of the member at its old place", () => {
		// Defect: the seed's zero is a new object, so the index rebuild takes a shown copy of the member; the text change's
		// move then takes the store's own stroke as the old object, which the index does not hold, and the copy stays at
		// the old place beside the moved one: an eraser there takes a stroke shown a line lower.
		const D = "Intro line.\nThe word benzene here.\nLast line.\n", H = 30, path = "attach-seed-carry-index.md";
		const from = D.indexOf("benzene");
		const r: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(D, from, from + 7, "range"), ref: { x: 0, y: H }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
		const rec = inlineInk.record(path);
		rec.pageId = `page-${path}`;
		rec.strokes = [strokeAt("s1", 1, 36)];
		rec.basePage = { ...emptyPage(rec.pageId), attachments: [r] };
		Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
		const state = { doc: Text.of(D.split("\n")) };
		const lineBlockAt = (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * H, bottom: state.doc.lineAt(pos).number * H });
		const index = new StrokeIndex();
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			view: { scaleY: 1, lineBlockAt }, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), filePath: () => path,
			strokeIndex: index, indexDirty: true, camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			attachedLayer: { stillAt: () => true, moved() {}, invalidate() {} },
			scheduleRepaint() {}, scheduleRowsIdle() {}, lineAnchorsMoved() {}, armLineAnchorPass() {}, lineAnchorPassTimer: 0,
		});
		const follow = overlay.lineAnchors.follow;
		follow.setList(inlineInk.attachments(path));
		expect(follow.seeded(r, lineBlockAt(from).top, { dx: 0, dy: 0 }), "premise: no read of this layout, the third branch").toBe(true);
		overlay.rebuildIndex(inlineInk.strokes(path), "lazy");
		expect(overlay.indexDirty, "premise: the index is built").toBe(false);
		const old: BBox = { ...inlineInk.strokes(path)[0]!.bbox };
		const at = (b: BBox) => index.query(b).filter((s) => s.id === "s1");
		expect(at(old), "premise: the member is in the index at its place").toHaveLength(1);
		const changes = ChangeSet.of([{ from: 0, insert: "x\n" }], state.doc.length);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes } as unknown as ViewUpdate);
		expect(follow.groupOffset("att-1"), "premise: the group moved one line").toEqual({ dx: 0, dy: H });
		expect(at({ ...old, y: old.y + H }), "premise: the member went in at its new place").toHaveLength(1);
		expect(at(old), "F6 claim: no entry of the member at its old place").toEqual([]);
	});
});

// ---- Overlay: the user's steps (one pane, its own editor history over the real ink load).

const NOTE = "Intro line with many more words so the context ends here.\nParagraph A has its own words.\nParagraph B has other words.\nLast line.\n";
const RH = 30;
const ID = "att-seed-carry";
/** Two lines typed at the top, above the group's words. */
const TWO_TOP = "Top.\nTop.\n";

/** One pane over the note: the real overlay methods, a fake view whose drawn range can be moved off the group's words. */
function pane(path: string) {
	let state = EditorState.create({ doc: NOTE, extensions: [history(), inkHistorySupport()] });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null, () => true);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		const startState = state;
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
		if (tr.docChanged) {
			overlay.followDocChanged(path, { changes: tr.changes, startState, state } as unknown as ViewUpdate);
			overlay.requestFollowMeasure();
		}
	};
	const viewport = { from: 0, to: NOTE.length + 200 };
	const view = {
		scaleY: 1,
		get state() { return state; },
		dispatch,
		viewport,
		lineBlockAt: (pos: number) => {
			const n = state.doc.lineAt(pos).number;
			return { from: state.doc.line(n).from, to: state.doc.line(n).to, top: n * RH - RH, bottom: n * RH };
		},
		coordsAtPos: (pos: number) => {
			const top = (state.doc.lineAt(pos).number - 1) * RH;
			return { left: 0, right: 0, top, bottom: top + RH };
		},
		// The measure runs its read and write at once.
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
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
		adoptStoredFontRef() {}, lineAnchorPassTimer: 0, lineDrawnAt: 0,
	});
	Object.assign(overlay.winRef, { setTimeout: () => 1, clearTimeout() {} });
	anchors.tracks(path, inlineInk.strokes(path));
	// Each answer of the follow's seed (true: no read of this layout, the group seeded at the step's carry).
	const seeds: boolean[] = [];
	const seeded = anchors.follow.seeded.bind(anchors.follow);
	anchors.follow.seeded = (rec, top, carry) => {
		const v = seeded(rec, top, carry);
		seeds.push(v);
		return v;
	};
	const store = () => inlineInk.strokes(path).find((s) => s.id === "s1")!;
	return {
		overlay, anchors, seeds, viewport,
		get doc() { return state.doc; },
		dispatch,
		run: (c: StateCommand) => c({ state, dispatch }),
		/** Where this pane shows the member's first point, after a redraw. */
		shown: () => {
			overlay.attachedGroups(path);
			const p = anchors.shownOf(store()).points[0]!;
			return { x: p.x, y: p.y };
		},
		/** The member's first point as stored. */
		stored: () => ({ x: store().points[0]!.x, y: store().points[0]!.y }),
		para: (n: number) => {
			const line = state.doc.line(n);
			return { target: targetAt(state.doc.toString(), line.from, line.to, "paragraph"), ref: overlay.followRefAt(line.from)! };
		},
	};
}

/** The note with one free stroke on paragraph B, open in one pane, the ink loaded. */
function note(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.strokes = [strokeAt("s1", 1, 66)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	const a = pane(path);
	a.overlay.lineAnchorInkLoaded(path);
	a.overlay.attachedGroups(path);
	return a;
}

/** Attach to paragraph B, two lines typed above, Detach: each place kept. The words then leave the drawn range. */
function attachTypeDetach(path: string) {
	const a = note(path);
	const drawn = { shown: a.shown(), stored: a.stored() };
	const p = a.para(3);
	a.overlay.attachAt(path, ID, ["s1"], p.target, p.ref);
	expect(inlineInk.attachments(path).some((x) => x.id === ID), "premise: attached").toBe(true);
	const attached = a.shown();
	a.dispatch({ changes: { from: 0, insert: TWO_TOP } });
	const typed = a.shown();
	expect(typed, "premise: the group moved down with its words, two lines").toEqual({ x: drawn.shown.x, y: drawn.shown.y + 2 * RH });
	expect(a.overlay.detachAttachment(path, ID), "premise: the Detach ran").toBe(true);
	expect(inlineInk.attachments(path).some((x) => x.id === ID), "premise: no record after the Detach").toBe(false);
	const detached = { shown: a.shown(), stored: a.stored() };
	expect(detached.stored, "premise: the Detach stored the member where it showed").toEqual(typed);
	// Scrolled off the words: no measure reads the group until they come back into the drawn range.
	a.viewport.from = 0;
	a.viewport.to = 0;
	return { a, drawn, attached, typed, detached };
}

describe("Detach, a layout change and three undos (one pane)", () => {
	it("F3 the ink is stored where it was drawn and shows where it showed before each undone step", () => {
		// Defect: the Detach's undo seeds the group at the carry beside the record's own point; the typing's undo then
		// drops the carry and adds the block's move to that point, so the group shows two lines above its words, and the
		// Attach's undo stores the ink there: two lines above where it was drawn.
		const r = attachTypeDetach("attach-seed-carry-f3.md");
		// The pane resized: the editor's update with a geometry change (updateLineAnchors), so no read of this layout is left.
		r.a.anchors.follow.layoutChanged();
		expect(r.a.run(undo), "premise: the Detach's undo ran").toBe(true);
		expect(r.a.seeds.at(-1), "premise: the undo took the third branch (no read of this layout)").toBe(true);
		expect(inlineInk.attachments("attach-seed-carry-f3.md").some((x) => x.id === ID), "premise: the record is back").toBe(true);
		expect.soft(r.a.shown(), "F3 claim: after the Detach's undo the group shows where it showed before the Detach").toEqual(r.typed);
		expect(r.a.run(undo), "premise: the typing's undo ran").toBe(true);
		expect(r.a.doc.toString(), "premise: the text is as before the typing").toBe(NOTE);
		expect.soft(r.a.shown(), "F3 claim: after the typing's undo the group shows where it showed before the typing").toEqual(r.attached);
		expect(r.a.run(undo), "premise: the Attach's undo ran").toBe(true);
		expect(inlineInk.attachments("attach-seed-carry-f3.md").some((x) => x.id === ID), "premise: no record after the Attach's undo").toBe(false);
		expect.soft(r.a.shown(), "F3 claim: after the Attach's undo the ink shows where it was drawn").toEqual(r.drawn.shown);
		expect.soft(r.a.stored(), "F3 claim: the ink is stored where it was drawn").toEqual(r.drawn.stored);
	});

	it("F4 a new list after the Detach's undo, then Redo: the Detach stores the member where it did the first time", () => {
		// Defect: the new list drops the seed's carry, so the redo of the Detach finds the group at its stored points and
		// stores the member there, two lines above where the first Detach stored it.
		const path = "attach-seed-carry-f4.md";
		const r = attachTypeDetach(path);
		r.a.anchors.follow.layoutChanged();
		expect(r.a.run(undo), "premise: the Detach's undo ran").toBe(true);
		expect(r.a.seeds.at(-1), "premise: the undo took the third branch").toBe(true);
		// A new list object with the same records, as a second pane's shared list or a stamp of another group gives.
		const list = inlineInk.attachments(path);
		inlineInk.setAttachments(path, [...list], false);
		expect(inlineInk.attachments(path), "premise: a new list object").not.toBe(list);
		expect(r.a.run(redo), "premise: the redo ran").toBe(true);
		expect(inlineInk.attachments(path).some((x) => x.id === ID), "premise: the redo took the record away").toBe(false);
		expect.soft(r.a.stored(), "F4 claim: the member is stored where the Detach stored it the first time").toEqual(r.detached.stored);
	});

	it("F7a control: no layout change, the Detach's undo takes back its read (the second branch) and nothing moves", () => {
		const path = "attach-seed-carry-f7a.md";
		const r = attachTypeDetach(path);
		expect(r.a.run(undo), "the Detach's undo ran").toBe(true);
		expect(r.a.seeds.at(-1), "the undo took back the read of this layout").toBe(false);
		expect(r.a.shown(), "shows where it showed before the Detach").toEqual(r.typed);
		expect(r.a.run(undo), "the typing's undo ran").toBe(true);
		expect(r.a.shown(), "shows where it showed before the typing").toEqual(r.attached);
		expect(r.a.run(undo), "the Attach's undo ran").toBe(true);
		expect(r.a.shown(), "shows where it was drawn").toEqual(r.drawn.shown);
		expect(r.a.stored(), "stored where it was drawn").toEqual(r.drawn.stored);
	});

	it("F7c control: the redo of an Attach shows the group where it was and stores nothing new", () => {
		const path = "attach-seed-carry-f7c.md";
		const a = note(path);
		const drawn = { shown: a.shown(), stored: a.stored() };
		const p = a.para(3);
		a.overlay.attachAt(path, ID, ["s1"], p.target, p.ref);
		expect(a.run(undo), "the Attach's undo ran").toBe(true);
		expect(inlineInk.attachments(path).some((x) => x.id === ID), "no record after the undo").toBe(false);
		expect(a.run(redo), "the redo ran").toBe(true);
		expect(inlineInk.attachments(path).some((x) => x.id === ID), "the record is back").toBe(true);
		expect(a.anchors.follow.followsText(ID), "the group follows its words").toBe(true);
		expect(a.shown(), "shows where it was drawn").toEqual(drawn.shown);
		expect(a.stored(), "stored where it was drawn").toEqual(drawn.stored);
	});

	it("F7d control: a live Attach shows the group at once where it was, at no correction", () => {
		const path = "attach-seed-carry-f7d.md";
		const a = note(path);
		const drawn = { shown: a.shown(), stored: a.stored() };
		const p = a.para(3);
		a.overlay.attachAt(path, ID, ["s1"], p.target, p.ref);
		expect(a.anchors.follow.followsText(ID), "the group follows its words").toBe(true);
		expect(a.anchors.follow.moves("s1"), "no correction: the member is shown as stored").toBe(false);
		expect(a.shown(), "shows where it was drawn").toEqual(drawn.shown);
		expect(a.stored(), "stored where it was drawn").toEqual(drawn.stored);
	});
});

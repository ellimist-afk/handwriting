/**
 * An attached group with the note open in two panes. Pane A attaches a stroke to a paragraph, then undoes the attach and
 * redoes it. Pane B takes its group list the way its redraw does, through attachedGroups, with no scroll and no edit. Pane B
 * must paint the group's ink. A group pending in a pane is left out of its groups until that pane reads the group's place.
 * The fake measure records each request and runs it at once. Two bare overlays on one note, each with its own fake view and
 * editor history; no DOM.
 */
import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentTarget } from "./InkAttachments";

const DOC = "Intro line with many more words so the context ends here.\nThe word benzene here.\nLast line.\n";
const LH = 30;
const FROM = DOC.indexOf("benzene");
const ID = "att-undo-redo";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** One pane: its own editor state and history (the real inkHistorySupport), its own anchors, the store shared. */
function pane(path: string, focused = () => false) {
	let state = EditorState.create({ doc: DOC, extensions: [history(), inkHistorySupport()] });
	const measures: { read: () => unknown; write: (m: unknown) => void }[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null, focused);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	const view = {
		scaleY: 1,
		get state() { return state; },
		dispatch,
		viewport: { from: 0, to: DOC.length },
		lineBlockAt: (pos: number) => {
			const n = state.doc.lineAt(pos).number;
			return { from: state.doc.line(n).from, to: state.doc.line(n).to, top: n * LH - LH, bottom: n * LH };
		},
		coordsAtPos: (pos: number) => {
			const top = (state.doc.lineAt(pos).number - 1) * LH;
			return { left: 0, right: 0, top, bottom: top + LH };
		},
		// The fake measure records each request and runs its read and write at once.
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => {
			measures.push(req);
			req.write(req.read());
		},
		hasFocus: true,
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
	});
	anchors.tracks(path, inlineInk.strokes(path));
	return {
		overlay, anchors,
		run: (c: StateCommand) => c({ state, dispatch }),
		measures,
	};
}

function rig(path: string, extra: InkStroke[] = []) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [strokeAt("s1", 1, 36), ...extra];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const target: AttachmentTarget = targetAt(DOC, FROM, FROM + 7, "range");
	return { a: pane(path), b: pane(path), target };
}

const attached = (path: string) => inlineInk.attachments(path).some((a) => a.id === ID);
/** B's redraw: its group list through attachedGroups. */
const redraw = (p: ReturnType<typeof pane>, path: string) => p.overlay.attachedGroups(path);
/** Painted: the group is in B's groups with its member stroke. A pending group is left out of them. */
const painted = (p: ReturnType<typeof pane>, path: string) =>
	redraw(p, path).some((g) => g.id === ID && g.members.some((s) => s.id === "s1"));

describe("an attach made, or undone and redone, in one pane: the other pane still paints the group", () => {
	it("after one plain attach in A, B paints the group with no scroll or edit", () => {
		const path = "attach-undo-redo-control.md";
		const { a, b, target } = rig(path);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		expect(attached(path)).toBe(true);
		expect(painted(b, path), "B paints the member after a plain attach").toBe(true);
	});

	it("after A attaches, undoes and redoes, B paints the group with no scroll or edit", () => {
		// Defect: the redone record is listed in B with no read in B's layout, so the group is pending there and its ink
		// is left out of B's groups, hidden, until B scrolls or edits.
		const path = "attach-undo-redo-pane-b.md";
		const { a, b, target } = rig(path);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		expect(a.run(undo)).toBe(true);
		expect(attached(path), "undo removes the group from the store").toBe(false);
		expect(a.run(redo)).toBe(true);
		expect(attached(path), "redo puts the group back in the store").toBe(true);
		expect(painted(b, path), "B paints the member after undo and redo").toBe(true);
	});

	it("a group out of B's view: B's repeated redraws ask at most one measure", () => {
		const path = "attach-out-of-view-asks-once.md";
		const { a, b, target } = rig(path);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		// B's viewport ends above the group's text: B's measure skips the group, which stays unread in B.
		(b.overlay.view as unknown as { viewport: { from: number; to: number } }).viewport = { from: 0, to: FROM - 10 };
		const before = b.measures.length;
		for (let i = 0; i < 5; i++) redraw(b, path);
		expect(b.measures.length - before, "measure requests over five redraws, group out of view").toBeLessThanOrEqual(1);
	});

	it("a group in B's view: B's repeated redraws ask at most one measure, and B paints the group", () => {
		const path = "attach-in-view-asks-once.md";
		const { a, b, target } = rig(path);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		const before = b.measures.length;
		for (let i = 0; i < 5; i++) redraw(b, path);
		expect(b.measures.length - before, "measure requests over five redraws, group in view").toBeLessThanOrEqual(1);
		expect(painted(b, path), "B paints the group").toBe(true);
	});

	it("a second attach in A asks B's measure once more, and B paints both groups", () => {
		const path = "attach-second-asks-again.md";
		const { a, b, target } = rig(path, [strokeAt("s2", 1, 66)]);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		redraw(b, path);
		redraw(b, path);
		const before = b.measures.length;
		const last = DOC.indexOf("Last");
		a.overlay.attachAt(path, "att-second", ["s2"], targetAt(DOC, last, last + 4, "range"), { x: 0, y: 2 * LH });
		redraw(b, path);
		redraw(b, path);
		expect(b.measures.length - before, "measure requests in B after the second attach").toBe(1);
		expect(painted(b, path), "B still paints the first group").toBe(true);
		expect(redraw(b, path).some((g) => g.id === "att-second" && g.members.some((s) => s.id === "s2")), "B paints the second group").toBe(true);
	});

	it("recovery: one B update with the viewport changed paints the group after the undo and redo", () => {
		const path = "attach-undo-redo-recovery.md";
		const { a, b, target } = rig(path);
		a.overlay.attachAt(path, ID, ["s1"], target, { x: 0, y: LH });
		a.run(undo);
		a.run(redo);
		redraw(b, path);
		// One B update with the viewport changed and no transaction: the measure loop's update, which asks the follow for its read.
		const update = { transactions: [], docChanged: false, geometryChanged: false, heightChanged: false, viewportChanged: true, startState: b.overlay.view.state, state: b.overlay.view.state, changes: undefined };
		b.overlay.updateLineAnchors(update as unknown as Parameters<InkOverlayPlugin["updateLineAnchors"]>[0]);
		expect(painted(b, path), "one update in B reads the group's place and paints it").toBe(true);
	});
});

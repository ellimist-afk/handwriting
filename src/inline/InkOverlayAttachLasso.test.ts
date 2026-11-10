/**
 * The lasso on attached ink (PREP section 6 item 13): a loop that touches one member selects the
 * whole group; a drop of a group keeps its record, moves the probe with the ink and is one undo step with the move.
 * A bare overlay with the real selection model, a fake view: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { invertInkOp, type InkOp } from "./InkHistory";
import * as obsidian from "obsidian";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
/** The group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record()] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const sent: TransactionSpec[] = [];
	const selection = new SelectionModel();
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view: {
			scaleY: 1,
			state: { doc },
			lineBlockAt: () => ({ top: 80, bottom: 120 }),
			lineBlockAtHeight: (h: number) => {
				const line = doc.line(Math.min(LINES, Math.floor(h / 40) + 1));
				return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
			},
			requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		fontZoom: 1,
		followRefAt: () => ({ x: 3, y: 200 }),
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		spaceSnapshot: null,
		selection,
	});
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, x: s.points[0]!.x, y: s.points[0]!.y }));
	};
	const loop = (x0: number, y0: number, x1: number, y1: number) => {
		Object.assign(overlay, { lassoActive: true, dragTotal: null, lassoPts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] });
		overlay.lassoUp();
		return [...selection.strokeIds].sort();
	};
	/** A live drag already moved the store by (dx, dy) (no picture); the lift commits it. */
	const drop = (ids: string[], dx: number, dy: number) => {
		inlineInk.moveStrokes(path, ids, dx, dy);
		Object.assign(overlay, { dragTotal: { dx, dy }, dragIds: ids, dragBox: null, dragFrom: null });
		overlay.commitLiveDrag();
	};
	return { overlay, anchors, sent, shown, loop, drop, path };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
const close = (got: { id: string; x: number; y: number }[], want: { id: string; x: number; y: number }[]) => {
	expect(got.map((s) => s.id)).toEqual(want.map((s) => s.id));
	got.forEach((s, i) => {
		expect(s.x, s.id).toBeCloseTo(want[i]!.x, 9);
		expect(s.y, s.id).toBeCloseTo(want[i]!.y, 9);
	});
};

describe("the lasso on attached ink", () => {
	it("a loop around one member selects its whole group; a loop around free ink selects only it", () => {
		// Defect: the loop selects only the member it touched, so a drag splits the group from its own ink.
		const { loop } = rig("lasso-expand.md");
		expect(loop(12, 95, 30, 110), "s1 is shown at 16..28, 101..103").toEqual(["s1", "s2"]);
		expect(loop(5, 200, 30, 220)).toEqual(["free"]);
	});

	it("a group dropped elsewhere keeps its record, its probe moves with the ink, one step with the move", () => {
		// Defect: the drop leaves the probe where the ink was, or writes the record change as a second undo step.
		const { sent, shown, drop, path } = rig("lasso-drop.md");
		const before = shown();
		drop(["s1", "s2"], 5, 7);
		const after = inlineInk.attachments(path)[0] as AttachmentRecord;
		expect(after.id).toBe("att-1");
		expect(after.ref).toEqual(record().ref);
		expect(after.target).toEqual(record().target);
		expect(after.probe).toEqual({ id: "s1", x: 15, y: 96 });
		close(shown(), before.map((s) => (s.id === "free" ? s : { ...s, x: s.x + 5, y: s.y + 7 })));
		expect(sent).toHaveLength(1);
		const step = ops(sent[0]!);
		expect(step.map((op) => op.type)).toEqual(["move", "attach"]);
		expect(step[1]).toMatchObject({ before: record(), after });
	});

	it("one undo of a group drop puts the ink and the record back", () => {
		// Defect: the undo moves the ink back and leaves the probe at the drop.
		const { overlay, sent, shown, drop, path } = rig("lasso-drop-undo.md");
		const before = shown();
		drop(["s1", "s2"], 5, 7);
		for (const op of ops(sent[0]!).map(invertInkOp)) overlay.applyInkOp(op, false);
		expect(inlineInk.attachments(path)).toEqual([record()]);
		close(shown(), before);
	});

	it("Attach on free ink: to the paragraph under the box's centre, one step, nothing moves", async () => {
		// Defect: the target is not the line under the selection, the step is two history entries, or the ink moves.
		const { overlay, sent, shown, path } = rig("lasso-attach.md");
		const before = shown();
		(overlay as unknown as { selection: SelectionModel }).selection.selectExactly(["free"]);
		expect(overlay.attachSelected()).toBe(true);
		await Promise.resolve();
		const made = inlineInk.attachments(path)[1] as AttachmentRecord;
		expect(made.strokeIds).toEqual(["free"]);
		expect(made.target).toMatchObject({ kind: "paragraph", text: "line 6 words" });
		expect(made.ref).toEqual({ x: 3, y: 200 });
		expect(made.layout).toEqual({ width: SIG.width, font: SIG.fontPx });
		expect(sent).toHaveLength(1);
		expect(ops(sent[0]!)).toMatchObject([{ type: "attach", before: null, after: made }]);
		close(shown(), before);
	});

	it("Attach of free ink with a group changes that group: its members settle by its correction, nothing moves", async () => {
		// Defect: the members keep their stored points under a record read where they are shown, so they jump 6 left, 12 up.
		const { overlay, sent, shown, path } = rig("lasso-change.md");
		const before = shown();
		(overlay as unknown as { selection: SelectionModel }).selection.selectExactly(["s1", "free"]);
		expect(overlay.attachSelected()).toBe(true);
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		expect(list).toHaveLength(1);
		expect((list[0] as AttachmentRecord).id).toBe("att-1");
		expect((list[0] as AttachmentRecord).target.text, "the box spans 99..213: centre 156, line 4").toBe("line 4 words");
		expect([...(list[0] as AttachmentRecord).strokeIds].sort()).toEqual(["free", "s1", "s2"]);
		expect((ops(sent[0]!)[0] as { settle?: { dx: number[] } }).settle?.dx).toEqual([READ.x, 0, READ.x]);
		close(shown(), before);
	});

	it("the Attach's record and its settled points are in the store before its step is dispatched: one update shows both", async () => {
		// Defect: the step is dispatched first, so the update it causes paints the record over unsettled points for a frame.
		const { overlay, anchors, path } = rig("lasso-attach-one-update.md");
		const seen: { members: number; x: number }[] = [];
		Object.assign((overlay as unknown as { view: object }).view, {
			dispatch: () => seen.push({ members: (inlineInk.attachments(path)[0] as AttachmentRecord).strokeIds.length, x: inlineInk.strokes(path)[0]!.points[0]!.x }),
		});
		(overlay as unknown as { selection: SelectionModel }).selection.selectExactly(["s1", "free"]);
		const shownX = anchors.shownOf(inlineInk.strokes(path)[0]!).points[0]!.x;
		overlay.attachSelected();
		await Promise.resolve();
		expect(seen).toEqual([{ members: 3, x: shownX }]);
	});

	it("a drop of free ink only is the move alone, as before", () => {
		// Defect: every drop carries an attach step, or a free drop changes a record it does not touch.
		const { sent, drop, path } = rig("lasso-drop-free.md");
		drop(["free"], 5, 7);
		expect(sent).toHaveLength(1);
		expect(ops(sent[0]!).map((op) => op.type)).toEqual(["move"]);
		expect(inlineInk.attachments(path)).toEqual([record()]);
	});
});

describe("the Attach button on the selection", () => {
	type Opened = { items: { title: string }[]; shownAt: { x: number; y: number } | null } | null;
	const lastMenu = () => ((obsidian as unknown as { Menu?: { last: Opened } }).Menu?.last ?? null);
	const clearMenu = () => { const M = (obsidian as unknown as { Menu?: { last: Opened } }).Menu; if (M) M.last = null; };

	/** The group selected on a bare overlay with a camera at zoom 1: screen px are world units. */
	function armed(path: string) {
		const r = rig(path);
		Object.assign(r.overlay, {
			camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
			showLassoCursor: () => {},
			beginLassoSnapshot: () => false,
			sayIfPageEmpty: () => {},
			scale: 1,
			cssScale: 1,
			lastSyncRectLeft: 300,
			lastSyncRectTop: 50,
			lassoActive: false,
			lassoPts: [],
			dragTotal: null,
			dragFrom: null,
		});
		(r.overlay as unknown as { selection: SelectionModel }).selection.selectExactly(["s1", "s2"]);
		const box = r.overlay.selectionBounds()!;
		// The contract: centred under the drawn box (6 css px pad), 12 clear, 28 across.
		const button = { x: box.x + box.width / 2, y: box.y + box.height + 6 + 12 + 14 };
		const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, t: 0 }) as unknown as Parameters<InkOverlayPlugin["lassoDown"]>[0];
		const state = () => {
			const o = r.overlay as unknown as { dragTotal: unknown; lassoActive: boolean; selection: SelectionModel };
			return { drag: o.dragTotal !== null, lasso: o.lassoActive, selected: [...o.selection.strokeIds].sort() };
		};
		/** Whether att-1 is still attached: a tap on the button with the whole group selected detaches it. */
		const attached = () => inlineInk.attachments(path).some((a) => a.id === "att-1");
		return { ...r, box, button, sample, state, attached };
	}

	it("a tap on the button detaches the whole group at the lift, opens no menu, and moves, loops and drops nothing", () => {
		// Defect: the contact lands as a lasso (the selection goes) or a drag; or the lift opens a menu and detaches nothing.
		const { overlay, button, sample, state, attached } = armed("attach-button-tap.md");
		clearMenu();
		overlay.lassoDown(sample(button.x, button.y), "pen");
		expect(state()).toEqual({ drag: false, lasso: false, selected: ["s1", "s2"] });
		expect(attached(), "nothing happens at the down").toBe(true);
		overlay.lassoMove([sample(button.x + 2, button.y + 1)]);
		overlay.lassoUp();
		expect(state()).toEqual({ drag: false, lasso: false, selected: ["s1", "s2"] });
		expect(attached(), "the lift detached the group").toBe(false);
		expect(lastMenu(), "no menu").toBeNull();
	});

	it("a move past the grab pad lets the press go: no detach, no drag, no loop", () => {
		// Defect: a drag that started on the button detaches at the lift, or turns into a drag of the selection.
		const { overlay, button, sample, state, attached } = armed("attach-button-drag.md");
		clearMenu();
		overlay.lassoDown(sample(button.x, button.y), "pen");
		overlay.lassoMove([sample(button.x + 30, button.y)]);
		overlay.lassoMove([sample(button.x, button.y)]);
		overlay.lassoUp();
		expect(attached()).toBe(true);
		expect(lastMenu()).toBeNull();
		expect(state()).toEqual({ drag: false, lasso: false, selected: ["s1", "s2"] });
	});

	it("is asked before the corner handles: a finger where the corner's square overlaps the button gets the button", () => {
		// Defect: the handle is asked first, so a finger on the button's top corner starts a resize.
		const { overlay, box, button, sample, state, attached } = armed("attach-button-order.md");
		clearMenu();
		const w = { x: box.x + box.width - 8, y: box.y + box.height + 20 };
		expect(Math.abs(w.x - button.x) <= 22 && Math.abs(w.y - button.y) <= 22, "the point is on the button for a finger").toBe(true);
		expect(overlay.transformHandleAt(w, "touch"), "and in the corner handle's finger square").toBe("se");
		overlay.lassoDown(sample(w.x, w.y), "touch");
		expect(state().drag, "no resize began").toBe(false);
		overlay.lassoUp();
		expect(attached(), "the lift detached the group").toBe(false);
	});

	it("a bare pen tip on the button reaches it with the selection kept; one px outside its square dissolves and inks", () => {
		// Defect: the tip path asks only the handles and the padded box, so a bare tip on the button clears the selection and draws.
		const { overlay, button, state, attached } = armed("attach-button-bare-tip.md");
		const noop = () => {};
		Object.assign(overlay, {
			mode: "ink",
			mouseStroke: false,
			mobileTools: null,
			noteZoomControls: null,
			frame: { end: noop, begin: noop },
			router: { refreshRect: noop, isStroking: false },
			viewportGeneration: 0,
			clearSnapPreview: noop,
			concealPenCursor: noop,
			syncCamera: noop,
			recordPenDownState: noop,
			startFrameTicker: () => { throw new Error("inked"); },
		});
		Object.assign((overlay as unknown as { view: object }).view, { hasFocus: true, focus: noop, dom: { ownerDocument: { defaultView: { setTimeout: () => 1, clearTimeout: noop } } } });
		const tip = (x: number, y: number) => ({ clientX: x, clientY: y, buttons: 1, button: 0, pointerType: "pen", pointerId: 1, pressure: 0.5 }) as unknown as PointerEvent;
		const down = (x: number, y: number) => {
			try { overlay.penDown({ x, y, pressure: 0.5, t: 0 } as unknown as Parameters<InkOverlayPlugin["penDown"]>[0], tip(x, y)); return "no ink"; }
			catch (e) { if ((e as Error).message === "inked") return "inked"; throw e; }
		};
		clearMenu();
		expect(down(button.x, button.y), "on the button").toBe("no ink");
		expect((overlay as unknown as { mode: string }).mode).toBe("lasso");
		expect(state()).toEqual({ drag: false, lasso: false, selected: ["s1", "s2"] });
		overlay.lassoUp();
		expect(attached(), "the lift detached the group").toBe(false);
		(overlay as unknown as { mode: string }).mode = "ink";
		expect(down(button.x, button.y + 14 + 1), "one px below the pen's 28 px square").toBe("inked");
		expect(state().selected, "the selection dissolved").toEqual([]);
	});

	it("each contact starts a fresh press: a let-go press does nothing, the next tap detaches, and a lost press never reaches a lift elsewhere", () => {
		// Defect: the old press stays, swallows the new contact's moves and its lift, and the drag never ends.
		const { overlay, box, button, sample, state, attached, path } = armed("attach-button-lost-lift.md");
		clearMenu();
		overlay.lassoDown(sample(button.x, button.y), "pen");
		overlay.lassoMove([sample(button.x + 30, button.y)]);
		overlay.lassoUp();
		expect(attached(), "a press let go past the pad does nothing").toBe(true);
		overlay.lassoDown(sample(button.x, button.y), "pen");
		overlay.lassoUp();
		expect(attached(), "the next tap on the button detaches").toBe(false);
		const groups = inlineInk.attachments(path).length;
		// A press whose contact was lost: no lift ever came. The next contact lands inside the selection.
		overlay.lassoDown(sample(button.x, button.y), "pen");
		const inside = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		overlay.lassoDown(sample(inside.x, inside.y), "pen");
		expect(state().drag, "the new contact grabbed the selection").toBe(true);
		overlay.lassoUp();
		expect(state(), "the lift ended the drag").toEqual({ drag: false, lasso: false, selected: ["s1", "s2"] });
		expect(inlineInk.attachments(path).length, "the lost press attached nothing at the drag's lift").toBe(groups);
		expect(lastMenu()).toBeNull();
	});

	it("is not there with nothing selected: a contact where it would be starts a loop", () => {
		// Defect: the button's square swallows a contact when it is hidden.
		const { overlay, button, sample, state, attached } = armed("attach-button-hidden.md");
		clearMenu();
		(overlay as unknown as { selection: SelectionModel }).selection.clear();
		overlay.lassoDown(sample(button.x, button.y), "pen");
		expect(state().lasso, "nothing selected: a loop starts").toBe(true);
		overlay.lassoUp();
		expect(attached()).toBe(true);
		expect(lastMenu()).toBeNull();
	});
});

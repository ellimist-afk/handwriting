/**
 * Undo pressed with an eraser drag or an insert-space drag in flight (the pen still down). Both change the store
 * live and record their own step only at the lift. The undo must meet the strokes as history recorded them, the
 * gesture is put back and ended, and the lift records nothing: the step the user just undid stays redoable, at the
 * place it was drawn. The lasso drag has the same cell in UndoDuringLassoDrag.test.ts.
 *
 * The real applyInkOp, resetGestureState and the gestures' lift methods (endPenGesture's erase branch, spaceUp),
 * with CodeMirror history over the real store; host I/O in memory. The router is a stand-in that records being let go.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, redoDepth, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string, x = 0): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x, y: 0, pressure: 0.5, t: 0 }, { x: x + 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x, y: 0, width: 10, height: 10 },
	};
}

async function rig() {
	const path = `undo-live-gesture-${++serial}.md`;
	paths.add(path);
	const pageId = `undo-live-gesture-id-${serial}`;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	const noop = () => undefined;
	const router = { abandonActiveStroke: vi.fn(() => true) };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		filePath: () => path, selection: new SelectionModel(),
		scheduleRepaint: noop, repaintPath: noop, redrawSelectionUI: noop, frontierCache: { invalidate: noop },
		mode: "ink", router, frame: { locked: true, cancel() { this.locked = false; }, end() { this.locked = false; } },
		// The gesture state resetGestureState clears, as the class initialises it.
		dragFrom: null, dragTotal: null, dragIds: [], dragHistoryIdentity: null, lassoActive: false, lassoPts: [],
		erased: [], erasePieces: new Set<string>(), eraseFrom: [], eraseWhole: false, eraseHistoryIdentity: null,
		spaceLineY: null, spaceIds: [], spaceBounds: null, spacePlan: null, spaceTotalDy: 0, spaceHistoryIdentity: null,
		panLast: null, mouseStroke: false, builder: null, snapChip: null, bandSyncDeferred: false,
		selectionDeleteKeys: { reset: noop }, clearSnapPreview: noop, hidePenCursor: noop, hideEraserCursor: noop,
		hideSpaceCursor: noop, clearSpaceFeedback: noop, stopFrameTicker: noop, mobileTools: null, noteZoomControls: null,
		wet: { clear: noop }, highlightWet: { clear: noop }, highlightWetCanvas: { setCssStyles: noop },
		tail: { clearAll: noop, clear: noop, prepareLive: noop }, activeWet: { clearStroke: noop }, cssWidth: 800, cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) }, damage: { addRect: noop, addAll: noop },
	});
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	return {
		path, overlay, router,
		ids: () => inlineInk.strokes(path).map((s) => s.id),
		at: (id: string) => inlineInk.strokes(path).find((s) => s.id === id)!.points[0]!,
		run: (c: StateCommand) => c({ state, dispatch }),
		redoDepth: () => redoDepth(state),
		draw(s: InkStroke) { inlineInk.commit(path, s); overlay.dispatchInk({ type: "add", path, strokes: [s] }); },
	};
}

it("Ctrl+Z during an eraser drag: the drag is put back and ended, and the undone stroke stays redoable", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	r.draw(stroke("T", 20));
	// The eraser lands and takes T whole, live: the fields the erase's pen-down and eraseAt set.
	const o = r.overlay;
	o.mode = "erase";
	o.eraseFrom = [...inlineInk.strokes(r.path)];
	o.eraseHistoryIdentity = inlineInk.captureHistoryIdentity(r.path);
	const [taken] = inlineInk.takeLive(r.path, ["T"]);
	o.erased.push(taken);
	expect(r.ids(), "precondition: the eraser took T live").toEqual(["S"]);

	expect(r.run(undo)).toBe(true); // undoes the draw of T
	expect(r.ids()).toEqual(["S"]);
	expect.soft(r.router.abandonActiveStroke, "the rest of the contact is let go").toHaveBeenCalledTimes(1);

	// The lift, if it still came: the real endPenGesture.
	(InkOverlayPlugin.prototype as unknown as { endPenGesture: (ev?: unknown) => void }).endPenGesture.call(o);
	expect(r.ids(), "the lift recorded nothing").toEqual(["S"]);
	expect(r.redoDepth(), "the undone draw is still redoable").toBe(1);
	expect(r.run(redo)).toBe(true);
	expect(r.ids()).toEqual(["S", "T"]);
});

it("Ctrl+Z during an insert-space drag: the drag is put back and ended, and the undone stroke stays redoable where it was drawn", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	r.draw(stroke("T", 20));
	// An insert-space drag in the ink gap moving T down 30: the fields spaceDown and spaceMove set.
	const o = r.overlay;
	o.mode = "space";
	o.spaceHistoryIdentity = inlineInk.captureHistoryIdentity(r.path);
	o.spacePlan = { y: -5, from: 4, lineHeight: 24, text: false, doc: (o.view.state as EditorState).doc };
	o.spaceLineY = -5;
	o.spaceIds = ["T"];
	inlineInk.moveStrokes(r.path, ["T"], 0, 30);
	o.spaceTotalDy = 30;
	expect(r.at("T").y, "precondition: the drag moved T live").toBe(30);

	expect(r.run(undo)).toBe(true); // undoes the draw of T
	expect(r.ids()).toEqual(["S"]);
	expect.soft(r.router.abandonActiveStroke, "the rest of the contact is let go").toHaveBeenCalledTimes(1);

	// The rest of the contact: a late sample and the lift change nothing.
	const p = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => void>;
	p.spaceMove!.call(o, [{ x: 0, y: 200, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }]);
	p.spaceUp!.call(o);
	expect(r.redoDepth(), "the undone draw is still redoable").toBe(1);
	expect(r.run(redo)).toBe(true);
	expect(r.ids()).toEqual(["S", "T"]);
	expect(r.at("T").y, "T comes back where it was drawn").toBe(0);
});

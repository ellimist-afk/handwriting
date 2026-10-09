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
function stroke(id: string): InkStroke {
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 10 } };
}

it("Ctrl+Z pressed during a lasso drag leaves the undone stroke redoable after pen-up", async () => {
	const path = `undo-during-drag-${++serial}.md`;
	paths.add(path);
	const pageId = `undo-during-drag-id-${serial}`;
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
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, { filePath: () => path, selection: new SelectionModel(),
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {}, frontierCache: { invalidate() {} },
		dragFrom: null, dragTotal: null, dragIds: [], dragHistoryIdentity: null, lassoActive: false,
		// What the teardown an undo mid-gesture runs (resetGestureState and the router's let-go) reads.
		mode: "ink", router: null, frame: { cancel() {} }, lassoPts: [], erased: [], erasePieces: new Set(), eraseFrom: [],
		eraseWhole: false, eraseHistoryIdentity: null, spaceLineY: null, spaceIds: [], spaceBounds: null, spacePlan: null,
		spaceTotalDy: 0, spaceHistoryIdentity: null, panLast: null, mouseStroke: false, builder: null, snapChip: null,
		bandSyncDeferred: false, selectionDeleteKeys: { reset() {} }, clearSnapPreview() {}, hidePenCursor() {},
		hideEraserCursor() {}, stopFrameTicker() {}, mobileTools: null, noteZoomControls: null, wet: { clear() {} },
		highlightWet: { clear() {} }, highlightWetCanvas: { setCssStyles() {} }, tail: { clearAll() {}, prepareLive() {} },
		cssWidth: 800, cssHeight: 600 });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	const run = (c: StateCommand) => c({ state, dispatch });
	const ids = () => inlineInk.strokes(path).map((s) => s.id);

	// Draw S, then lasso it.
	const s = stroke("S");
	inlineInk.commit(path, s);
	overlay.dispatchInk({ type: "add", path, strokes: [s] });
	overlay.selection.selectExactly(["S"]);
	// lassoDown inside the selection, then lassoMove: the same fields and the
	// same live translation the gesture code sets.
	overlay.mode = "lasso";
	overlay.dragFrom = { x: 0, y: 0 };
	overlay.dragTotal = { dx: 0, dy: 0 };
	overlay.dragIds = ["S"];
	overlay.dragHistoryIdentity = inlineInk.captureHistoryIdentity(path);
	inlineInk.moveStrokes(path, ["S"], 30, 0);
	overlay.dragTotal.dx += 30;

	// Ctrl+Z with the pen (or mouse button) still down: S's stroke is undone.
	expect(run(undo)).toBe(true);
	expect(ids()).toEqual([]);

	// Pen-up.
	overlay.lassoUp();

	// The user's next move is Redo, to get the stroke back.
	expect(redoDepth(state)).toBe(1);
	expect(run(redo)).toBe(true);
	expect(ids()).toEqual(["S"]);
	expect(inlineInk.strokes(path)[0]!.points[0]!.x).toBe(0); // where it was drawn
});

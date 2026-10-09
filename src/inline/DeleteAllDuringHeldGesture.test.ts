/**
 * Delete all ink pressed while a held gesture is in flight (the pen still down).
 *
 * Three gestures in InkOverlay.ts hold a transaction: each changes the store live and records its own history step
 * only at the lift, against a snapshot taken at pen-down, and each has a teardown that puts the note back when the
 * contact is torn down with no lift (a note switch, a close, a blur):
 * - the selection (lasso) drag: dragIds, dragTotal, dragHistoryIdentity; lift lassoUp, teardown rollbackLiveGesture;
 * - the eraser drag: erased, erasePieces, eraseFrom, eraseHistoryIdentity; lift endPenGesture, teardown
 *   rollbackLiveGesture;
 * - the insert-space drag: spaceIds, spaceTotalDy, spacePlan, spaceHistoryIdentity; lift spaceUp, teardown
 *   rollbackSpaceMove.
 * Delete all ink is one history step that a single undo takes back whole. Contract checked here, for each gesture:
 * the deleted ink stays deleted after the lift and after a teardown, in the store and in the saved page, and one undo
 * after the lift brings back every stroke, once.
 *
 * The real clearAllInk, applyInkOp, resetGestureState and the gestures' lift methods, with CodeMirror history over
 * the real store; host I/O in memory, keeping the last page written. The router is a stand-in that records being
 * let go. Same rig as UndoDuringLiveGesture.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
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
	const path = `delete-all-held-${++serial}.md`;
	paths.add(path);
	const pageId = `delete-all-held-id-${serial}`;
	let written: PageData | null = null;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar(_id, page) { written = page; },
		scheduleSidecarNow: async (_id, page) => { written = page; },
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
		dragFrom: null, dragTotal: null, dragIds: [], dragBox: null, dragHistoryIdentity: null, lassoActive: false, lassoPts: [],
		erased: [], erasePieces: new Set<string>(), eraseFrom: [], eraseWhole: false, eraseHistoryIdentity: null,
		spaceLineY: null, spaceIds: [], spaceBounds: null, spacePlan: null, spaceTotalDy: 0, spaceHistoryIdentity: null,
		panLast: null, mouseStroke: false, builder: null, snapChip: null, bandSyncDeferred: false,
		selectionDeleteKeys: { reset: noop }, clearSnapPreview: noop, hidePenCursor: noop, hideEraserCursor: noop,
		hideSpaceCursor: noop, hideLassoCursor: noop, clearSpaceFeedback: noop, stopFrameTicker: noop, updateExtent: noop,
		mobileTools: null, noteZoomControls: null,
		wet: { clear: noop }, highlightWet: { clear: noop }, highlightWetCanvas: { setCssStyles: noop },
		tail: { clearAll: noop, clear: noop, prepareLive: noop }, activeWet: { clearStroke: noop }, cssWidth: 800, cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) }, damage: { addRect: noop, addAll: noop },
	});
	// A getter on the class: the erase lift's empty-note notice, which this rig does not show.
	Object.defineProperty(overlay, "emptyNotice", { value: { claim: noop } });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => void>;
	const r = {
		path, overlay, router,
		ids: () => inlineInk.strokes(path).map((s) => s.id).sort(),
		saved: () => (written ? (written as PageData).strokes.map((s) => s.id).sort() : null),
		run: (c: StateCommand) => c({ state, dispatch }),
		draw(s: InkStroke) { inlineInk.commit(path, s); overlay.dispatchInk({ type: "add", path, strokes: [s] }); },
		deleteAll: () => overlay.clearAllInk(path) as number | null,
		/** A teardown with the pen still down: what a note switch runs. */
		teardown: () => proto.resetGestureState!.call(overlay),
	};
	r.draw(stroke("S"));
	r.draw(stroke("T", 20));
	inlineInk.save(path);
	return r;
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** Each held gesture: its pen-down and live change on T, as the gesture code sets them, and its real lift. */
const gestures: { name: string; start(r: Rig): void; lift(r: Rig): void }[] = [
	{
		name: "eraser drag",
		start(r) {
			const o = r.overlay;
			o.mode = "erase";
			o.eraseFrom = [...inlineInk.strokes(r.path)];
			o.eraseHistoryIdentity = inlineInk.captureHistoryIdentity(r.path);
			const [taken] = inlineInk.takeLive(r.path, ["T"]);
			o.erased.push(taken);
			expect(r.ids(), "precondition: the eraser took T live").toEqual(["S"]);
		},
		lift(r) { (InkOverlayPlugin.prototype as unknown as { endPenGesture: (ev?: unknown) => void }).endPenGesture.call(r.overlay); },
	},
	{
		name: "selection drag",
		start(r) {
			const o = r.overlay;
			o.selection.selectExactly(["T"]);
			o.mode = "lasso";
			o.dragFrom = { x: 20, y: 0 };
			o.dragTotal = { dx: 0, dy: 0 };
			o.dragIds = ["T"];
			o.dragHistoryIdentity = inlineInk.captureHistoryIdentity(r.path);
			inlineInk.moveStrokes(r.path, ["T"], 30, 0);
			o.dragTotal.dx += 30;
		},
		lift(r) { (InkOverlayPlugin.prototype as unknown as { endPenGesture: (ev?: unknown) => void }).endPenGesture.call(r.overlay); },
	},
	{
		name: "insert-space drag",
		start(r) {
			const o = r.overlay;
			o.mode = "space";
			o.spaceHistoryIdentity = inlineInk.captureHistoryIdentity(r.path);
			o.spacePlan = { y: -5, from: 4, lineHeight: 24, text: false, doc: (o.view.state as EditorState).doc };
			o.spaceLineY = -5;
			o.spaceIds = ["T"];
			inlineInk.moveStrokes(r.path, ["T"], 0, 30);
			o.spaceTotalDy = 30;
		},
		lift(r) { (InkOverlayPlugin.prototype as unknown as { endPenGesture: (ev?: unknown) => void }).endPenGesture.call(r.overlay); },
	},
];

describe("Delete all ink during a held gesture", () => {
	it("control: Delete all with no gesture in flight, then one undo brings every stroke back", async () => {
		const r = await rig();
		expect(r.deleteAll()).toBe(2);
		expect(r.ids()).toEqual([]);
		expect(r.run(undo)).toBe(true);
		expect(r.ids()).toEqual(["S", "T"]);
	});

	for (const g of gestures) {
		it(`${g.name}: the deleted ink stays deleted after the lift, and one undo brings every stroke back once`, async () => {
			const r = await rig();
			g.start(r);
			expect(r.deleteAll(), "Delete all removed what the note held").not.toBeNull();
			expect(r.ids(), "precondition: Delete all emptied the note").toEqual([]);
			g.lift(r);
			expect(r.ids(), "the lift brought deleted ink back").toEqual([]);
			expect(r.saved(), "the saved page after the lift holds deleted ink").toEqual([]);
			expect(r.run(undo)).toBe(true);
			expect(r.ids(), "one undo after the lift did not bring back every stroke, once").toEqual(["S", "T"]);
		});

		it(`${g.name}: the deleted ink stays deleted when the contact is torn down with no lift`, async () => {
			const r = await rig();
			g.start(r);
			r.deleteAll();
			expect(r.ids(), "precondition: Delete all emptied the note").toEqual([]);
			r.teardown();
			expect(r.ids(), "the teardown brought deleted ink back").toEqual([]);
			expect(r.saved(), "the saved page after the teardown holds deleted ink").toEqual([]);
		});
	}
});

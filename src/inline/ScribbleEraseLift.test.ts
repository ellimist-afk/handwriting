/**
 * Scribble to erase at the lift, through the real penUp and the real store.
 *
 * A bare overlay (the same shape as MouseStrokeReachesRelease.test.ts's) holds
 * a real StrokeBuilder fed the scribble's points, and penUp is called the way
 * the router calls it. Asserted: what the note holds after the lift, what the
 * history was handed, and that one undo of that step puts the note back
 * byte-equal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InkOverlayPlugin, inlineInk, setScribbleErase } from "./InkOverlay";
import { invertInkOp, type InkOp } from "./InkHistory";
import { SnapChip } from "./SnapChip";
import { installFakeWindow } from "../../test/routerHarness";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { PEN_WIDTH, scribble, threeStrokeWord, wordNeighbours } from "../ink/ScribbleErase.fixture";
import type { InkStroke } from "../ink/Stroke";

const PATH = "scribble-erase.md";

function fakeCtx(): CanvasRenderingContext2D {
	return new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
}

function makeOverlay(ops: InkOp[]): Record<string, unknown> {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const container = { setCssStyles: () => undefined, createDiv: () => ({}), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	const wet = { clear: () => undefined, clearStroke: () => undefined, countPainted: () => 0 };
	Object.assign(view, {
		mode: "ink",
		builder: null,
		snapChip: new SnapChip(),
		container,
		cssWidth: 800,
		cssHeight: 600,
		strokePenGesture: false,
		strokeRawMax: 0,
		mouseStroke: false,
		rawLastMoveT: 0,
		rawLastMoveX: 0,
		rawLastMoveY: 0,
		frameTicking: false,
		scrollsDuringStroke: 0,
		scale: 1,
		erased: [],
		erasePieces: new Set<string>(),
		eraseFrom: [],
		eraseWhole: false,
		strokeIndex: new StrokeIndex(),
		indexDirty: false,
		repaintQueued: false,
		activeWet: wet,
		highlightWet: { ...wet },
		highlightWetCanvas: { setCssStyles: () => undefined },
		tail: {
			clear: () => undefined, clearAll: () => undefined,
			configureInlineBacking: () => undefined,
			placeInline: () => undefined,
			restoreFullSurface: () => undefined,
			prepareLive: () => undefined,
		},
		committedCtx: fakeCtx(),
		highlightCtx: fakeCtx(),
		damage: { addRect: () => undefined, addAll: () => undefined },
		eraserEl: null,
		frame: { locked: false, end: () => undefined, cancel: () => undefined },
		viewportPan: { x: 0, y: 0 },
		previewInkOffset: 0,
		boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0, dragFrame: false,
			neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false, restCeilX: 0, startX: 0,
			startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false },
		selection: { clear: () => undefined, prune: () => undefined, isEmpty: true },
		selectionDeleteKeys: { reset: () => undefined },
		lassoPts: [],
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		view: {
			dom: { ownerDocument: { defaultView: { setTimeout, clearTimeout } }, addEventListener: () => undefined,
				removeEventListener: () => undefined },
			scrollDOM: { addEventListener: () => undefined, removeEventListener: () => undefined },
		},
		filePath: () => PATH,
		// The note's strokes as this pane shows them; no line anchors in this rig, so the store's own.
		noteStrokes: (path: string) => inlineInk.strokes(path),
		frontierCache: { invalidate: () => undefined },
		// The empty-page notice is a getter over this field.
		emptyNoticeGate: { claim: () => undefined },
		updateHandwritingPageClass: () => undefined,
		repaintPath: () => undefined,
		updateExtent: () => undefined,
		recordCommitDiagnostics: () => undefined,
		scheduleRepaint: () => undefined,
		hidePenCursor: () => undefined,
		hideEraserCursor: () => undefined,
		dispatchInk: (op: InkOp) => void ops.push(op),
	});
	return view;
}

/** Lift a stroke with these points through the real penUp. */
function lift(view: Record<string, unknown>, stroke: InkStroke, tool: "pen" | "highlighter" = "pen"): void {
	const builder = new StrokeBuilder(tool, "#222222", PEN_WIDTH);
	builder.start(0);
	for (const p of stroke.points) builder.add(p.x, p.y, p.pressure, p.t);
	view.builder = builder;
	const proto = InkOverlayPlugin.prototype as unknown as { penUp(this: unknown, ev?: unknown): void };
	proto.penUp.call(view);
}

function seed(): InkStroke[] {
	const page = [...wordNeighbours().slice(0, 1), ...threeStrokeWord(), ...wordNeighbours().slice(1)];
	inlineInk.applyAdd(PATH, page);
	return page;
}

const ids = (list: readonly InkStroke[]): string[] => list.map((s) => s.id);

let undoWindow: () => void;

describe("scribble to erase at the lift", () => {
	beforeAll(() => {
		undoWindow = installFakeWindow();
	});
	afterAll(() => undoWindow());
	beforeEach(() => {
		inlineInk.applyRemove(PATH, ids(inlineInk.strokes(PATH)));
		setScribbleErase(true);
	});
	afterEach(() => {
		setScribbleErase(false);
		inlineInk.applyRemove(PATH, ids(inlineInk.strokes(PATH)));
	});

	it("a scribble over a three-stroke word erases those three and is not kept itself", () => {
		seed();
		const ops: InkOp[] = [];
		lift(makeOverlay(ops), scribble("scribble", 96, 204, 101, 117));
		expect(ids(inlineInk.strokes(PATH))).toEqual(["next-word", "row-below", "underline"]);
		expect(ops, "one step in the history").toHaveLength(1);
		expect(ops[0]!.type).toBe("remove");
		expect(ids((ops[0] as Extract<InkOp, { type: "remove" }>).strokes)).toEqual(["w1", "w2", "w3"]);
	});

	it("with the setting off the same scribble is plain ink and nothing is erased", () => {
		const page = seed();
		setScribbleErase(false);
		const ops: InkOp[] = [];
		lift(makeOverlay(ops), scribble("scribble", 96, 204, 101, 117));
		const after = inlineInk.strokes(PATH);
		expect(ids(after.slice(0, page.length))).toEqual(ids(page));
		expect(after, "the scribble landed as one more stroke").toHaveLength(page.length + 1);
		expect(ops.map((o) => o.type)).toEqual(["add"]);
	});

	it("a highlighter going back and forth over a word highlights it and erases nothing", () => {
		const page = seed();
		const ops: InkOp[] = [];
		lift(makeOverlay(ops), scribble("scribble", 96, 204, 101, 117), "highlighter");
		const after = inlineInk.strokes(PATH);
		expect(ids(after.slice(0, page.length))).toEqual(ids(page));
		expect(after, "the highlight landed as one more stroke").toHaveLength(page.length + 1);
		expect(after.at(-1)!.tool).toBe("highlighter");
		expect(ops.map((o) => o.type)).toEqual(["add"]);
	});

	it("one undo puts the erased strokes back byte-equal, in place", () => {
		seed();
		const before = JSON.stringify(inlineInk.strokes(PATH));
		const ops: InkOp[] = [];
		lift(makeOverlay(ops), scribble("scribble", 96, 204, 101, 117));
		expect(ops).toHaveLength(1);
		const undo = invertInkOp(ops[0]!);
		expect(undo.type).toBe("add");
		const add = undo as Extract<InkOp, { type: "add" }>;
		inlineInk.applyAdd(add.path, add.strokes, add.indices);
		expect(JSON.stringify(inlineInk.strokes(PATH))).toBe(before);
	});
});

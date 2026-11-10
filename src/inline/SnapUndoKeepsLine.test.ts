/**
 * UNDO OF A PEN SHAPE SNAP: THE FREEHAND COMES BACK ON ITS LINE.
 *
 * Defect (TF-11): a pen hold snaps the stroke to a clean shape. The lift anchors the shape to the line under it (anchorNew);
 * the freehand kept for the history (snapReplaced) is never anchored. Undo puts that freehand back with no line anchor, so in
 * a note whose lines above have grown since it was drawn, it shows at its page position, off the line it was written on.
 *
 * The bar: after the hold and the lift, the line above grows (a measure moves every anchored stroke below it 30 px down);
 * undo of the snap (applyInkOp(invertInkOp(ops[1]))) restores the freehand carrying the shape's line, and it shows the
 * shape's correction. A second bar (addendum 32): a line drawn with a 6 px wobble, so the freehand's box top sits off the
 * shape's, comes back the same way, its anchor naming its own box top (inherit's shift, which a raw copy of the shape's
 * anchor lacks).
 *
 * The overlay is SnapDrag.test.ts's rig (real penDown, penRaw, penUp, the real SnapPreview and fitter, the real applyInkOp),
 * with a real LineAnchors on a twenty-line layout. Substituted: the preview canvas (records what it shows), the layers that
 * draw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { SnapPreviewCanvas } from "./SnapPreview";
import type { InkStroke } from "../ink/Stroke";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { invertInkOp, type InkOp } from "./InkHistory";
import { LineAnchors, type LineLayout } from "./LineAnchor";

const PATH = "snap-undo-keeps-line.md";
const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const DOC = Text.of(Array.from({ length: 20 }, (_, i) => `line ${i + 1} words`));

function layoutOf(heights: number[]): LineLayout {
	const tops = [0];
	for (const h of heights) tops.push(tops.at(-1)! + h);
	return { lines: DOC.lines, lineText: (n) => DOC.line(n).text, lineTop: (n) => tops[n - 1]!, pxPerWorld: 1 };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("undo of a pen shape snap in a long note", () => {
	let visible = false;
	beforeEach(() => {
		setShapeSnap(true); visible = false;
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
		vi.spyOn(SnapPreviewCanvas.prototype, "show").mockImplementation(() => { visible = true; return true; });
		vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => { visible = false; });
	});
	afterEach(() => {
		setShapeSnap(true);
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
	});

	/**
	 * `lift`: how far, px, every other inside sample of the drawn line is raised (the end samples stay put, so the fitted line's
	 * ends, and its box top, do not follow it). 0 is the plain line.
	 */
	function rig(lift = 0) {
		const v = Object.create(InkOverlayPlugin.prototype) as any;
		const ops: InkOp[] = [];
		const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
		const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint: vi.fn(), beginStroke(){}, contactHalfWidth: () => 1, head: () => null };
		const tail = { clear: vi.fn(), clearAll(){}, drawHead: vi.fn(), configureInlineBacking(){}, placeInline(){}, restoreFullSurface(){}, prepareLive: vi.fn() };
		const state = { layout: layoutOf(Array.from({ length: 20 }, () => 40)) };
		const anchors = new LineAnchors(() => state.layout);
		anchors.setSignature(SIG);
		anchors.drawn(1, 20);
		anchors.drawn(1, 20, true, true);
		Object.assign(v, { mode: "ink", strokePenGesture: true, strokeRawMax: 0, mouseStroke: false, strokeGain: 1,
			builder: null, frameTicking: false, scrollsDuringStroke: 0, scale: 1, cssWidth: 800, cssHeight: 900,
			container: {}, wet, penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...DEFAULT_PEN }, activeStyle: { ...DEFAULT_PEN }, rawLastMoveT: 0, rawLastMoveX: 0, rawLastMoveY: 0,
			strokeIndex: new StrokeIndex(), indexDirty: true, repaintQueued: false, activeWet: wet, highlightWet: wet,
			highlightWetCanvas: { setCssStyles(){} }, tail, committedCtx: ctx, highlightCtx: ctx,
			damage: { addRect(){}, addAll(){} }, eraserEl: null, frame: { end(){}, cancel(){}, begin(){} },
			viewportPan: { x: 0, y: 0 }, previewInkOffset: 0,
			boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0, dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false, restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false },
			selection: { clear(){}, prune(){}, isEmpty: true }, selectionDeleteKeys: { reset(){} },
			erased: [], erasePieces: new Set(), eraseFrom: [], eraseWhole: false, predReal: [], predLastTail: [],
			camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
			view: { hasFocus: true, dom: { ownerDocument: { defaultView: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id) } } } },
			filePath: () => PATH, updateHandwritingPageClass(){}, repaintPath(){}, updateExtent(){}, recordCommitDiagnostics(){},
			scheduleRepaint(){}, hidePenCursor(){}, hideEraserCursor(){}, schedulePresentProbe(){}, drawPredictedTail(){},
			syncCamera(){}, recordPenDownState(){}, ensurePenTools(){}, startFrameTicker(){}, probeSample(){},
			backingNow: () => 1, dispatchInk: (op: InkOp) => ops.push(op),
			lineAnchorState: anchors,
		});
		// A line on line 11 (tops at 40 px a line): drawn, then held until the shape shows, then lifted.
		v.penDown({ x: 20, y: 410, pressure: 0.5, timestamp: 0 }, { pointerType: "pen", pointerId: 7, buttons: 1, button: 0 });
		let t = 0;
		for (let i = 1; i < 16; i++) { t += 8; v.penRaw([{ x: 20 + i * 8, y: 410 + (i % 2) - (i % 2 === 1 && i < 15 ? lift : 0), pressure: 0.5, timestamp: t }], { timeStamp: t }); }
		vi.advanceTimersByTime(350);
		expect(visible, "premise: the hold showed the shape").toBe(true);
		v.penUp({ type: "pointerup", pointerType: "pen", pointerId: 7, buttons: 0, pressure: 0 });
		return { v, ops, anchors, state };
	}

	it("the freehand undo restores carries the shape's line and shows the shape's correction", () => {
		const { v, ops, anchors, state } = rig();
		expect(ops.map((op) => op.type), "premise: the lift recorded the landing and the snap").toEqual(["add", "replace"]);
		const shape = inlineInk.strokes(PATH).at(-1)!;
		expect(shape.lineAnchor?.line, "premise: the lift anchored the shape on line 11").toBe(11);
		const freehand = (ops[1] as Extract<InkOp, { type: "replace" }>).removed[0] as InkStroke;

		// The first line grows 30 px: the measure moves every anchored stroke below it down by 30.
		state.layout = layoutOf(Array.from({ length: 20 }, (_, i) => (i === 0 ? 70 : 40)));
		anchors.layoutChanged(PATH, inlineInk.strokes(PATH), "measure");
		expect(anchors.dyOf(shape), "premise: the shape shows 30 px lower").toBe(30);

		v.applyInkOp(invertInkOp(ops[1]!));
		const back = inlineInk.strokes(PATH).find((s) => s.id === freehand.id);
		expect(back, "premise: undo put the freehand back").toBeTruthy();
		anchors.layoutChanged(PATH, inlineInk.strokes(PATH));
		expect([back!.lineAnchor?.line ?? null, anchors.dyOf(back!)], "the freehand came back off its line").toEqual([11, 30]);
	});

	it("a wobbly freehand, its box top off the shape's, comes back on its line at its own height", () => {
		// Defect: the freehand takes a raw copy of the shape's anchor, whose y is the shape's box top, not its own; the anchor no
		// longer names the stroke, so the undo puts the freehand back at its page position (addendum 32).
		const { v, ops, anchors, state } = rig(6);
		expect(ops.map((op) => op.type), "premise: the lift recorded the landing and the snap").toEqual(["add", "replace"]);
		const shape = inlineInk.strokes(PATH).at(-1)!;
		const freehand = (ops[1] as Extract<InkOp, { type: "replace" }>).removed[0] as InkStroke;
		expect(Math.abs(freehand.bbox.y - shape.bbox.y), "premise: the freehand's box top is off the shape's").toBeGreaterThan(1);

		state.layout = layoutOf(Array.from({ length: 20 }, (_, i) => (i === 0 ? 70 : 40)));
		anchors.layoutChanged(PATH, inlineInk.strokes(PATH), "measure");
		expect(anchors.dyOf(shape), "premise: the shape shows 30 px lower").toBe(30);

		v.applyInkOp(invertInkOp(ops[1]!));
		const back = inlineInk.strokes(PATH).find((s) => s.id === freehand.id);
		expect(back, "premise: undo put the freehand back").toBeTruthy();
		anchors.layoutChanged(PATH, inlineInk.strokes(PATH));
		expect([back!.lineAnchor?.line ?? null, anchors.dyOf(back!)], "the freehand came back off its line").toEqual([11, 30]);
		// Y_SLACK (LineAnchor.ts): how far an anchor's y may sit from its stroke's box top and still name it.
		expect(Math.abs(back!.lineAnchor!.y - back!.bbox.y), "the freehand's anchor names its own box top").toBeLessThanOrEqual(0.5);
	});
});

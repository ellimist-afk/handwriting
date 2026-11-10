/**
 * Snap drag: free drawing costs what it did. The drag lives in the candidate
 * state only; a pen that never holds still never reaches it.
 *
 * Signature (always runs): a long free stroke through the overlay's real
 * penRaw with shape snap on never asks the camera for a drag point, never
 * shows a preview, and every sample is ink.
 *
 * Timing (opt-in, SNAP_DRAG_TIMING=1, run as lane kind timing): the same free
 * stroke with shape snap on against the control arm with it off, interleaved,
 * median of 9. The bound is coarse; the signature above is the guard.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SnapPreview, SnapPreviewCanvas } from "./SnapPreview";
import { InkOverlayPlugin, inlineInk, setShapeSnap } from "./InkOverlay";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkOp } from "./InkHistory";

declare const process: { env: Record<string, string | undefined> };

const path = "snap-drag-timing-note.md";
const SAMPLES = 2000;
beforeEach(() => {
	vi.useFakeTimers(); setShapeSnap(true);
	inlineInk.applyRemove(path, inlineInk.strokes(path).map(stroke => stroke.id));
	vi.spyOn(SnapPreviewCanvas.prototype, "clear").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setShapeSnap(true); });

function overlay() {
	const v = Object.create(InkOverlayPlugin.prototype) as any;
	const ctx = { beginPath(){}, moveTo(){}, lineTo(){}, closePath(){}, arc(){}, fill(){}, stroke(){}, save(){}, restore(){} };
	const wet = { clear(){}, clearStroke(){}, countPainted: () => 0, appendPoint(){}, beginStroke(){}, contactHalfWidth: () => 1, head: () => null };
	const toWorld = vi.fn((x: number, y: number) => ({ x, y }));
	Object.assign(v, { mode: "ink", strokePenGesture: true, strokeRawMax: 0, mouseStroke: false, strokeGain: 1,
		builder: null, frameTicking: false, scrollsDuringStroke: 0, scale: 1, cssWidth: 800, cssHeight: 600,
		container: {}, wet, penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...DEFAULT_PEN }, activeStyle: { ...DEFAULT_PEN }, rawLastMoveT: 0, rawLastMoveX: 0, rawLastMoveY: 0,
		strokeIndex: new StrokeIndex(), indexDirty: true, repaintQueued: false, activeWet: wet, highlightWet: wet,
		highlightWetCanvas: { setCssStyles(){} }, tail: { clear(){}, clearAll(){}, drawHead(){}, configureInlineBacking(){}, placeInline(){}, restoreFullSurface(){}, prepareLive(){} }, committedCtx: ctx, highlightCtx: ctx,
		damage: { addRect(){}, addAll(){} }, eraserEl: null, frame: { end(){}, cancel(){}, begin(){} },
		viewportPan: { x: 0, y: 0 }, previewInkOffset: 0,
		boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0, dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false, restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false },
		selection: { clear(){}, prune(){}, isEmpty: true }, selectionDeleteKeys: { reset(){} },
		erased: [], erasePieces: new Set(), eraseFrom: [], eraseWhole: false, predReal: [], predLastTail: [],
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: toWorld },
		view: { hasFocus: true, dom: { ownerDocument: { defaultView: { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: number) => clearTimeout(id) } } } },
		filePath: () => path, updateHandwritingPageClass(){}, repaintPath(){}, updateExtent(){}, recordCommitDiagnostics(){},
		scheduleRepaint(){}, hidePenCursor(){}, hideEraserCursor(){}, schedulePresentProbe(){}, drawPredictedTail(){},
		syncCamera(){}, recordPenDownState(){}, ensurePenTools(){}, startFrameTicker(){}, probeSample(){},
		backingNow: () => 1, dispatchInk: (_op: InkOp) => undefined,
	});
	return { v, toWorld };
}

/** One free stroke: a slow spiral the pen never pauses on, one sample per event, 8 ms apart. */
function penDown(v: any): void {
	v.penDown({ x: 400, y: 300, pressure: 0.5, timestamp: 0 }, { pointerType: "pen", pointerId: 7, buttons: 1, button: 0 });
}
function freeStroke(v: any): void {
	for (let i = 1; i <= SAMPLES; i++) {
		const a = i * 0.05, r = 20 + i * 0.1;
		v.penRaw([{ x: 400 + r * Math.cos(a), y: 300 + r * Math.sin(a), pressure: 0.5, timestamp: i * 8 }], { timeStamp: i * 8 });
		vi.advanceTimersByTime(8);
	}
}

it("signature: a free stroke with shape snap on asks for no drag point, shows nothing, and inks every sample", () => {
	const { v, toWorld } = overlay();
	const show = vi.spyOn(SnapPreviewCanvas.prototype, "show");
	const move = vi.spyOn(SnapPreview.prototype, "move");
	penDown(v);
	const before = toWorld.mock.calls.length;
	freeStroke(v);
	expect(move).toHaveBeenCalledTimes(SAMPLES);
	expect(move.mock.results.every(res => res.value === false)).toBe(true);
	expect(show).not.toHaveBeenCalled();
	// The camera converts each sample once, for the ink; nothing more.
	expect(toWorld.mock.calls.length - before).toBe(SAMPLES);
	v.penUp({ type: "pointerup", pointerType: "pen", pointerId: 7, buttons: 0, pressure: 0 });
});

it.runIf(process.env.SNAP_DRAG_TIMING === "1")("timing: a free stroke with shape snap on costs what the control arm with it off costs", () => {
	const run = (on: boolean) => {
		setShapeSnap(on);
		const { v } = overlay();
		penDown(v);
		const t0 = performance.now();
		freeStroke(v);
		const ms = performance.now() - t0;
		v.penUp({ type: "pointerup", pointerType: "pen", pointerId: 7, buttons: 0, pressure: 0 });
		return ms;
	};
	run(true); run(false);
	const on: number[] = [], off: number[] = [];
	for (let i = 0; i < 9; i++) { on.push(run(true)); off.push(run(false)); }
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
	const m = { on: median(on), off: median(off) };
	console.log(`snap drag timing: ${SAMPLES} samples, median of 9, snap on ${m.on.toFixed(2)} ms, control off ${m.off.toFixed(2)} ms, ratio ${(m.on / m.off).toFixed(3)}`);
	expect(m.on).toBeLessThanOrEqual(m.off * 1.25 + 2);
});

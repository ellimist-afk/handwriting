/**
 * Pen-up clears the wet layer's OWN BOX, with Boox mode OFF.
 *
 * That is the whole behaviour change. The box clear (`clearStroke`) has
 * shipped since 1.4.4 but ran only under `predictionEinkOn()` - the Boox
 * toggle, default false - because the comment beside it said everybody else
 * waits "until an e-ink user has confirmed the box on hardware". Nobody on
 * this project has an e-ink device, so what replaced that confirmation is a
 * pixel proof: 128 cases over every `appendPoint` branch, four path shapes,
 * both zooms, both device pixel ratios and both pens, drawn in real Chromium
 * and read back exhaustively, leave nothing behind
 * (`test/measure/WetClearBox.test.ts`, outside the gate).
 *
 * This file pins the DEFAULT path - Boox off - and does it by EXECUTING the
 * real `penUp`, not by reading the source. A grep for `clearStroke` in
 * `InkOverlay.ts` was green before this change and would be green after it
 * was reverted, because the call is in the file either way; only which of the
 * two methods a pen-up actually reaches says anything.
 *
 * Both of `penUp`'s exits are driven, because the gate was on both: the
 * empty-stroke branch (a contact that finished with nothing to commit) and
 * the commit branch's `clearTransient`.
 *
 * The TAIL is asserted too, and asserted to be UNCHANGED: it still takes the
 * whole-canvas `clearAll` with Boox off. `TailRenderer` has no equivalent
 * proof and is not symmetric with the wet layer - `clear()` RETURNS when its
 * dirty box is null, where `clearStroke` falls back to clearing everything -
 * so this test is what will notice if the tail is switched over without one.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { InkOp } from "./InkHistory";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { predictionEinkOn, setPredictionEink } from "./StrokePrediction";

const PATH = "note.md";
const PANE = { width: 800, height: 600 };

/** A 2d context that answers everything with a no-op. */
function fakeCtx(): CanvasRenderingContext2D {
	return new Proxy(
		{},
		{
			get: () => () => undefined,
			set: () => true,
		}
	) as unknown as CanvasRenderingContext2D;
}

interface Calls {
	/** "clear" (whole canvas) or "clearStroke" (the stroke's box), in order. */
	wet: string[];
	/** "clear" (dirty rect) or "clearAll" (whole canvas), in order. */
	tail: string[];
	/** The sizes the wet layer was handed, to prove it got the real canvas. */
	wetSizes: number[][];
	/** The sizes the TAIL was handed. Empty means the fallback is disarmed. */
	tailSizes: number[][];
}

interface Rig {
	calls: Calls;
	/** One contact through the real `penUp`. No points = nothing to commit. */
	penUp(points: Array<[number, number]>): void;
	ops: InkOp[];
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const ops: InkOp[] = [];
	const calls: Calls = { wet: [], tail: [], wetSizes: [], tailSizes: [] };
	// The two methods are recorded SEPARATELY. A stub that answers both with
	// the same recording cannot see this change at all.
	const wet = {
		clear: (w: number, h: number) => {
			calls.wet.push("clear");
			calls.wetSizes.push([w, h]);
		},
		clearStroke: (w: number, h: number) => {
			calls.wet.push("clearStroke");
			calls.wetSizes.push([w, h]);
		},
		countPainted: () => 0,
	};

	view.mode = "ink";
	view.builder = null;
	view.container = { find: () => null };
	view.cssWidth = PANE.width;
	view.cssHeight = PANE.height;
	view.strokePenGesture = false;
	view.strokeRawMax = 0;
	view.mouseStroke = false;
	view.rawLastMoveT = 0;
	view.rawLastMoveX = 0;
	view.rawLastMoveY = 0;
	view.frameTicking = false;
	view.scrollsDuringStroke = 0;
	view.scale = 1;
	view.erased = [];
	view.erasePieces = new Set<string>();
	view.eraseFrom = [];
	view.eraseWhole = false;
	view.strokeIndex = new StrokeIndex();
	view.indexDirty = true;
	view.repaintQueued = false;
	view.activeWet = wet;
	view.highlightWet = { ...wet };
	view.highlightWetCanvas = { setCssStyles: () => undefined };
	view.tail = {
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
		// The size is optional on the real method and the pen-up sites pass
		// it - it is what selects the no-box fallback - so it is recorded.
		clear: (w?: number, h?: number) => {
			calls.tail.push("clear");
			calls.tailSizes.push(w === undefined || h === undefined ? [] : [w, h]);
		},
		clearAll: (w: number, h: number) => {
			calls.tail.push("clearAll");
			calls.tailSizes.push([w, h]);
		},
	};
	view.committedCtx = fakeCtx();
	view.highlightCtx = fakeCtx();
	view.damage = { addRect: () => undefined, addAll: () => undefined };
	view.eraserEl = null;
	view.frame = { locked: false, end: () => undefined, cancel: () => undefined };
	view.viewportPan = { x: 0, y: 0 };
	view.previewInkOffset = 0;
	view.boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };
	view.selection = { clear: () => undefined, prune: () => undefined, isEmpty: true };
	view.selectionDeleteKeys = { reset: () => undefined };
	view.lassoPts = [];
	view.camera = {
		snapshot: { x: 0, y: 0, zoom: 1 },
		screenToWorld: (x: number, y: number) => ({ x, y }),
	};
	view.filePath = () => PATH;
	view.updateHandwritingPageClass = () => undefined;
	view.repaintPath = () => undefined;
	view.updateExtent = () => undefined;
	view.recordCommitDiagnostics = () => undefined;
	view.scheduleRepaint = () => undefined;
	view.hidePenCursor = () => undefined;
	view.hideEraserCursor = () => undefined;
	view.committedCtxFor = () => fakeCtx();
	view.backingNow = () => 1;
	view.dispatchInk = (op: InkOp) => void ops.push(op);

	const proto = InkOverlayPlugin.prototype as unknown as { penUp(this: unknown): void };

	return {
		calls,
		ops,
		penUp(points) {
			if (points.length > 0) {
				const builder = new StrokeBuilder(
					"pen",
					DEFAULT_PEN.color,
					DEFAULT_PEN.baseWidth
				);
				builder.start(0);
				points.forEach(([x, y], i) => builder.add(x, y, 0.5, i * 8));
				view.builder = builder;
			} else {
				view.builder = null;
			}
			view.mode = "ink";
			// An ordinary release, not a shape-snap dwell.
			view.rawLastMoveT = performance.now();
			proto.penUp.call(view);
		},
	};
}

describe("the note surface's pen-up clears the wet layer's own box, Boox or not", () => {
	beforeEach(() => {
		// The default, stated rather than assumed: this whole file is about
		// what happens with the e-ink toggle OFF.
		setPredictionEink(false);
	});

	it("takes clearStroke, not the whole-canvas clear, on the committed handoff", () => {
		const rig = makeRig();
		expect(predictionEinkOn(), "the e-ink toggle was on, so this proves nothing").toBe(false);

		rig.penUp([
			[100, 100],
			[140, 130],
			[180, 100],
			[220, 150],
		]);

		expect(rig.ops.length, "the stroke never committed, so no handoff ran").toBe(1);
		expect(
			rig.calls.wet,
			"pen-up took the whole-canvas clear, which damages the whole canvas on e-ink"
		).toEqual(["clearStroke"]);
		expect(rig.calls.wetSizes, "the clear was not handed the pane's own size").toEqual([
			[PANE.width, PANE.height],
		]);
		// The tail takes its dirty rect too, handed the pane size so that
		// `clear()`'s no-box fallback is ARMED. Both halves matter: a
		// `clear()` called without the size returns outright on a nulled box.
		expect(rig.calls.tail, "the tail stayed on the whole-canvas clear").toEqual(["clear"]);
		expect(
			rig.calls.tailSizes,
			"the tail's clear was not handed the size, so the fallback is disarmed"
		).toEqual([[PANE.width, PANE.height]]);
	});

	it("takes clearStroke on a contact that finished with nothing to commit", () => {
		const rig = makeRig();
		expect(predictionEinkOn()).toBe(false);

		rig.penUp([]);

		expect(rig.ops, "an empty contact published an op").toEqual([]);
		expect(
			rig.calls.wet,
			"the empty-stroke branch still took the whole-canvas clear"
		).toEqual(["clearStroke"]);
		expect(rig.calls.wetSizes).toEqual([[PANE.width, PANE.height]]);
		expect(rig.calls.tail).toEqual(["clear"]);
		expect(rig.calls.tailSizes).toEqual([[PANE.width, PANE.height]]);
	});

	it("still takes clearStroke with the e-ink toggle ON, which is where it shipped", () => {
		// The gate is gone, not inverted: Boox mode keeps exactly what it had.
		setPredictionEink(true);
		const rig = makeRig();

		rig.penUp([
			[10, 10],
			[60, 40],
		]);

		expect(rig.calls.wet).toEqual(["clearStroke"]);
		// And the tail is UNCHANGED for these users: `clear()` is exactly what
		// Boox mode already got, so making it unconditional cannot regress
		// them. What they gain is the fallback behind it.
		expect(rig.calls.tail).toEqual(["clear"]);
		expect(rig.calls.tailSizes).toEqual([[PANE.width, PANE.height]]);
		setPredictionEink(false);
	});
});

/**
 * Audit 116: in a popout, the mouse snap hold check mixed clocks, so every fittable mouse stroke got a Snap offer.
 *
 * The hold is "time since the pointer last moved". The last move is stamped from the samples, which carry the
 * event's timeStamp in the clock of the window the note is in; the lift read the main window's performance.now().
 * In a popout the two clocks have different origins, so the hold came out as the gap between the windows' start
 * times and was always long.
 *
 * Rig: a bare overlay (Object.create) over the real endPenGesture, a real StrokeBuilder holding a straight mouse
 * dash, and the real inlineInk store. The note's window (view.dom.ownerDocument.defaultView) has its own
 * performance clock; the main window's performance.now() is held far ahead of it, as a popout opened later would
 * see. The offer is counted at offerSnapChip. Asserted: a release 10 ms after the last move makes no offer; the
 * control, a release a full hold after the last move in the same clock, still makes one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { SnapChip } from "./SnapChip";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { DWELL_MS } from "../ink/ShapeSnap";
import type { InkOp } from "./InkHistory";

const PATH = "popout-snap-hold.md";

function fakeCtx(): CanvasRenderingContext2D {
	return new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
}

/** A bare overlay in a note window whose clock reads `noteNow()`. */
function makeOverlay(noteNow: () => number): { view: Record<string, unknown>; offers: () => number } {
	let offers = 0;
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const container = { setCssStyles: () => undefined, createDiv: () => ({}), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	const wet = { clear: () => undefined, clearStroke: () => undefined, countPainted: () => 0 };
	const noteWindow = { setTimeout, clearTimeout, performance: { now: noteNow } };
	Object.assign(view, {
		mode: "ink",
		builder: null,
		snapChip: new SnapChip(),
		container,
		cssWidth: 800,
		cssHeight: 600,
		strokePenGesture: false,
		strokeRawMax: 0,
		mouseStroke: true,
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
		indexDirty: true,
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
			dom: { ownerDocument: { defaultView: noteWindow }, addEventListener: () => undefined,
				removeEventListener: () => undefined },
			scrollDOM: { addEventListener: () => undefined, removeEventListener: () => undefined },
		},
		filePath: () => PATH,
		updateHandwritingPageClass: () => undefined,
		repaintPath: () => undefined,
		updateExtent: () => undefined,
		recordCommitDiagnostics: () => undefined,
		scheduleRepaint: () => undefined,
		hidePenCursor: () => undefined,
		hideEraserCursor: () => undefined,
		dispatchInk: (_op: InkOp) => undefined,
		offerSnapChip: () => void offers++,
	});
	return { view, offers: () => offers };
}

/** A straight mouse dash whose last sample is at `lastT` in the note window's clock. */
function straightDash(lastT: number): StrokeBuilder {
	const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth, undefined, "mouse");
	builder.start(lastT - 120);
	for (let i = 0; i <= 12; i++) builder.add(i * 20, 50, 0.5, lastT - 120 + i * 10);
	return builder;
}

const liftAt = (t: number) => ({ type: "pointerup", pointerType: "mouse", pointerId: 1, timeStamp: t }) as unknown as PointerEvent;

describe("audit 116: the snap hold is timed in the note window's own clock", () => {
	beforeEach(() => {
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
		// The main window has been open far longer than the popout the note is in.
		vi.spyOn(performance, "now").mockReturnValue(1_000_000);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
	});

	const release = (heldFor: number) => {
		const LAST_MOVE = 5_000;
		const { view, offers } = makeOverlay(() => LAST_MOVE + heldFor);
		view.builder = straightDash(LAST_MOVE);
		view.rawLastMoveT = LAST_MOVE;
		const proto = InkOverlayPlugin.prototype as unknown as { penUp(this: unknown, ev?: unknown): void };
		proto.penUp.call(view, liftAt(LAST_MOVE + heldFor));
		expect(inlineInk.strokes(PATH), "the dash was saved").toHaveLength(1);
		return offers();
	};

	it("a release 10 ms after the last move, in a popout, makes no Snap offer", () => {
		expect(release(10), "10 ms is no hold, whatever the main window's clock reads").toBe(0);
	});

	it("control: a release a full hold after the last move still makes the offer", () => {
		expect(release(DWELL_MS + 50)).toBe(1);
	});
});

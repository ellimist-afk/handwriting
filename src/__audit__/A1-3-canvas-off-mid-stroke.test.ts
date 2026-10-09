/**
 * Infinite Canvas turned off mid-stroke on a zoomed note: the pen lift resets the zoom to 100 percent.
 *
 * A note is zoomed to 150 percent. While the pen is down writing, Infinite Canvas goes off (command, file menu, or a
 * synced frontmatter change). applyCanvasMode cannot reset the zoom then: the stroke owns the frame, so the reset is
 * kept pending for the lift. endPenGesture does retry it, but first thing, while this.builder still holds the live
 * stroke's builder (it is cleared further down the ink branch), and retryCanvasOffReset refuses whenever a builder is
 * set. So the lift never resets, and every later ink lift refuses the same way: the note stays at 150 percent with
 * the canvas off and every zoom control dead, until a resize, an erase or lasso lift, or Reset zoom.
 *
 * Drives the real applyCanvasMode, retryCanvasOffReset, penUp and endPenGesture on an overlay built with
 * Object.create. The commit itself (zoomAroundCenter) is recorded, not run: the question is whether the lift asks
 * for it. The stroke's builder finishes with no stored strokes, so the ink branch takes its early return; the
 * retry it skips sits above that return.
 *
 * Expected: red until a lift that ends the stroke runs the pending reset.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin } from "../inline/InkOverlay";

type Fields = Record<string, unknown>;
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

function overlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const resets: number[] = [];
	const frame = { locked: true, end() { frame.locked = false; } };
	const clear = { clear: () => undefined, clearStroke: () => undefined, clearAll: () => undefined, prepareLive: () => undefined };
	Object.assign(o, {
		filePath: () => "a1-3-zoomed.md",
		container: {},
		frame,
		canvasMode: true, // the note was a canvas note, zoomed
		pinchScaleNow: 1.5,
		router: null,
		builder: { finishReleaseFiltered: () => [] }, // the stroke in flight
		strokePenGesture: true,
		strokeRawMax: 0,
		mouseStroke: false,
		snapPreview: null,
		snapContactId: 1,
		mode: "ink",
		bandSyncDeferred: false,
		resizeDeferred: false,
		viewportStyleDirty: false,
		mobileTools: null,
		noteZoomControls: null,
		pinchGive: null,
		leftReserveHeld: 0,
		activeWet: clear,
		tail: clear,
		highlightWetCanvas: { setCssStyles: () => undefined },
		cssWidth: 800,
		cssHeight: 600,
		endWheelZoomRun: () => undefined,
		scheduleRepaint: () => undefined,
		stopFrameTicker: () => undefined,
		clearSnapPreview: () => undefined,
		resumeStrandedPan: () => false,
		zoomAroundCenter: (next: number) => {
			resets.push(next);
			(o as Fields).pinchScaleNow = next;
			return true;
		},
	});
	return { o, resets, frame };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

it("Infinite Canvas turned off mid-stroke on a zoomed note: the pen lift resets the note to 100 percent", () => {
	const { o, resets } = overlay();

	// Mid-stroke: the canvas goes off. The stroke owns the frame, so the reset is refused and kept pending.
	proto.applyCanvasMode!.call(o);
	expect(o.canvasMode, "precondition: the note's canvas is off").toBe(false);
	expect(o.canvasOffResetPending, "precondition: the reset is pending for the lift").toBe(true);
	expect(resets, "precondition: no reset while the stroke owns the frame").toEqual([]);

	// The pen lifts.
	proto.penUp!.call(o, { type: "pointerup", pointerType: "pen", pointerId: 1 });

	expect(o.builder, "precondition: the lift ended the stroke").toBeNull();
	expect(resets, "pen-up never retried the canvas-off reset").toEqual([1]);
	expect(o.pinchScaleNow, "the note stays zoomed with the canvas off").toBe(1);
});

it("discriminator: with no stroke in flight the same pending reset runs at once", () => {
	const { o, resets, frame } = overlay();
	proto.applyCanvasMode!.call(o);
	frame.end();
	o.builder = null;
	expect(proto.retryCanvasOffReset!.call(o), "the builder is the only thing refusing").toBe(true);
	expect(resets).toEqual([1]);
});

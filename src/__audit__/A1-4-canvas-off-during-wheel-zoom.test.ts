/**
 * Infinite Canvas turned off by a note's frontmatter during a wheel zoom: the run's end still settles.
 *
 * A ctrl+wheel or touchpad zoom is running on a canvas note (the preview is up), and the note's own frontmatter turns
 * Infinite Canvas off. applyCanvasMode sets canvasMode = false first and then calls endWheelZoomRun, which cancels the
 * run and sends pinch("end"). pinch() drops every phase while the canvas is off (`if (!this.canvasMode) return`), so
 * that end never reaches the settle, and the run's quiet timer has nothing left to end either. The note stays painted
 * at the preview zoom with the canvas off, and the gesture anchor stays live, so the note reads as busy. The global
 * toggle ends the run before it flips the mode, so only the per-note path is affected.
 *
 * Drives the real applyCanvasMode, endWheelZoomRun and pinch on an overlay built with Object.create, with a real
 * WheelZoomRun opened by one ctrl+wheel event. The settle (flushPinch) is recorded, not run.
 *
 * Expected: red until the per-note path settles the run it ends.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin } from "../inline/InkOverlay";
import { WheelZoomRun } from "../inline/WheelZoom";

type Fields = Record<string, unknown>;
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const CENTROID = { x: 400, y: 300 };

function overlayMidWheelZoom() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const settles: boolean[] = [];
	const run = new WheelZoomRun();
	run.feed({ x: CENTROID.x, y: CENTROID.y, deltaY: -100, deltaMode: 0, t: 0 } as Parameters<WheelZoomRun["feed"]>[0]);
	Object.assign(o, {
		filePath: () => "a1-4-wheel.md",
		router: null,
		retiring: false,
		canvasMode: true,
		wheelZoomRun: run,
		wheelZoomTimer: 0,
		// The preview a ctrl+wheel run holds up: anchored at the run's centroid, previewing 120 percent.
		pinchPreview: true,
		pinchRefScale: 1,
		pinchScaleNow: 1,
		pinchPending: { next: 1.2 },
		pinchAnchor: { focalX: CENTROID.x, focalY: CENTROID.y },
		zoomFloor: 0.1,
		pinchGive: null,
		pinchRaf: 0,
		previewPaperHandoff: false,
		paperPanWritten: false,
		viewportStyleDirty: false,
		reducePinchConstraint: () => undefined,
		flushPinch: (settle: boolean) => {
			settles.push(settle);
		},
		restorePinchLayers: () => undefined,
		endPreviewPaper: () => undefined,
		releaseMeasures: () => undefined,
		scheduleRepaint: () => undefined,
	});
	return { o, settles, run };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

it("a note's frontmatter turning Infinite Canvas off mid wheel zoom settles the run it ends", () => {
	const { o, settles, run } = overlayMidWheelZoom();
	expect(run.isLive, "precondition: a wheel zoom run is live").toBe(true);

	proto.applyCanvasMode!.call(o); // the per-note path: the override changed

	expect(o.canvasMode, "precondition: the note's canvas is off").toBe(false);
	expect(run.isLive, "precondition: the run was ended").toBe(false);
	expect(settles, "the run's end never reached the settle").toEqual([true]);
	expect(o.pinchPreview, "the preview is still up with the canvas off").toBe(false);
	expect(o.pinchAnchor, "the gesture anchor is still live, so the note reads busy").toBeNull();
});

it("discriminator: the global toggle's order (end the run, then flip) reaches the settle", () => {
	const { o, settles } = overlayMidWheelZoom();
	proto.endWheelZoomRun!.call(o); // setScrollExpansionEnabled(false) ends every run first...
	proto.applyCanvasMode!.call(o); // ...then each note re-reads its answer
	expect(settles).toEqual([true]);
	expect(o.pinchPreview).toBe(false);
	expect(o.pinchAnchor).toBeNull();
});

it("a note's frontmatter turning Infinite Canvas off mid two-finger pinch: the preview comes down and the note is at 100 percent", () => {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const settles: boolean[] = [];
	const resets: number[] = [];
	Object.assign(o, {
		filePath: () => "a1-4-pinch.md",
		router: null,
		retiring: false,
		canvasMode: true,
		container: {},
		frame: { locked: false },
		builder: null,
		wheelZoomRun: new WheelZoomRun(), // no wheel run: two fingers are down
		wheelZoomTimer: 0,
		pinchPreview: true,
		pinchRefScale: 1,
		pinchScaleNow: 1,
		pinchPending: { next: 1.5 },
		pinchAnchor: { focalX: CENTROID.x, focalY: CENTROID.y },
		zoomFloor: 0.1,
		pinchGive: null,
		pinchRaf: 0,
		previewPaperHandoff: false,
		paperPanWritten: false,
		viewportStyleDirty: false,
		reducePinchConstraint: () => undefined,
		// The settle commits the previewed scale, as the real one does.
		flushPinch: (settle: boolean) => {
			settles.push(settle);
			o.pinchScaleNow = (o.pinchPending as { next: number } | null)?.next ?? o.pinchScaleNow;
			o.pinchPending = null;
		},
		restorePinchLayers: () => undefined,
		endPreviewPaper: () => undefined,
		releaseMeasures: () => undefined,
		scheduleRepaint: () => undefined,
		zoomAroundCenter: (next: number) => {
			resets.push(next);
			o.pinchScaleNow = next;
			return true;
		},
	});

	proto.applyCanvasMode!.call(o); // the per-note path: the override changed with two fingers down
	proto.pinch!.call(o, "end", 1, CENTROID); // the fingers lift after the flip

	expect(o.canvasMode, "precondition: the note's canvas is off").toBe(false);
	expect(settles, "the pinch was never settled").toEqual([true]);
	expect(o.pinchPreview, "the preview is still up with the canvas off").toBe(false);
	expect(o.pinchAnchor, "the gesture anchor is still live, so the note reads busy").toBeNull();
	expect(resets, "the note was not reset to 100 percent").toEqual([1]);
	expect(o.pinchScaleNow).toBe(1);
});

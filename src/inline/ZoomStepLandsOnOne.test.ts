/**
 * A ZOOM BAR STEP TO 100 PERCENT LANDS ON EXACTLY 100 PERCENT.
 *
 * The bar asks zoomNoteBy(target / zoom), and zoomNoteBy multiplies it back, so from a zoom off the bar's grid (after a
 * pinch, ctrl+wheel or Fit) the product can miss 1 by one float step. The bar then read 100 percent, but every exact
 * `=== 1` check (the line signature, the same-frame attached follow, the camera given back with the canvas off) took the
 * note as zoomed. A step within 1e-9 of 1 now commits exactly 1.
 *
 * The prototype rig of ZoomCeiling.test.ts: the real zoomNoteBy, zoomAroundCenter and commitCameraScale, with only the
 * DOM, the frame clock and layout sinks stubbed. Node only.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { MIN_PINCH_SCALE } from "./PinchScale";

type Fields = Record<string, unknown>;

interface OverlayMethods {
	zoomNoteBy(factor: number): boolean;
	commitCameraScale(next: number, scroll?: { left: number; top: number }): boolean;
}

function makeRig(start: number) {
	const win = { requestAnimationFrame: vi.fn((): number => 1), cancelAnimationFrame: vi.fn(), setTimeout: vi.fn((): number => 0), clearTimeout: vi.fn() };
	const hostStyles: Record<string, string> = {};
	const host = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, posAtCoords: () => null, requestMeasure: vi.fn(), measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	overlay.canvasMode = true;
	overlay.cssScale = start; overlay.fontZoom = 1; overlay.scale = start;
	overlay.pinchScaleNow = start;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRasterScale = start;
	overlay.pinchRefScale = null;
	overlay.pinchStartPan = { x: 0, y: 0 };
	overlay.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	overlay.pinchAnchor = null;
	overlay.pinchPending = null;
	overlay.pinchRaf = 0;
	overlay.pinchScrollAt = 0;
	overlay.pinchHiddenCanvases = new Map();
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.getNoteViewportState = () => ({ zoom: overlay.pinchScaleNow, busy: false, fitAvailable: true });
	overlay.prepareViewportLayout = () => true;
	overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none" };
	overlay.filePath = () => "note.md";
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize"]) overlay[name] = vi.fn();
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	overlay.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;

	const methods = InkOverlayPlugin.prototype as unknown as OverlayMethods;
	return {
		scale: (): number => overlay.pinchScaleNow as number,
		commit: (next: number): boolean => methods.commitCameraScale.call(overlay, next, { left: 0, top: 0 }),
		/** The zoom bar's step to a grid value: it asks for target / zoom. */
		stepTo: (target: number): boolean => methods.zoomNoteBy.call(overlay, target / (overlay.pinchScaleNow as number)),
	};
}

describe("a zoom bar step to 100 percent lands on exactly 100 percent", () => {
	it("from 81.01557 percent, the plus step to 100 percent commits exactly 1", () => {
		const OFF_GRID = 0.8101557;
		expect(OFF_GRID * (1 / OFF_GRID), "premise: this zoom times its inverse misses 1").not.toBe(1);
		const rig = makeRig(1);
		expect(rig.commit(OFF_GRID), "premise: the off-grid zoom commits").toBe(true);
		expect(rig.scale()).toBe(OFF_GRID);
		expect(rig.stepTo(1)).toBe(true);
		expect(rig.scale(), "the step landed one float step off 100 percent").toBe(1);
	});

	it("control: a step to a zoom other than 100 percent commits the product as before", () => {
		const rig = makeRig(1);
		expect(rig.commit(0.8101557)).toBe(true);
		expect(rig.stepTo(1.25)).toBe(true);
		expect(rig.scale()).toBe(0.8101557 * (1.25 / 0.8101557));
		expect(Math.abs(rig.scale() - 1.25)).toBeLessThan(1e-9);
	});
});

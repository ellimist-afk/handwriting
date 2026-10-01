/**
 * Production-route reproduction for a pinch that ends between display frames.
 *
 * This deliberately drives InkOverlayPlugin's real `pinch` callback and the
 * real `flushPinch` / `applyPinchScale` methods. Only
 * the browser frame clock, DOM style sinks, and final layout transaction
 * are controlled.  No predicate or pinch state transition is copied here.
 *
 * The red case is the ordering at pinch end: the gesture anchor/reference are
 * cleared before the last coalesced move is flushed.  `applyPinchScale` then
 * sees no anchor, consumes the pending scale, and never settles the raster.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";

type Phase = "start" | "move" | "end";
type Point = { x: number; y: number };
type Fields = Record<string, unknown>;

interface OverlayPrototype {
	pinch(this: unknown, phase: Phase, ratio: number, centroid: Point): void;
}

function makeRig() {
	let nextFrame = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	});
	const cancelAnimationFrame = vi.fn((id: number): void => {
		frames.delete(id);
	});
	// The preview holds CodeMirror's measure scheduling behind a lost-end timer.
	const setTimeout = vi.fn((): number => 0);
	const clearTimeout = vi.fn();
	const win = { requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout };

	const hostStyles: Record<string, string> = {};
	const host = { clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			removeProperty(name: string): void {
				delete hostStyles[name];
			},
		},
		setCssStyles(styles: Record<string, string>): void {
			Object.assign(hostStyles, styles);
		},
	};
	const scroller = {
		scrollLeft: 12,
		scrollTop: 20,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	};

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	const requestMeasure = vi.fn();
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, requestMeasure, measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
 overlay.frame = { locked: false }; overlay.cssScale = 1; overlay.fontZoom = 1;
 // THIS RIG'S SUBJECT IS ZOOM MECHANICS, so its note is a CANVAS note. With the canvas off a
 // two-finger gesture is not a zoom at all (`pinch` returns on its first line), and a fixture left in
 // that mode would run none of the code these arms are about while still reporting a result - measured,
 // the mode gate alone turned several of them green by doing nothing. `canvasMode` is a class field and
 // `Object.create` runs no field initializers, so it is set here rather than assumed.
 overlay.canvasMode = true;
	overlay.pinchScaleNow = 1;
	overlay.pinchRasterScale = 1;
	overlay.pinchRefScale = null;
	overlay.pinchStartPan = { x: 0, y: 0 };
	overlay.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	overlay.pinchAnchor = null;
	overlay.pinchPending = null;
	overlay.pinchRaf = 0;
	overlay.pinchScrollAt = 0;
	// This rig skips the constructor, including its empty preview-layer map.
	overlay.pinchHiddenCanvases = new Map();

	// The transaction's expensive sinks are observed; the mounted continuous
	// pinch test separately verifies the real allocation and layout behavior.
	const handleResize = vi.fn();
	overlay.handleResize = handleResize;
	// This test owns coalescing/final raster settlement, not browser layout.
	// The production transaction and loading guard are exercised mounted.
	overlay.getNoteViewportState = () => ({ busy: false });
	overlay.prepareViewportLayout = () => true;
	overlay.viewportLayout = {width:640,height:480,baseTransform:"none"};
	overlay.applyViewportBox = (next:number) => host.setCssStyles({transform:`scale(${next})`,transformOrigin:"0 0"});
	overlay.commitCameraScale = (next: number) => {
		overlay.pinchScaleNow = next;
		overlay.cssScale = next;
		host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
		handleResize();requestMeasure();
		return true;
	};

	const prototype = InkOverlayPlugin.prototype as unknown as OverlayPrototype;
	const onPinch = (phase: Phase, ratio: number, centroid: Point): void =>
		prototype.pinch.call(overlay, phase, ratio, centroid);
	const runNextFrame = (): void => {
		const entry = frames.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;
		if (!entry) throw new Error("expected one requested animation frame");
		frames.delete(entry[0]);
		entry[1](0);
	};

	return {
		onPinch,
		runNextFrame,
		pendingFrames: () => frames.size,
		scale: () => overlay.pinchScaleNow as number,
		rasterScale: () => overlay.pinchRasterScale as number,
		scroll: () => ({ left: scroller.scrollLeft, top: scroller.scrollTop }),
		hostStyles,
		handleResize,
		requestMeasure,
		cancelAnimationFrame,
	};
}

describe("InkOverlay pinch end with a coalesced move still pending", () => {
	it("the last sample replaces a pending zoom when it returns to the rendered scale", () => {
		const rig=makeRig(),centroid={x:100,y:80};
		rig.onPinch("start",1,centroid);
		rig.onPinch("move",2,centroid);
		rig.onPinch("move",1,centroid);
		rig.onPinch("end",1,centroid);
		expect(rig.scale()).toBe(1);
		expect(rig.pendingFrames()).toBe(0);
	});
	it("settles after returning to the starting scale", () => {
		const rig=makeRig(),centroid={x:100,y:80};
		rig.onPinch("start",1,centroid);
		rig.onPinch("move",2,centroid);rig.runNextFrame();
		rig.onPinch("move",1,centroid);rig.runNextFrame();
		rig.onPinch("end",1,centroid);
		expect(rig.scale()).toBe(1);
		expect(rig.handleResize).toHaveBeenCalledTimes(1);
		expect(rig.pendingFrames()).toBe(0);
	});
	it("lands the final requested scale and settles exactly once", () => {
		const rig = makeRig();
		const centroid = { x: 100, y: 80 };

		rig.onPinch("start", 1, centroid);
		rig.onPinch("move", 2, centroid);
		rig.runNextFrame();
		expect(rig.scale()).toBe(2);
		expect(rig.handleResize).not.toHaveBeenCalled();
		expect(rig.requestMeasure).not.toHaveBeenCalled();

		// This move is newer than the frame that applied scale 2.  Lift before
		// its requested frame runs: pinch end itself owes scale 3 and one settle.
		rig.onPinch("move", 3, centroid);
		expect(rig.pendingFrames()).toBe(1);
		rig.onPinch("end", 3, centroid);

		expect.soft(rig.scale(), "the final coalesced move was discarded").toBe(3);
		expect.soft(rig.rasterScale(), "the raster never caught the landing").toBe(3);
		expect.soft(rig.hostStyles.transform, "the compositor stayed on the prior frame").toBe(
			"scale(3)"
		);
		expect.soft(rig.handleResize, "pinch end never settled/recomputed extent").toHaveBeenCalledTimes(1);
		expect(rig.requestMeasure).toHaveBeenCalledTimes(1);
		expect(rig.scroll().left, "the final frame lost the gesture-start x anchor").toBeCloseTo(
			78.6666667,
			7
		);
		expect(rig.scroll().top, "the final frame lost the gesture-start y anchor").toBeCloseTo(
			73.3333333,
			7
		);
		expect(rig.pendingFrames(), "a callback survived pinch end").toBe(0);
		expect(rig.cancelAnimationFrame).toHaveBeenCalledTimes(1);
	});

	it("control: an end with no move pending settles the applied frame once", () => {
		const rig = makeRig();
		const centroid = { x: 100, y: 80 };

		rig.onPinch("start", 1, centroid);
		rig.onPinch("move", 2, centroid);
		rig.runNextFrame();
		rig.onPinch("end", 2, centroid);

		expect(rig.scale()).toBe(2);
		expect(rig.rasterScale()).toBe(2);
		expect(rig.hostStyles.transform).toBe("scale(2)");
		expect(rig.handleResize).toHaveBeenCalledTimes(1);
		expect(rig.requestMeasure).toHaveBeenCalledTimes(1);
		expect(rig.pendingFrames()).toBe(0);
		expect(rig.cancelAnimationFrame).not.toHaveBeenCalled();
	});
});

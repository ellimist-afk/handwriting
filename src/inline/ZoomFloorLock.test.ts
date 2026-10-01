/**
 * Below the 10% floor, zoom-out is locked (Alan 2026-09-14).
 *
 * Fit may commit under MIN_PINCH_SCALE to show all ink. From there a pinch or
 * the buttons may only zoom in, and may not zoom back out either, until a
 * committed scale is at 10% again. Fit itself is always allowed.
 *
 * Drives the real `pinch`, `zoomNoteBy` and `commitCameraScale` guard on a
 * prototype rig; only the DOM, frame clock and layout sinks are stubbed. The
 * Fit commit is the call `fitHandwriting` makes: `commitCameraScale(zoom,
 * scroll, undefined, false, true)`.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { MIN_PINCH_SCALE, MAX_PINCH_SCALE, PINCH_GIVE } from "./PinchScale";

type Phase = "start" | "move" | "end";
type Point = { x: number; y: number };
type Fields = Record<string, unknown>;

interface OverlayMethods {
	pinch(phase: Phase, ratio: number, centroid: Point): void;
	zoomNoteBy(factor: number): boolean;
	commitCameraScale(next: number, scroll?: { left: number; top: number }, settleHold?: object | null, preserveScrollDemand?: boolean, bypassFloor?: boolean): boolean;
}

function makeRig(start = 1) {
	let nextFrame = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const win = {
		requestAnimationFrame: vi.fn((callback: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, callback); return id; }),
		cancelAnimationFrame: vi.fn((id: number): void => { frames.delete(id); }),
		setTimeout: vi.fn((): number => 0),
		clearTimeout: vi.fn(),
	};
	const hostStyles: Record<string, string> = {};
	const host = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		// The host's `style` is a CSSStyleDeclaration, and production reads it as one: the resting
		// column margin is read back before it is written so an unchanged value writes nothing
		// (InkOverlay.ts, `restColumnAgainstCurrentGrant`). This stub carried `removeProperty`
		// alone, so that read threw. The two it was missing are stubbed per the DOM API and over
		// the SAME `hostStyles` record `removeProperty` already uses, so the three agree with each
		// other: what `setProperty` writes, `getPropertyValue` reads back.
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, requestMeasure: vi.fn(), measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	// THIS RIG'S SUBJECT IS ZOOM MECHANICS, so its note is a CANVAS note. With the canvas off a
	// two-finger gesture is not a zoom at all (`pinch` returns on its first line), and a fixture left in
	// that mode would run none of the code these arms are about while still reporting a result - measured,
	// the mode gate alone turned several of them green by doing nothing. `canvasMode` is a class field and
	// `Object.create` runs no field initializers, so it is set here rather than assumed.
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
	const handleResize = vi.fn();
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint"]) overlay[name] = vi.fn();
	overlay.handleResize = handleResize;
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	overlay.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;

	const methods = InkOverlayPlugin.prototype as unknown as OverlayMethods;
	const centroid = { x: 320, y: 240 };
	const scale = (): number => overlay.pinchScaleNow as number;
	const runFrame = (): void => {
		const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
		if (!entry) throw new Error("expected one requested animation frame");
		frames.delete(entry[0]);
		entry[1](0);
	};
	const pinch = (phase: Phase, ratio: number): void => methods.pinch.call(overlay, phase, ratio, centroid);
	/**
	 * One gesture through the listed scales, then lift. Each move paints the
	 * frame it requested; a move clamped to the scale already on screen
	 * requests none.
	 */
	const gesture = (...targets: number[]): number => {
		const from = scale();
		pinch("start", 1);
		let ratio = 1;
		for (const target of targets) { ratio = target / from; pinch("move", ratio); if (frames.size > 0) runFrame(); }
		pinch("end", ratio);
		expect(frames.size, "a frame survived the lift").toBe(0);
		return scale();
	};
	/** As `gesture`, but the fingers lift before the last move's frame paints. */
	const gestureLiftPending = (...targets: number[]): number => {
		const from = scale();
		pinch("start", 1);
		let ratio = 1;
		targets.forEach((target, index) => {
			ratio = target / from;
			pinch("move", ratio);
			if (index < targets.length - 1 && frames.size > 0) runFrame();
		});
		expect(frames.size, "the last move should still be waiting for its frame").toBe(1);
		pinch("end", ratio);
		expect(frames.size, "a frame survived the lift").toBe(0);
		return scale();
	};
	const fit = (zoom: number): boolean => methods.commitCameraScale.call(overlay, zoom, { left: 0, top: 0 }, undefined, false, true);
	const commit = (next: number): boolean => methods.commitCameraScale.call(overlay, next, { left: 0, top: 0 });
	const recommit = (): boolean => methods.commitCameraScale.call(overlay, scale(), undefined, undefined, true);
	const button = (factor: number): boolean => methods.zoomNoteBy.call(overlay, factor);
	/** A live preview frame, left hanging mid-gesture (no "end") - the applyPinchScale preview branch only, not the settle commit a lift triggers. */
	const previewTo = (target: number): number => {
		const from = scale();
		pinch("start", 1);
		pinch("move", target / from);
		if (frames.size > 0) runFrame();
		return scale();
	};
	return { overlay, scale, gesture, gestureLiftPending, fit, commit, recommit, button, previewTo, handleResize };
}

describe("zoom-out is locked below the 10% floor", () => {
	it("control: at 100% a pinch out stops at the floor", () => {
		const rig = makeRig();
		expect(rig.gesture(0.05)).toBe(MIN_PINCH_SCALE);
	});

	it("Fit to 5%, pinch in to 7% is allowed, pinch out to 6% leaves 7%", () => {
		const rig = makeRig();
		expect(rig.fit(0.05)).toBe(true);
		expect(rig.scale()).toBe(0.05);
		const seven = rig.gesture(0.07);
		expect(seven).toBeCloseTo(0.07, 12);
		expect(rig.gesture(0.06), "a zoom-out below the floor was allowed").toBe(seven);
	});

	it("the minus button below the floor changes nothing and never jumps in to 10%", () => {
		const rig = makeRig();
		rig.fit(0.05);
		const seven = rig.gesture(0.07);
		expect(rig.button(0.5)).toBe(true);
		expect(rig.scale(), "minus zoomed out below the floor").toBe(seven);
		rig.fit(0.05);
		expect(rig.button(0.5)).toBe(true);
		expect(rig.scale(), "minus at Fit's scale moved").toBe(0.05);
	});

	it("the plus button below the floor zooms in", () => {
		const rig = makeRig();
		rig.fit(0.05);
		expect(rig.button(2)).toBe(true);
		expect(rig.scale()).toBeCloseTo(MIN_PINCH_SCALE, 12);
		rig.fit(0.03);
		expect(rig.button(2)).toBe(true);
		expect(rig.scale()).toBeCloseTo(0.06, 12);
	});

	it("(a) easing back inside one gesture is a net zoom-in: 7% -> 9% -> 8% settles 8%", () => {
		const rig = makeRig();
		rig.fit(0.05);
		const seven = rig.gesture(0.07);
		expect(rig.gesture(0.09, 0.08)).toBeCloseTo(0.08, 12);
		expect(rig.scale()).toBeGreaterThan(seven);
	});

	it("(a) the ease-back still lands when the lift comes before its frame: 7% -> 9% painted -> 8% pending settles 8%", () => {
		// The painted preview wrote 9% as the live scale. The settle must be judged
		// against the gesture's 7% start, not that preview.
		const rig = makeRig();
		rig.fit(0.05);
		rig.gesture(0.07);
		expect(rig.gestureLiftPending(0.09, 0.08)).toBeCloseTo(0.08, 12);
	});

	it("(b) a re-commit at Fit's own scale succeeds (the resize and column paths)", () => {
		const rig = makeRig();
		rig.fit(0.05);
		rig.handleResize.mockClear();
		expect(rig.recommit(), "re-commit at the current scale below the floor was refused").toBe(true);
		expect(rig.scale()).toBe(0.05);
		expect(rig.handleResize).toHaveBeenCalled();
	});

	it("(c) a new gesture from 8% cannot go below 8%", () => {
		const rig = makeRig();
		rig.fit(0.05);
		const eight = rig.gesture(0.08);
		expect(rig.gesture(0.06)).toBe(eight);
		expect(rig.gesture(0.07, 0.06)).toBe(eight);
	});

	it("(d) back at or above 10%, a pinch out clamps at 10%, not at Fit's old scale", () => {
		const rig = makeRig();
		rig.fit(0.05);
		expect(rig.gesture(0.12)).toBeCloseTo(0.12, 12);
		expect(rig.gesture(0.05)).toBe(MIN_PINCH_SCALE);
		expect(rig.button(0.5)).toBe(true);
		expect(rig.scale()).toBe(MIN_PINCH_SCALE);
	});

	it("(e) Fit is always allowed, including further out from below the floor", () => {
		const rig = makeRig();
		rig.fit(0.05);
		rig.gesture(0.08);
		expect(rig.fit(0.03)).toBe(true);
		expect(rig.scale()).toBe(0.03);
	});

	it("the commit guard itself: below the floor only a scale at or above the current one commits", () => {
		const rig = makeRig();
		rig.fit(0.05);
		rig.gesture(0.08);
		const eight = rig.scale();
		expect(rig.commit(0.06)).toBe(false);
		expect(rig.scale()).toBe(eight);
		expect(rig.commit(0.09)).toBe(true);
		expect(rig.scale()).toBe(0.09);
		expect(rig.commit(MIN_PINCH_SCALE)).toBe(true);
		expect(rig.commit(0.09), "at 10% the floor is back").toBe(false);
	});
});

/**
 * MAXZOOM-6: MAX_PINCH_SCALE moved from 4 to 6, but the note's zoom-in
 * ceiling is written at three call sites and only one of them is the named
 * constant read directly. Each cell below is red against the old bare `4`
 * literal it replaces and green against MAX_PINCH_SCALE:
 *
 *   `applyPinchScale`'s preview branch (InkOverlay.ts, live pinch, no commit)
 *   `commitCameraScale`'s own refusal (InkOverlay.ts, the settle/commit gate)
 *   `zoomNoteBy`'s clamp (InkOverlay.ts, the +/- buttons and commands)
 *
 * None of these can be caught by `PinchScale.test.ts`'s
 * `pinchScale(1, 100) === MAX_PINCH_SCALE` assertion: that pin already reads
 * the constant symbolically, so it stays green whether the constant is 4 or
 * 6. Nothing there drives an actual preview frame, a real commit, or a
 * button click past the old ceiling - which is exactly what let two bare `4`
 * literals sit unnoticed the first time this same ceiling moved (a review finding
 * on 772960c7).
 */
describe("the pinch-in ceiling reaches MAX_PINCH_SCALE, not the old 400%", () => {
	it("a commit driven to the ceiling succeeds and reads that scale", () => {
		const rig = makeRig();
		expect(rig.commit(MAX_PINCH_SCALE)).toBe(true);
		expect(rig.scale()).toBe(MAX_PINCH_SCALE);
	});

	it("a commit past the ceiling is still refused", () => {
		const rig = makeRig();
		expect(rig.commit(MAX_PINCH_SCALE + 1)).toBe(false);
		expect(rig.scale()).toBe(1);
	});

	it("a live preview frame past the old 4x ceiling reaches a scale above it", () => {
		const rig = makeRig();
		expect(rig.previewTo(5)).toBeGreaterThan(4);
		expect(rig.scale()).toBe(5);
	});

	it("a live preview frame reaches the new ceiling exactly, and no further", () => {
		const rig = makeRig();
		expect(rig.previewTo(MAX_PINCH_SCALE)).toBe(MAX_PINCH_SCALE);
		expect(rig.previewTo(MAX_PINCH_SCALE + 1), "past the ceiling the preview frame is refused, scale holds").toBe(MAX_PINCH_SCALE * PINCH_GIVE);
	});

	it("the plus button rides zoomNoteBy's own ceiling from 400% up to the new one", () => {
		const rig = makeRig();
		expect(rig.button(2)).toBe(true);
		expect(rig.scale()).toBe(2);
		expect(rig.button(2)).toBe(true);
		expect(rig.scale(), "the old ceiling: a literal 4 here would already be capped").toBe(4);
		expect(rig.button(2)).toBe(true);
		expect(rig.scale(), "zoomNoteBy's own Math.min must read MAX_PINCH_SCALE, not 4").toBe(MAX_PINCH_SCALE);
		// Once at the ceiling, another zoom-in is a no-op rather than a jump past it.
		expect(rig.button(2)).toBe(true);
		expect(rig.scale()).toBe(MAX_PINCH_SCALE);
	});
});

/**
 * AUDIT PROBE InkOverlay-5-2 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: when Infinite Canvas goes off, applyCanvasMode (InkOverlay.ts :8951-8960) tries ONE
 * zoomAroundCenter(1) and never retries. For a note in a background tab (zero-size editor) the commit is
 * refused at :9061 (scaleGeometryValid===false, or validCameraScale(1, 0, 0)), so the note keeps its zoom.
 * When the tab fronts, handleResize re-validates the geometry and re-commits only at pinchScaleNow, and every
 * user control (reset, +/-, Fit) refuses because getNoteViewportState is busy while !canvasMode (:8940).
 *
 * Correct behaviour (product context): with the canvas off the note is stock Obsidian, i.e. at 100
 * percent, or at the very least the note can be brought back to 100 percent. These cells assert that, so they
 * go red only if the zoom survives the real toggle + background + front sequence.
 *
 * Rig: the prototype rig from src/inline/ZoomFloorLock.test.ts (real commitCameraScale, zoomNoteBy,
 * resetNoteZoom, fitHandwriting), plus the REAL getNoteViewportState, applyCanvasMode, endWheelZoomRun,
 * canvasModeOn, filePath, handleResize (both its zero-size background branch and its non-zero fronting
 * branch) and the real module toggle setScrollExpansionEnabled. The rig's overlay cannot be in the module's
 * private `instances` set (only the constructor adds to it), so the per-instance loop body of
 * setScrollExpansionEnabled (:944-947: applyCanvasMode, scheduleRepaint) is run for it by hand, after the real
 * setter has flipped the global. Stubs are paint/layout sinks only; grep shows pinchScaleNow is written only at
 * :3108 (teardown), :3202 (note switch), :6051 (pinch preview) and :9084 (commitCameraScale).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk, setScrollExpansionEnabled } from "../inline/InkOverlay";
import overlaySource from "../inline/InkOverlay.ts?raw";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { MIN_PINCH_SCALE } from "../inline/PinchScale";
import { WheelZoomRun } from "../inline/WheelZoom";
import { emptyPage } from "../model/PageData";

type Fields = Record<string, unknown>;

const PATH = "ik52-zoomed-note.md";

interface OverlayMethods {
	zoomNoteBy(factor: number): boolean;
	resetNoteZoom(): boolean;
	fitHandwriting(): "fit" | "empty" | "busy" | "unrepresentable";
	applyCanvasMode(): void;
	endWheelZoomRun(): void;
	canvasModeOn(): boolean;
	getNoteViewportState(): { zoom: number; busy: boolean; fitAvailable: boolean };
	commitCameraScale(next: number, scroll?: { left: number; top: number }, settleHold?: object | null, preserveScrollDemand?: boolean, bypassFloor?: boolean): boolean;
	handleResize(): void;
	retryCanvasOffReset(): void;
}
const proto = InkOverlayPlugin.prototype as unknown as OverlayMethods;

async function loadNote(): Promise<void> {
	const host: InlineInkHost = {
		readPageId: (p) => "ik52-page-" + p,
		claimId: async (_p, pageId) => ({ pageId }),
		loadSidecar: vi.fn(async (pageId: string) => {
			const data = emptyPage(pageId);
			data.surface = "inline";
			return { data, recovered: false };
		}),
		scheduleSidecar: vi.fn(),
		notify: vi.fn(),
	};
	inlineInk.attachHost(host);
	await inlineInk.ensureLoaded(PATH);
}

function canvasStub() {
	return { width: 1280, height: 960, setCssStyles: vi.fn() };
}

function makeRig() {
	const win = {
		requestAnimationFrame: vi.fn((): number => 1),
		cancelAnimationFrame: vi.fn(),
		setTimeout: vi.fn((): number => 0),
		clearTimeout: vi.fn(),
		devicePixelRatio: 1,
		getComputedStyle: () => ({ fontSize: "16px" }),
	};
	const hostStyles: Record<string, string> = {};
	// The editor host (view.dom). A background tab is display:none: clientWidth/Height read 0.
	const host = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		parentElement: null,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
	};
	const pane = { clientWidth: 640, clientHeight: 480 };
	const scrollerRect = { left: 0, top: 0, width: 640, height: 480 };
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ ...scrollerRect }) };
	// The overlay container sits inside the scaled host: its visual rect is its layout box times the zoom.
	const containerRect = { width: 640, height: 480 };

	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		state: { field: () => ({ file: { path: PATH } }) }, // the real filePath() reads this
		dom: host,
		scrollDOM: scroller,
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] },
		scaleX: 1,
		requestMeasure: vi.fn(),
		measure: vi.fn(),
	};
	o.container = {
		setCssStyles: vi.fn(),
		getBoundingClientRect: () => ({ left: 0, top: 0, ...containerRect }),
		get offsetWidth() { return containerRect.width === 0 ? 0 : Math.round(containerRect.width / (o.pinchScaleNow as number)); },
		get offsetHeight() { return containerRect.height === 0 ? 0 : Math.round(containerRect.height / (o.pinchScaleNow as number)); },
	};
	o.frame = { locked: false };
	o.builder = null;
	o.mode = "ink";
	o.retiring = false;
	o.inUpdate = false;
	o.canvasMode = false; // :1644 field initialiser reads the global, off by default; applyCanvasMode sets it below
	o.router = {
		isStroking: false,
		setCanvasMomentumDisabled: vi.fn(),
		cameraTransformChanged: vi.fn(),
		refreshRect: vi.fn(),
	};
	o.wheelZoomRun = new WheelZoomRun();
	o.wheelZoomTimer = 0;
	o.cssScale = 1; o.fontZoom = 1; o.scale = 1;
	o.pinchScaleNow = 1;
	o.zoomFloor = MIN_PINCH_SCALE;
	o.pinchRasterScale = 1;
	o.pinchRefScale = null;
	o.pinchStartPan = { x: 0, y: 0 };
	o.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	o.pinchAnchor = null;
	o.pinchPending = null;
	o.pinchRaf = 0;
	o.pinchScrollAt = 0;
	o.pinchPreview = false;
	o.pinchGive = null;
	o.pinchHiddenCanvases = new Map();
	o.viewportGeneration = 0;
	o.panAnchorHold = null;
	o.scrollExpansion = null;
	o.mobileTools = null;
	o.scaleGeometryValid = true;
	o.viewportStyleDirty = false;
	o.refFontPx = 16;
	o.dpr = 1;
	o.cssWidth = 1280; o.cssHeight = 960;
	o.committedCanvas = canvasStub(); o.wetCanvas = canvasStub(); o.tailCanvas = canvasStub();
	o.highlightCanvas = canvasStub(); o.highlightWetCanvas = canvasStub();
	o.committedCtx = { setTransform: vi.fn() };
	o.highlightCtx = { setTransform: vi.fn() };
	o.wet = { applyDpr: vi.fn(), clear: vi.fn() };
	o.highlightWet = { applyDpr: vi.fn(), clear: vi.fn() };
	o.tail = {
		applyDpr: vi.fn(), clearAll: vi.fn(),
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	o.damage = { addAll: vi.fn() };
	o.prepareViewportLayout = () => true;
	o.viewportLayout = { width: 640, height: 480, baseTransform: "none", parent: pane, paneWidth: 640, paneHeight: 480, externalScale: 1 };
	o.panX = () => 0;
	o.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "repaint", "hideBlankPinchLayers", "cancelOverscrollBounce"]) o[name] = vi.fn();
	// commitCameraScale calls handleResize/syncBand internally as layout sinks (as in ZoomFloorLock.test.ts);
	// the tab hide/front events below call the REAL handleResize from the prototype.
	o.handleResize = vi.fn();
	o.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	o.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	o.syncBand = () => "none";
	o.firstSettleConsumer = () => false;

	// Record every commit attempt and its answer (wraps the real one).
	const commits: { next: number; ok: boolean }[] = [];
	o.commitCameraScale = function (this: Fields, ...args: Parameters<OverlayMethods["commitCameraScale"]>) {
		const ok = proto.commitCameraScale.apply(this, args);
		commits.push({ next: args[0], ok });
		return ok;
	};

	const call = <K extends keyof OverlayMethods>(k: K, ...a: Parameters<OverlayMethods[K]>): ReturnType<OverlayMethods[K]> =>
		(proto[k] as (...x: unknown[]) => ReturnType<OverlayMethods[K]>).apply(o, a);

	return {
		o, commits, call,
		scale: () => o.pinchScaleNow as number,
		/** Obsidian hides a non-active tab with display:none: every box reads 0 and the ResizeObserver fires. */
		hideTab() {
			host.clientWidth = 0; host.clientHeight = 0;
			pane.clientWidth = 0; pane.clientHeight = 0;
			scrollerRect.width = 0; scrollerRect.height = 0;
			containerRect.width = 0; containerRect.height = 0;
			call("handleResize");
		},
		/** The tab is fronted again: boxes come back at the zoom the host still carries; the ResizeObserver fires. */
		frontTab() {
			host.clientWidth = 640; host.clientHeight = 480;
			pane.clientWidth = 640; pane.clientHeight = 480;
			scrollerRect.width = 640; scrollerRect.height = 480;
			containerRect.width = 640; containerRect.height = 480;
			call("handleResize");
		},
		/** setScrollExpansionEnabled(on): the real module setter, then its per-instance loop body (:944-947) for this overlay. */
		setGlobalCanvas(on: boolean) {
			setScrollExpansionEnabled(on);
			if (!on) call("endWheelZoomRun");
			call("applyCanvasMode");
			(o.scheduleRepaint as (r: string) => void)("scroll-expansion-setting");
		},
		/** From here on a commit's own resize is the real handleResize, as in production, not the layout sink. */
		realResize() {
			o.handleResize = function (this: Fields) {
				return proto.handleResize.apply(this);
			};
		},
	};
}

beforeAll(async () => {
	await loadNote();
});
afterEach(() => {
	setScrollExpansionEnabled(false);
	vi.restoreAllMocks();
});

describe("InkOverlay-5-2: Infinite Canvas off resets a zoomed note once; a refused reset strands the zoom", () => {
	it("preconditions: note loaded; canvas on makes the note zoomable and the + / - control really zooms to 50%", () => {
		expect(inlineInk.isLoaded(PATH)).toBe(true);
		const r = makeRig();
		r.setGlobalCanvas(true);
		expect(r.call("canvasModeOn")).toBe(true);
		expect(r.call("getNoteViewportState").busy).toBe(false);
		expect(r.call("zoomNoteBy", 0.5)).toBe(true);
		expect(r.scale()).toBe(0.5);
	});

	it("CONTROL: canvas off on a VISIBLE zoomed note lands it at 100% (the one reset works when the editor has a box)", () => {
		const r = makeRig();
		r.setGlobalCanvas(true);
		expect(r.call("zoomNoteBy", 0.5)).toBe(true);
		expect(r.scale()).toBe(0.5);
		r.commits.length = 0;

		r.setGlobalCanvas(false);

		expect(r.call("canvasModeOn")).toBe(false);
		expect(r.commits).toEqual([{ next: 1, ok: true }]);
		expect(r.scale()).toBe(1);
	});

	it("background tab: canvas off while the zoomed note is hidden; when the tab fronts the note must be at 100% (or resettable)", () => {
		const r = makeRig();
		// The reset that runs when the tab fronts sizes the canvases through its own resize, so that one must be real.
		r.realResize();
		r.setGlobalCanvas(true);
		expect(r.call("zoomNoteBy", 0.5)).toBe(true);
		expect(r.scale()).toBe(0.5);

		// The user switches to another tab: the real handleResize takes its zero-size branch.
		r.hideTab();
		expect(r.o.scaleGeometryValid, "precondition: the real zero-size resize branch ran").toBe(false);
		expect(r.o.committedCanvas).toMatchObject({ width: 0, height: 0 }); // backings released (:3567-3579)

		// Infinite Canvas turned off in settings while this note sits in the background tab.
		r.commits.length = 0;
		r.setGlobalCanvas(false);
		expect(r.call("canvasModeOn")).toBe(false);
		// The one reset applyCanvasMode tries: attempted at 1, refused by the commit guard.
		expect(r.commits, "applyCanvasMode's single reset attempt and its answer").toEqual([{ next: 1, ok: false }]);

		// The user fronts the tab again: the real handleResize takes its non-zero branch.
		r.commits.length = 0;
		r.frontTab();
		expect(r.o.scaleGeometryValid, "precondition: fronting re-validated the geometry (:3631)").toBe(true);
		expect((r.o.committedCanvas as { width: number }).width, "precondition: fronting reallocated the backings").toBeGreaterThan(0);

		// CORRECT: with the canvas off the note is stock Obsidian, i.e. at 100 percent.
		expect.soft(r.scale(), "note still zoomed after Infinite Canvas off + tab fronted").toBe(1);
		expect.soft(r.call("getNoteViewportState").zoom, "viewport state still reports the old zoom").toBe(1);

		// And if it were not reset automatically, the user must at least be able to undo it.
		const reset = r.call("resetNoteZoom");
		expect.soft(reset || r.scale() === 1, "reset-to-100% control refused (busy because canvas is off)").toBe(true);
		expect.soft(r.call("fitHandwriting") !== "busy" || r.scale() === 1, "Fit refused (busy) on a note left zoomed").toBe(true);
		expect.soft(r.scale(), "no control could bring the note back to 100%").toBe(1);
	});

	it("live stroke: canvas off while a stroke owns the frame skips the reset; after pen-up the note must be at 100%", () => {
		const r = makeRig();
		r.setGlobalCanvas(true);
		expect(r.call("zoomNoteBy", 0.5)).toBe(true);
		expect(r.scale()).toBe(0.5);

		(r.o.frame as { locked: boolean }).locked = true; // pen down: the stroke owns the frame
		r.commits.length = 0;
		r.setGlobalCanvas(false);
		expect(r.call("canvasModeOn")).toBe(false);
		expect(r.commits, "applyCanvasMode skipped the reset under the live stroke").toEqual([]);
		(r.o.frame as { locked: boolean }).locked = false; // pen up
		// The rig cannot run the whole penUp; it runs the retry penUp makes right after frame.end(), and the
		// source pin below holds penUp to making it: penUp hands the gesture to endPenGesture first, and that
		// method ends the frame and retries the reset before anything else.
		expect(overlaySource.replace(/\r\n/g, "\n")).toMatch(/private penUp\(ev\?: PointerEvent\): void \{[\s\S]{0,300}?this\.endPenGesture\(ev\);[\s\S]*?private endPenGesture\(ev\?: PointerEvent\): void \{[\s\S]{0,200}?this\.frame\.end\(\);[\s\S]{0,120}?this\.retryCanvasOffReset\(\);/);
		r.call("retryCanvasOffReset");

		expect.soft(r.scale(), "note still zoomed after Infinite Canvas off during a stroke").toBe(1);
		const reset = r.call("resetNoteZoom");
		expect.soft(reset || r.scale() === 1, "reset-to-100% control refused (busy because canvas is off)").toBe(true);
	});

	it.each([0.5, 2])("background tab zoomed to %s: the first front leaves the ink canvases sized for 100 percent", (zoom) => {
		const r = makeRig();
		// The commit's own resize is the real one here, as in production, so the sizing it does is the sizing kept.
		r.realResize();
		r.setGlobalCanvas(true);
		expect(r.call("zoomNoteBy", zoom)).toBe(true);
		r.hideTab();
		r.setGlobalCanvas(false);
		r.frontTab();
		expect(r.scale(), "precondition: the pending reset ran when the tab fronted").toBe(1);

		const c = r.o.committedCanvas as { width: number; height: number; setCssStyles: { mock: { calls: unknown[][] } } };
		const calls = c.setCssStyles.mock.calls;
		const box = calls[calls.length - 1]?.[0] as { width: string; height: string; transform: string };
		expect(r.o.committedBacking, "backing at 100%").toBe(1);
		expect([c.width, c.height], "canvas backing size at 100%").toEqual([640, 480]);
		expect(box, "canvas layer box at 100%").toMatchObject({ width: "640px", height: "480px", transform: "" });
	});
});

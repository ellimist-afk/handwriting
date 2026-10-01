/**
 * Grid paper's vertical-rule box follows the note's content height.
 *
 * syncGridPaperBox sized the box from the sizer when it ran, and nothing on the content-growth path ran it again
 * with Infinite Canvas off and no ink (no extent spacer): the rules stopped partway down a grown note, or a
 * shortened one kept the old height as blank scroll room.
 *
 * Asserted: after the content grows, the box covers the content; after it shrinks below the pane, the box adds no
 * scroll range.
 *
 * Rig: the real InkOverlayPlugin off its prototype. Real: onContentResize (the content ResizeObserver's callback),
 * syncGridPaperBox, updatePaperSpacing, writePaperVars, capturePaperOrigin, syncCamera, syncBand, updateExtent,
 * shrinkSideways, deferPinchRaster, surfaceExtents, FrontierCache. Stubbed: pure layout readers inside
 * syncCamera/updateExtent and scheduleRepaint (recorded; the rig then runs the repaint's only paper-reaching steps
 * itself: syncBand, handleResize's paper line if the band resized, and updateExtent). The scroller is a fake whose
 * scrollHeight counts the absolutely placed box and spacer like a browser's would.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;
// Node environment: `sizer instanceof HTMLElement` needs the global to exist.
if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === "undefined") {
	(globalThis as { HTMLElement?: unknown }).HTMLElement = class ProbeHTMLElement {};
}

import { InkOverlayPlugin } from "./InkOverlay";
import { surfaceExtents } from "./SurfaceExtent";
import { FrontierCache } from "./FrontierCache";
import { WheelZoomRun } from "./WheelZoom";

type Fields = Record<string, unknown>;
type Call = (...args: unknown[]) => unknown;

interface FakeEl {
	cls: string;
	parentElement: unknown;
	w: number; h: number; left: number; top: number;
	readonly nextElementSibling: unknown;
	setCssStyles(st: Record<string, string>): void;
	style: { setProperty(): void; removeProperty(): void };
	remove(): void;
}

function makeRig(path: string, contentAtMount: number) {
	const state = { contentH: contentAtMount };
	const H = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement;
	// `.cm-sizer`: the content box syncGridPaperBox reads.
	const sizer = Object.create(H.prototype) as Record<string, unknown>;
	Object.defineProperties(sizer, {
		offsetTop: { get: () => 0 },
		offsetLeft: { get: () => 0 },
		offsetWidth: { get: () => 700 },
		offsetHeight: { get: () => state.contentH },
	});
	const children: unknown[] = [sizer];
	const classes = new Set<string>();
	const els: FakeEl[] = [];
	const makeEl = (cls: string): FakeEl => {
		const el: FakeEl = {
			cls, parentElement: null, w: 0, h: 0, left: Number.NaN, top: Number.NaN,
			get nextElementSibling() { const i = children.indexOf(el); return i >= 0 ? children[i + 1] ?? null : null; },
			setCssStyles(st) {
				if (st.width !== undefined) el.w = Number.parseFloat(st.width);
				if (st.height !== undefined) el.h = Number.parseFloat(st.height);
				if (st.left !== undefined) el.left = Number.parseFloat(st.left);
				if (st.top !== undefined) el.top = Number.parseFloat(st.top);
			},
			style: { setProperty: () => undefined, removeProperty: () => undefined },
			remove() { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); el.parentElement = null; },
		};
		els.push(el);
		return el;
	};
	const box = (): FakeEl | undefined => els.find(e => e.cls === "handwriting-paper-grid-column" && e.parentElement);
	const spacer = (): FakeEl | undefined => els.find(e => e.cls === "handwriting-surface-extent" && e.parentElement);
	const scroller = {
		isConnected: true,
		scrollLeft: 0, scrollTop: 0,
		clientWidth: 800, clientHeight: 600, clientTop: 0, clientLeft: 0,
		get firstElementChild() { return children[0] ?? null; },
		get firstChild() { return children[0] ?? null; },
		// Like a browser: the content, plus every absolutely placed child of the relative scroller.
		get scrollWidth() { return Math.max(800, 700, box()?.w ?? 0, (spacer()?.left ?? -1) + 1); },
		get scrollHeight() { return Math.max(600, state.contentH, box()?.h ?? 0, (spacer()?.top ?? -1) + 1); },
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
		classList: {
			add: (c: string) => { classes.add(c); },
			remove: (c: string) => { classes.delete(c); },
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
		},
		style: { setProperty: () => undefined, removeProperty: () => undefined },
		setCssStyles: () => undefined,
		insertBefore(node: FakeEl, ref: unknown) {
			const at = children.indexOf(node); if (at >= 0) children.splice(at, 1);
			const i = ref ? children.indexOf(ref) : children.length;
			children.splice(i < 0 ? children.length : i, 0, node);
			node.parentElement = scroller;
		},
		createDiv({ cls }: { cls: string }) { const el = makeEl(cls); children.push(el); el.parentElement = scroller; return el; },
	};
	const hostStyles: Record<string, string> = {};
	const win = {
		devicePixelRatio: 1,
		setTimeout: () => 1,
		clearTimeout: () => undefined,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => undefined,
		// Global grid paper: the stylesheet states --handwriting-paper-grid: 1 on the scroller.
		getComputedStyle: (el: unknown) => ({
			position: "relative", overflowX: "hidden", overflowY: "auto", fontSize: "16px", paddingTop: "0px",
			getPropertyValue: (name: string) => (el === scroller && name === "--handwriting-paper-grid" ? "1" : ""),
		}),
	};
	const contentDOM = {
		parentElement: null,
		children: [] as unknown[],
		getBoundingClientRect: () => ({ left: 100, top: 0, right: 800, bottom: state.contentH, width: 700, height: state.contentH }),
	};
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		state: { field: () => ({ file: { path } }) },
		dom: {
			isConnected: true,
			ownerDocument: { defaultView: win, body: {} },
			style: {
				getPropertyValue: (n: string) => hostStyles[n] ?? "",
				getPropertyPriority: () => "",
				setProperty: (n: string, v: string) => { hostStyles[n] = v; },
				removeProperty: (n: string) => { delete hostStyles[n]; },
			},
		},
		scrollDOM: scroller,
		contentDOM,
		documentTop: 0, scaleX: 1, scaleY: 1,
	};
	// Field initialisers the real methods read (Object.create runs none). Infinite Canvas OFF, no ink, no pen.
	o.canvasMode = false;
	o.router = { setCanvasMomentumDisabled: () => undefined, refreshRect: () => undefined, cameraTransformChanged: () => undefined };
	o.container = {
		offsetWidth: 800,
		setCssStyles: () => undefined,
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
	};
	o.frame = { locked: false };
	o.builder = null;
	o.band = null;
	o.bandFreeScrollWidth = null;
	o.bandSyncDeferred = false;
	o.pinchPreview = false;
	o.pinchScrollAt = 0;
	o.pinchScaleNow = 1;
	o.wheelZoomRun = new WheelZoomRun();
	o.wheelZoomTimer = 0;
	let camState = { x: 0, y: 0, zoom: 1 };
	o.camera = {
		get snapshot() { return { ...camState }; },
		get x() { return camState.x; }, get y() { return camState.y; }, get zoom() { return camState.zoom; },
		setState: (x: number, y: number, zoom: number) => { camState = { x, y, zoom }; },
	};
	o.frontierCache = new FrontierCache();
	o.fontZoom = 1;
	o.cssScale = 1;
	o.scale = 1;
	o.cssWidth = 800;
	o.cssHeight = 600;
	o.dpr = 1;
	o.viewportLayout = null;
	o.lastExtentInputs = null;
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.scrollPositionPatched = false;
	o.lastReach = null;
	o.extentFrontierSeen = new Map<string, number>();
	o.shrinkStepped = new Map<string, number>();
	o.shrinksSeen = new Map<string, number>();
	o.sidewaysView = null;
	o.bandMarginReleasePending = false;
	o.scrollExpansion = null;
	// Paper state (field initialisers).
	o.paperKindWatch = [];
	o.paperGridBox = null;
	o.paperGridBoxSize = null;
	o.paperGridBoxPanX = "";
	o.paperPanWritten = null;
	o.paperOriginLayout = null;
	o.paperOriginLeft = null;
	o.paperFontPx = 16;
	o.paperRestZoom = Number.NaN;
	o.paperWritten = new Map<string, string>();
	o.previewPaperEl = null;
	o.previewPaperSettling = false;
	o.paperSnapResidual = { x: 0, y: 0 };
	o.paperRewrapY = 0;
	o.paperColumnDrift = 0;
	// syncCamera's state: the font has NOT changed (typing).
	o.contentStyle = { fontSize: "16px", paddingTop: "0px" };
	o.lastSyncFontStr = "16px";
	o.refFontPx = 16;
	o.rasterPan = null;
	o.lastPaintCam = null;
	o.anchorGateDue = false;
	o.anchorAdoptionEvent = false;
	o.anchorCameraYLayout = Number.NaN;
	o.scaleGeometryValid = true;
	// Pure layout readers: fixed values (none of them touches paper or the box).
	o.columnLeft = () => 100;
	o.documentTopUnpanned = () => 0;
	o.panX = () => 0;
	o.panY = () => 0;
	o.resolveColumnLeft = (x: number | null) => x ?? 100;
	o.unpanX = (x: number | null) => x;
	o.watchOriginLine = () => undefined;
	o.anchorCameraY = () => null;
	o.ownedColumnLayoutLeft = () => null;
	o.canonicalCameraY = (y: number) => y;
	o.gateAnchorParity = () => undefined;
	const repaints: string[] = [];
	o.scheduleRepaint = (why?: string) => { repaints.push(why ?? "default"); };

	const call = (name: string, ...args: unknown[]): unknown => (o[name] as Call).call(o, ...args);
	const bandResults: string[] = [];
	/** The paper-reaching steps of repaint(): syncBand (handleResize's paper line if RESIZED), updateExtent. */
	const repaint = (): void => {
		const r = call("syncBand") as string;
		bandResults.push(r);
		if (r === "resized") call("updatePaperSpacing");
		call("updateExtent");
	};
	return {
		o, state, scroller, classes, repaints, bandResults, call, box, spacer,
		/** Mount: handleResize's paper line after the first band sync, then the first repaint. */
		mount() {
			call("syncBand");
			call("updatePaperSpacing");
			call("updateExtent", true);
		},
		/** A text edit that changes the content height: CM update() (font unchanged: scheduleRepaint only),
		 *  the content ResizeObserver callback, the repaint it schedules, then a forced settle pass. */
		edit(nextContentH: number) {
			state.contentH = nextContentH;
			o.scheduleRepaint = (why?: string) => { repaints.push(why ?? "default"); };
			(o.scheduleRepaint as Call)("scroll");
			// The content ResizeObserver's callback, then the repaint it schedules.
			call("onContentResize");
			repaint();
			call("updateExtent", true);
		},
	};
}

describe("grid paper's vertical-rule box follows the note's content", () => {
	it("(a) typing past one pane: the box must grow to cover the content", () => {
		const r = makeRig("grid-box-grow.md", 1000);
		r.mount();
		const b0 = r.box();
		// PRECONDITIONS: the box exists, is the scroller's first child, the split class is on (the scroller paints
		// only the horizontal layer), it was sized from the content at mount, and there is no spacer (no grant).
		expect(b0, "grid box was created").toBeDefined();
		expect(r.scroller.firstElementChild).toBe(b0);
		expect(r.classes.has("handwriting-paper-grid-split")).toBe(true);
		expect(b0!.h, "box sized from content at mount").toBe(1000);
		expect(r.o.spacer, "no extent spacer: Infinite Canvas off, no ink, no pen").toBeNull();
		expect(surfaceExtents.get("grid-box-grow.md")).toEqual({ x: 0, y: 0 });

		r.edit(3000);
		const b1 = r.box()!;
		console.log(`[grid box grow] content 1000 -> 3000; box h ${b1.h}; scrollHeight ${r.scroller.scrollHeight}; band ${JSON.stringify(r.bandResults)}; repaints ${JSON.stringify(r.repaints)}; spacer ${r.o.spacer ? "placed" : "none"}`);
		// Precondition of the trigger held through the edit: still no spacer, font unchanged.
		expect(r.o.spacer).toBeNull();
		expect(r.bandResults.includes("resized"), "band resized (would heal via handleResize)").toBe(false);
		// CORRECT: the vertical-rule box covers the content after it grew.
		expect.soft(b1.h, `box height ${b1.h} does not cover content bottom 3000: vertical rules stop at ${b1.h}px`).toBeGreaterThanOrEqual(3000);

		// CONTROL: the same rig through a path that DOES run syncGridPaperBox (a pane resize / font change /
		// paper change reaches updatePaperSpacing) sizes the box to the content: the measurement is honest.
		r.call("updatePaperSpacing");
		console.log(`[grid box grow] control after updatePaperSpacing: box h ${r.box()!.h}`);
		expect(r.box()!.h, "control: updatePaperSpacing re-sizes the box from the current content").toBe(3000);
	});

	it("(a') deleting text below one pane: the box must not keep the old height as blank scroll range", () => {
		const r = makeRig("grid-box-shrink.md", 3000);
		r.mount();
		expect(r.box()!.h, "box sized from content at mount").toBe(3000);
		expect(r.o.spacer).toBeNull();

		r.edit(400);
		const b1 = r.box()!;
		const phantom = r.scroller.scrollHeight - r.scroller.clientHeight;
		console.log(`[grid box shrink] content 3000 -> 400; box h ${b1.h}; scrollHeight ${r.scroller.scrollHeight}; scroll range past pane ${phantom}; band ${JSON.stringify(r.bandResults)}`);
		expect(r.o.spacer).toBeNull();
		expect(r.bandResults.includes("resized")).toBe(false);
		// CORRECT: the box is no taller than max(pane, content), so it adds no scroll range past a short note.
		expect.soft(b1.h, `box height ${b1.h} exceeds max(pane 600, content 400)`).toBeLessThanOrEqual(600);
		expect.soft(phantom, "scroll range past the pane on a note shorter than the pane").toBe(0);
	});
});

/**
 * The zoom-out overview picture, held by behaviour on a bare overlay: what a zoom preview's first frame holds up (heldRasterSource)
 * when no extent raster or stand-in is held, how it goes up (putUpHeldRaster: beside the pane's canvases, cut off the start view),
 * and the scale a landing builds it at (overviewScale, armOverviewBuild). The render suite holds the pixels; this file holds the
 * branches a render fixture reaches only at one zoom.
 */
import { describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";
import { StrokeIndex } from "../ink/StrokeIndex";
import { inkLookKey, inlineInk, InkOverlayPlugin } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { overviewScale } from "./InkOverlayOverview";
import { EXTENT_PIECE_MS, extentRasterFits } from "./InkOverlayConstants";

const PATH = "overview-unit.md";

function canvas(w: number, h: number) {
	const style: Record<string, string> = { width: `${w / 2}px`, height: `${h / 2}px`, transform: "", visibility: "" };
	return { width: w, height: h, style, setCssStyles(o: Record<string, string>) { Object.assign(style, o); }, remove() {} } as unknown as HTMLCanvasElement;
}

function stroke(x: number, y: number, w: number, h: number, tool = "pen") {
	return { tool, bbox: { x, y, width: w, height: h } } as never;
}

/** A bare overlay at start scale `from`, this frame at `now`, with the ink `strokes` and nothing held but what a cell adds. */
function overlay(from: number, now: number, strokes: unknown[]) {
	const o = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
	const committed = canvas(1600, 1200), highlight = canvas(1600, 1200);
	Object.assign(o, {
		selection: new SelectionModel(), filePath: () => PATH, noteStrokes: () => strokes, committedStrokes: (s: unknown) => s, committedBacking: 2, dpr: 2,
		cssScale: now, pinchScaleNow: now, pinchAnchor: { fromScale: from }, extentRaster: null, standIn: null, overview: null,
		highlightPairDeferred: false, committedCanvas: committed, highlightCanvas: highlight, cssWidth: 800, cssHeight: 600,
		lastPaintCam: { x: 100, y: 200, zoom: from }, heldRaster: null, pinchComposite: false, pinchHiddenCanvases: new Map(),
		repaintScrollOnly: false, frame: { locked: false }, builder: null, bounceState: null, retiring: false, pinchRefScale: null, pinchPreview: false,
	});
	return o;
}

/** winRef is a getter on the prototype with no setter, so a plain assignment throws: shadow it on the instance. */
function shadowWin(o: object, win: Record<string, unknown>) {
	Object.defineProperty(o, "winRef", { value: win, configurable: true });
}

/** An overview picture of `strokes` drawn at zoom `zoom`, side scale `s` of backing 2. */
function picture(strokes: unknown[], zoom: number, s: number) {
	return {
		path: PATH, pen: canvas(4000, 9000), hl: null, at: { x: 0, y: 0, zoom }, backing: 2 * s, dpr: 2, look: inkLookKey(),
		strokes: strokes as readonly InkStroke[], count: strokes.length, generation: inlineInk.generation(PATH),
	};
}

describe("what a zoom preview's first frame holds when no extent raster or stand-in is held", () => {
	it("a zoom out from 4.5x holds the overview at its world place, at the start zoom over its scale, cut off the start view", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(4.5, 4.2, ink);
		o.overview = picture(ink, 4.5, 0.55);
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, ink as never);
		expect(pick?.src).toBe(o.overview);
		expect(pick?.clip).toBe(true);
		expect(pick?.f).toBeCloseTo(1 / 0.55, 9);
		expect(pick?.offX).toBeCloseTo(100 * 4.5 * 2, 9);
		expect(pick?.offY).toBeCloseTo(200 * 4.5 * 2, 9);
	});

	it("a zoom out from an over-cap start below 100 percent holds the overview", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(0.9, 0.8, ink);
		o.overview = picture(ink, 0.9, 0.7);
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)?.src).toBe(o.overview);
	});

	it("a zoom out from exactly 100 percent holds the overview", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(1, 0.95, ink);
		o.overview = picture(ink, 1, 1);
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)?.src).toBe(o.overview);
	});

	it("a zoom out from 110 percent holds the overview", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(1.1, 1.05, ink);
		o.overview = picture(ink, 1.1, 1);
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)?.src).toBe(o.overview);
	});

	it("a zoom out from 1 minus 3e-6 with the extent raster held takes the extent raster, unclipped, as before", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const from = 1 - 3e-6;
		const o = overlay(from, 0.9, ink);
		o.overview = picture(ink, from, 1);
		const ext = { pen: canvas(800, 800), hl: null, kx: 0, ky: 0, cam0: { x: 100, y: 200, zoom: from }, backing: 2, count: 1, generation: 0,
			world: { x0: 100, y0: 200, x1: 100 + 800 / (from * 2), y1: 200 + 800 / (from * 2) } };
		o.extentRaster = ext as never;
		o.extentHolds = () => true;
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, ink as never);
		expect(pick?.src).toBe(ext);
		expect(pick?.clip).toBe(false);
		expect(pick?.f).toBe(1);
	});

	it("an extent raster held while the camera moved off whole device px is held the overview's way: clipped, at f 1, at its fractional offset", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(0.85, 0.8, ink);
		o.overview = picture(ink, 0.85, 1);
		// k = 0.85 * 2: the camera sits half a device px below the raster's own grid, a whole 3 px across it.
		const k = 0.85 * 2;
		const ext = { pen: canvas(800, 800), hl: null, kx: 4, ky: 6, cam0: { x: 100 - 3 / k, y: 200 - 0.5 / k, zoom: 0.85 }, backing: 2, count: 1, generation: 0,
			world: { x0: 100 - 3 / k + 4 / k, y0: 200 - 0.5 / k + 6 / k, x1: 100 - 3 / k + 804 / k, y1: 200 - 0.5 / k + 806 / k } };
		o.extentRaster = ext as never;
		o.extentHolds = () => true;
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, ink as never);
		expect(pick?.src).toBe(ext);
		expect(pick?.clip).toBe(true);
		expect(pick?.f).toBe(1);
		expect(pick?.offX).toBeCloseTo(3 - 4, 9);
		expect(pick?.offY).toBeCloseTo(0.5 - 6, 9);
	});

	it("a stroke added since the overview was drawn refuses it", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(4.5, 4.2, ink);
		o.overview = picture(ink, 4.5, 0.55);
		ink.push(stroke(60, 60, 10, 10));
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)).toBe(null);
	});

	it("a zoom in holds nothing", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(4.5, 4.8, ink);
		o.overview = picture(ink, 4.5, 0.55);
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)).toBe(null);
	});
});

describe("the overview going up", () => {
	it("goes up right after the scroller with the pane's canvases shown and one even-odd clip off the start view box", () => {
		// The store holds no stroke for this path, so the held count the first write compares is 0.
		const ink: unknown[] = [];
		const o = overlay(4.5, 4.2, ink);
		o.overview = picture(ink, 4.5, 0.55);
		o.overviewHolds = () => true;
		const inserted: unknown[] = [];
		const innerStyle: Record<string, string> = {};
		const inner = { style: innerStyle, appendChild() {} };
		const clip = { firstElementChild: inner, setCssStyles() {}, remove() {} };
		const host = { style: {}, clientWidth: 900, clientHeight: 700, insertBefore: (el: unknown) => inserted.push(el) };
		const scroller = { style: {}, parentElement: host, offsetTop: 0, clientTop: 0, offsetLeft: 0, clientLeft: 0, clientWidth: 900, clientHeight: 700, scrollLeft: 0, scrollTop: 0, nextSibling: null };
		Object.assign(o, { view: { dom: host, scrollDOM: scroller }, heldRasterClip: clip, container: { style: { left: "0px", top: "0px", transform: "" } } });
		o.putUpHeldRaster();
		expect(o.heldRaster?.src).toBe(o.overview);
		expect(inserted).toEqual([clip]);
		expect(o.committedCanvas.style.visibility).toBe("");
		expect(o.highlightCanvas.style.visibility).toBe("");
		expect(innerStyle.clipPath).toContain("evenodd");
		expect(innerStyle.clipPath).toContain("0px 0px, 0px 600px, 800px 600px, 800px 0px, 0px 0px");
	});

	it("a later frame's try puts up a clipped pick only: an extent raster at whole device px stays down", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(0.9, 0.8, ink);
		const ext = { pen: canvas(800, 800), hl: null, kx: 0, ky: 0, cam0: { x: 100, y: 200, zoom: 0.9 }, backing: 2, count: 1, generation: 0,
			world: { x0: 100, y0: 200, x1: 100 + 800 / 1.8, y1: 200 + 800 / 1.8 } };
		Object.assign(o, { extentRaster: ext, extentHolds: () => true, lastPaintCam: { x: 100, y: 200, zoom: 0.9 } });
		expect(o.heldRasterSource(PATH, o.lastPaintCam!, ink as never)?.clip, "premise: the pick is the unclipped extent raster").toBe(false);
		const inserted: unknown[] = [];
		const inner = { style: {}, appendChild() {} };
		const clip = { firstElementChild: inner, setCssStyles() {}, remove() {} };
		const host = { style: {}, clientWidth: 900, clientHeight: 700, insertBefore: (el: unknown) => inserted.push(el) };
		const scroller = { style: {}, parentElement: host, offsetTop: 0, clientTop: 0, offsetLeft: 0, clientLeft: 0, clientWidth: 900, clientHeight: 700, scrollLeft: 0, scrollTop: 0, nextSibling: null };
		Object.assign(o, { view: { dom: host, scrollDOM: scroller }, heldRasterClip: clip, container: { style: { left: "0px", top: "0px", transform: "" } } });
		o.putUpHeldRaster(true);
		expect(o.heldRaster ?? null).toBe(null);
		expect(inserted).toEqual([]);
		expect(o.committedCanvas.style.visibility).toBe("");
	});
});

/**
 * A gesture whose first frame is no zoom out, through the real applyPinchScale on a bare overlay: every other method it calls is a
 * no-op, and put-up records how it was asked and holds what heldRasterSource picks, on its own clip-only terms.
 */
describe("a zoom preview that turns into a zoom out", () => {
	function rig(withOverview: boolean) {
		const ink = [stroke(5000, 5000, 555, 1458)];
		const o = overlay(4.5, 4.5, ink);
		if (withOverview) o.overview = picture(ink, 4.5, 0.5);
		const asked: (boolean | undefined)[] = [];
		Object.assign(o, {
			pinchAnchor: { fromScale: 4.5, focalX: 0, focalY: 0 }, viewportLayout: { width: 800, height: 600, baseTransform: "none" }, fontZoom: 1,
			putUpHeldRaster(this: InkOverlayPlugin, clipOnly?: boolean) {
				asked.push(clipOnly);
				const pick = this.heldRasterSource(PATH, this.lastPaintCam!, ink as never);
				if (pick && (!clipOnly || pick.clip)) this.heldRaster = { src: pick.src } as never;
			},
		});
		const isMethod = (k: string) => {
			for (let p: object | null = InkOverlayPlugin.prototype; p; p = Object.getPrototypeOf(p)) {
				const d = Object.getOwnPropertyDescriptor(p, k);
				if (d) return typeof d.value === "function";
			}
			return false;
		};
		const REAL = new Set(["applyPinchScale", "heldRasterSource", "overviewHolds"]);
		const bare = new Proxy(o, {
			get(t, k, r) {
				if (typeof k === "string" && !Object.prototype.hasOwnProperty.call(t, k) && !REAL.has(k) && isMethod(k))
					return k === "prepareViewportLayout" ? () => true : () => undefined;
				return Reflect.get(t, k, r);
			},
		});
		const frame = (next: number) => (bare as unknown as { applyPinchScale(n: number, s: boolean): void }).applyPinchScale(next, false);
		return { o, asked, frame };
	}

	it("a first frame at 4.6 holds nothing; the first zoom-out frame after it puts the overview up, clipped, once", () => {
		const { o, asked, frame } = rig(true);
		frame(4.6);
		expect(o.heldRaster ?? null, "premise: the zoom-in frame held nothing").toBe(null);
		frame(4.0);
		expect(o.heldRaster?.src).toBe(o.overview);
		frame(3.8);
		expect(asked).toEqual([undefined, true]);
	});

	it("a first frame that was a zoom out and held nothing owes no second try", () => {
		const { o, asked, frame } = rig(false);
		frame(4.2);
		frame(4.0);
		expect(o.heldRaster ?? null).toBe(null);
		expect(asked).toEqual([undefined]);
	});
});

describe("the overview let go", () => {
	it("an extent raster finishing lets the overview go and releases its canvas", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(0.9, 0.9, ink);
		const ov = picture(ink, 0.9, 0.7);
		o.overview = ov;
		const pen = Object.assign(canvas(800, 800), { getContext: () => ({}) });
		o.extentBuild = { path: PATH, pen, hl: null, kx: 0, ky: 0, cam0: { x: 0, y: 0, zoom: 0.9 }, at: { x: 0, y: 0, zoom: 0.9 }, world: null,
			backing: 2, dpr: 2, look: inkLookKey(), strokes: ink, generation: inlineInk.generation(PATH), count: 1, next: 1, timer: 0 } as never;
		o.extentBuildHolds = () => true;
		o.extentPieceAllowed = () => true;
		o.runExtentPiece();
		expect(o.extentRaster?.pen).toBe(pen);
		expect(o.overview).toBe(null);
		expect(ov.pen.width).toBe(0);
	});

	it("releasing the backings lets the overview go and releases its canvas", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(4.5, 4.5, ink);
		const ov = picture(ink, 4.5, 0.55);
		o.overview = ov;
		o.dropStandIn = () => {};
		o.releaseBackings();
		expect(o.overview).toBe(null);
		expect(ov.pen.width).toBe(0);
	});

	/**
	 * The real unmount on a bare overlay whose every other method is a no-op, with no container: releaseBackings, which drops
	 * the overview too, is then never reached, so only unmount's own drop can let it go.
	 */
	function unmounting(ink: unknown[]) {
		const o = overlay(4.5, 4.5, ink);
		const cleared: unknown[] = [];
		shadowWin(o, { clearTimeout: (t: unknown) => cleared.push(t), cancelAnimationFrame() {} });
		Object.assign(o, {
			container: null, view: { dom: {}, scrollDOM: { classList: { remove() {} } } }, emptyNoticeGate: { forgetAll() {} },
			wheelZoomRun: { cancel() {} },
		});
		const real = new Set<PropertyKey>(["unmount", "dropOverview"]);
		const rig = new Proxy(o, {
			get(t, k) {
				if (Object.prototype.hasOwnProperty.call(t, k) || real.has(k)) return Reflect.get(t, k);
				const v = Reflect.get(t, k);
				return typeof v === "function" ? () => undefined : v;
			},
		});
		return { o, rig, cleared };
	}

	it("an unmount with no container lets a held overview go and releases its canvas", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const { o, rig } = unmounting(ink);
		const ov = picture(ink, 4.5, 0.55);
		o.overview = ov;
		rig.unmount();
		expect(o.overview).toBe(null);
		expect(ov.pen.width).toBe(0);
	});

	it("an unmount with no container stops an overview build and releases its canvas", () => {
		const ink = [stroke(0, 0, 50, 50)];
		const { o, rig, cleared } = unmounting(ink);
		const pen = canvas(800, 800);
		o.overviewBuild = { ...picture(ink, 4.5, 0.55), pen, w: 800, h: 800, hasHl: false, floor: 0, next: 0, timer: 7 } as never;
		rig.unmount();
		expect(o.overviewBuild).toBe(null);
		expect(cleared).toContain(7);
		expect(pen.width).toBe(0);
	});

	it.each([
		{ mobile: true, kept: false },
		{ mobile: false, kept: true },
	])("an extent build armed with the overview held: on mobile ($mobile) the overview goes first, else it is kept", ({ mobile, kept }) => {
		const ink = [stroke(0, 0, 50, 50)];
		const o = overlay(1, 1, ink);
		const ov = picture(ink, 1, 1);
		o.overview = ov;
		o.scheduleExtentPiece = () => {};
		const was = Platform.isMobile;
		Platform.isMobile = mobile;
		try {
			o.armExtentBuild({ x: 0, y: 0, zoom: 1 }, ink as readonly InkStroke[], null as never);
		} finally {
			Platform.isMobile = was;
		}
		expect(o.extentBuild?.strokes).toBe(ink);
		expect(o.overview).toBe(kept ? ov : null);
		expect(ov.pen.width).toBe(kept ? 4000 : 0);
	});
});

describe("the scale a landing draws the overview at", () => {
	it("the whole ink at scale 1 when it fits, else the largest scale under 1 that fits the extent caps", () => {
		expect(overviewScale(3000, 4000)).toBe(1);
		// The exam note at 4.5x: 65.6 million device px over the 20 million cap.
		const s = overviewScale(5000, 13_120);
		expect(s).toBeGreaterThan(0.5);
		expect(s).toBeLessThan(0.6);
		expect(extentRasterFits(Math.ceil(5000 * s) + 4, Math.ceil(13_120 * s) + 4)).toBe(true);
		expect(extentRasterFits(Math.ceil(5000 * s * 1.01) + 4, Math.ceil(13_120 * s * 1.01) + 4)).toBe(false);
	});

	it("a 4.5x landing arms one build of the whole ink at the landed zoom, its backing cut to the scale that fits", () => {
		const ink = [stroke(0, 0, 555, 1458)];
		const o = overlay(4.5, 4.5, ink);
		const frames: unknown[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: unknown) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		o.armOverviewBuild({ x: 0, y: 0, zoom: 4.5 }, ink as never);
		const b = o.overviewBuild!;
		expect(b.at.zoom).toBe(4.5);
		expect(b.backing).toBeLessThan(2);
		expect(extentRasterFits(b.w, b.h)).toBe(true);
		expect(frames).toHaveLength(1);
		o.armOverviewBuild({ x: 0, y: 0, zoom: 4.5 }, ink as never);
		expect(o.overviewBuild).toBe(b);
	});
});

/**
 * The whole repaint that arms it (paintCommittedWork), on a bare overlay at 4.5x with no extent raster, no stand-in and no build:
 * the ink lies off the view, so the paint by path draws nothing, and the layers' context takes any call.
 */
describe("the whole repaint that arms the overview", () => {
	function painting(from: number) {
		const ink = [stroke(5000, 5000, 555, 1458)];
		const o = overlay(from, from, ink);
		const frames: unknown[] = [];
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		shadowWin(o, { requestAnimationFrame: (fn: unknown) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		Object.assign(o, {
			committedCtx: ctx, highlightCtx: ctx, extentMayBuild: false, extentArmAsked: false, extentBuild: null, inQueuedFrame: true,
			markCommittedPaint() {}, usableExtent: () => null,
		});
		const paint = () => o.paintCommittedWork({ x: 0, y: 0, zoom: from }, "all", ink as never);
		return { o, frames, paint };
	}

	it("a whole paint at 4.5x with nothing held or building arms the overview build at its camera", () => {
		const { o, frames, paint } = painting(4.5);
		paint();
		expect(o.overviewBuild?.at.zoom).toBe(4.5);
		expect(frames).toHaveLength(1);
	});

	it("a whole paint under a pinch hold arms nothing", () => {
		const { o, frames, paint } = painting(4.5);
		o.pinchRefScale = 4.5;
		paint();
		expect(o.overviewBuild ?? null).toBe(null);
		expect(frames).toHaveLength(0);
	});

	it("a second whole paint at the same camera arms nothing new", () => {
		const { o, frames, paint } = painting(4.5);
		paint();
		const b = o.overviewBuild;
		paint();
		expect(o.overviewBuild).toBe(b);
		expect(frames).toHaveLength(1);
	});
});

/**
 * The build run to its picture: a whole repaint at 4.5x through paintCommittedWork, on the store's own stroke array (the real
 * committedStrokes over noteStrokes), a note whose extent raster does not fit, so the real armExtentBuild refuses and the overview
 * arms. The first piece waits for the frame queued on winRef, the next ones for the real MessageChannel. performance.now moves one
 * piece budget per read, so each piece draws one stroke. The layers are recording stand-ins: node has no canvas pixels, so "drawn"
 * is the pen layer's sized canvas and the drawing calls it took.
 */
describe("the overview build run to its picture", () => {
	function points(x: number, y: number): InkPoint[] {
		return [{ x, y, pressure: 0.5, t: 0 }, { x: x + 12, y: y + 6, pressure: 0.6, t: 10 }, { x: x + 26, y: y + 4, pressure: 0.5, t: 22 }];
	}

	function realStroke(id: string, x: number, y: number): InkStroke {
		const p = points(x, y);
		return { id, tool: "pen", color: "#2f6de0", width: 2.2, points: p, bbox: computeBBox(p, 2.2), createdAt: 0 };
	}

	/** A canvas whose 2d context records every call; clones are recording canvases too, each with its own call list. */
	function recordingCanvas(w: number, h: number, calls: string[] = []): HTMLCanvasElement & { calls: string[] } {
		const props: Record<PropertyKey, unknown> = {};
		const ctx = new Proxy(props, {
			get: (t, k) => (k in t ? t[k] : (...args: unknown[]) => { calls.push(String(k)); void args; }),
			set: (t, k, v) => { t[k] = v; return true; },
		});
		const c = canvas(w, h) as HTMLCanvasElement & { calls: string[] };
		Object.assign(c, { calls, getContext: () => ctx, cloneNode: () => recordingCanvas(0, 0) });
		return c;
	}

	it("a whole repaint at 4.5x where the extent does not fit draws the overview in pieces and a zoom out holds it, clipped", async () => {
		// 555 x 1458 world at 4.5x and backing 2: 4,995 x 13,122 device px, over the 20 million cap.
		const ink = [realStroke("a", 5000, 5000), realStroke("b", 5300, 5700), realStroke("c", 5529, 6436)];
		const o = overlay(4.5, 4.5, ink);
		delete (o as Record<string, unknown>).committedStrokes;
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		Object.assign(o, {
			committedCanvas: recordingCanvas(1600, 1200), committedCtx: ctx, highlightCtx: ctx, extentMayBuild: true, extentArmAsked: false,
			extentBuild: null, inQueuedFrame: true, markCommittedPaint() {}, usableExtent: () => null, lastScrollAskAt: -Infinity,
		});
		let pieces = 0;
		const run = o.runOverviewPiece;
		o.runOverviewPiece = function (this: InkOverlayPlugin) { pieces++; run.call(this); };
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		try {
			o.paintCommittedWork({ x: 0, y: 0, zoom: 4.5 }, "all", o.committedStrokes(o.noteStrokes(PATH)));
			expect(o.extentBuild ?? null).toBe(null);
			expect(o.overviewBuild ?? null).not.toBe(null);
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
			}
		} finally {
			now.mockRestore();
		}
		expect(o.overview ?? null).not.toBe(null);
		expect(o.overviewBuild).toBe(null);
		expect(pieces).toBeGreaterThanOrEqual(2);
		const pen = o.overview!.pen as HTMLCanvasElement & { calls: string[] };
		expect(pen.width).toBeGreaterThan(0);
		expect(pen.height).toBeGreaterThan(0);
		expect(pen.calls.length).toBeGreaterThan(0);
		// The zoom out: the preview's first frame at 4.2 from the landed 4.5.
		Object.assign(o, { cssScale: 4.2, pinchScaleNow: 4.2 });
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, o.committedStrokes(o.noteStrokes(PATH)));
		expect(pick?.src).toBe(o.overview);
		expect(pick?.clip).toBe(true);
	});

	it("a stroke index left dirty by the landing is rebuilt in the overview's first piece, before any stroke is drawn", async () => {
		// The pieces run back to back as tasks, so an idle callback may not run before the next gesture; here the timer never fires,
		// so only the build itself can clean the index before that gesture.
		const ink = [realStroke("a", 5000, 5000), realStroke("b", 5300, 5700), realStroke("c", 5529, 6436)];
		const o = overlay(4.5, 4.5, ink);
		delete (o as Record<string, unknown>).committedStrokes;
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		Object.assign(o, {
			committedCanvas: recordingCanvas(1600, 1200), committedCtx: ctx, highlightCtx: ctx, extentMayBuild: true, extentArmAsked: false,
			extentBuild: null, inQueuedFrame: true, markCommittedPaint() {}, usableExtent: () => null, lastScrollAskAt: -Infinity,
			strokeIndex: new StrokeIndex(),
		});
		const order: string[] = [];
		const rebuild = o.rebuildIndex;
		o.rebuildIndex = function (this: InkOverlayPlugin, strokes, why) { order.push("index:" + why); rebuild.call(this, strokes, why); };
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		try {
			o.paintCommittedWork({ x: 0, y: 0, zoom: 4.5 }, "all", o.committedStrokes(o.noteStrokes(PATH)));
			expect(o.overviewBuild ?? null, "premise: the overview arms").not.toBe(null);
			o.indexDirty = true;
			const pen = () => (o.overviewBuild?.pen ?? o.overview?.pen ?? null) as (HTMLCanvasElement & { calls: string[] }) | null;
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
				if (pen() && pen()!.calls.length > 0 && !order.includes("drawn")) order.push("drawn");
			}
		} finally {
			now.mockRestore();
		}
		expect(o.overview ?? null, "the overview still builds to its picture").not.toBe(null);
		expect(o.indexDirty, "the index is clean once the build ends").toBe(false);
		expect(order.indexOf("index:idle"), "the index is rebuilt before the first drawn piece").toBeGreaterThan(-1);
		expect(order.indexOf("index:idle") < order.indexOf("drawn"), `order ${JSON.stringify(order)}`).toBe(true);
		expect(order.filter(x => x.startsWith("index:")).length, "one rebuild").toBe(1);
	});

	it("with one attached group in the note, the build runs on the free ink to its picture and a zoom out holds it, clipped", async () => {
		// The store holds three free strokes and one attached member; the committed layers, the extent raster and the overview hold
		// free ink only, so the repaint arms on committedStrokes(freeStrokes(path)) and every overview hold test reads that same list.
		const free = [realStroke("a", 5000, 5000), realStroke("b", 5300, 5700), realStroke("c", 5529, 6436)];
		const store = [...free, realStroke("g1", 5100, 5400)];
		const o = overlay(4.5, 4.5, store);
		delete (o as Record<string, unknown>).committedStrokes;
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		Object.assign(o, {
			committedCanvas: recordingCanvas(1600, 1200), committedCtx: ctx, highlightCtx: ctx, extentMayBuild: true, extentArmAsked: false,
			extentBuild: null, inQueuedFrame: true, markCommittedPaint() {}, usableExtent: () => null, lastScrollAskAt: -Infinity,
			freeStrokes: () => free,
		});
		let pieces = 0;
		const run = o.runOverviewPiece;
		o.runOverviewPiece = function (this: InkOverlayPlugin) { pieces++; run.call(this); };
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		try {
			o.paintCommittedWork({ x: 0, y: 0, zoom: 4.5 }, "all", o.committedStrokes(o.freeStrokes(PATH)));
			expect(o.extentBuild ?? null, "premise: the extent build does not fit").toBe(null);
			expect(o.overviewBuild?.count, "premise: the overview arms on the free ink").toBe(free.length);
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
			}
		} finally {
			now.mockRestore();
		}
		expect(o.overview ?? null, "the build ran to its picture").not.toBe(null);
		expect(pieces).toBeGreaterThanOrEqual(2);
		expect(o.overview!.count).toBe(free.length);
		Object.assign(o, { cssScale: 4.2, pinchScaleNow: 4.2 });
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, o.committedStrokes(o.freeStrokes(PATH)));
		expect(pick?.src, "a zoom out holds the overview").toBe(o.overview);
		expect(pick?.clip).toBe(true);
	});

	/**
	 * A pen commit, the way store() takes it (InkOverlayPenPath.ts): whether the picture or the build holds the store just before,
	 * the store grows in place, then drawIntoOverview when it held. `drawIntoOverview?.` keeps a red an assertion where it is missing.
	 */
	function commitInto(o: InkOverlayPlugin, ink: InkStroke[], added: InkStroke[]) {
		const held = o.overviewBuild ?? o.overview;
		const was = !!held && o.overviewHolds(held, ink);
		ink.push(...added);
		if (was) (o as { drawIntoOverview?: (path: string, a: readonly InkStroke[]) => void }).drawIntoOverview?.(PATH, added);
	}

	function hlStroke(id: string, x: number, y: number): InkStroke {
		return { ...realStroke(id, x, y), tool: "highlighter" };
	}

	it("a pen commit while the build runs reaches the picture: it holds the store's count, and a zoom out holds it", async () => {
		const ink = [realStroke("a", 5000, 5000), realStroke("b", 5300, 5700), realStroke("c", 5529, 6436)];
		const o = overlay(4.5, 4.5, ink);
		delete (o as Record<string, unknown>).committedStrokes;
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		Object.assign(o, {
			committedCanvas: recordingCanvas(1600, 1200), committedCtx: ctx, highlightCtx: ctx, extentMayBuild: true, extentArmAsked: false,
			extentBuild: null, inQueuedFrame: true, markCommittedPaint() {}, usableExtent: () => null, lastScrollAskAt: -Infinity,
		});
		// The commit lands between the first piece and the second, as a pen lift does between two tasks.
		let midBuild: { next: number; count: number } | null = null;
		const run = o.runOverviewPiece;
		o.runOverviewPiece = function (this: InkOverlayPlugin) {
			run.call(this);
			const b = this.overviewBuild;
			if (!midBuild && b) {
				midBuild = { next: b.next, count: b.count };
				commitInto(this, ink, [realStroke("d", 5200, 5200)]);
			}
		};
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		try {
			o.paintCommittedWork({ x: 0, y: 0, zoom: 4.5 }, "all", o.noteStrokes(PATH));
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
			}
		} finally {
			now.mockRestore();
		}
		expect(midBuild, "premise: the commit came while the build ran").toEqual({ next: 1, count: 3 });
		expect(o.overview?.count ?? null).toBe(4);
		expect(o.overview && o.overviewHolds(o.overview, ink)).toBe(true);
		Object.assign(o, { cssScale: 4.2, pinchScaleNow: 4.2 });
		const pick = o.heldRasterSource(PATH, o.lastPaintCam!, ink);
		expect(pick?.src).toBe(o.overview);
		expect(pick?.clip).toBe(true);
	});

	/** The calls on a recording layer that put paint down (a transform set alone draws nothing). */
	const PAINT = /^(fill|stroke|fillRect|strokeRect|drawImage)$/;

	/** At 4.5x, backing 1: the picture's world rect is (0, 0) to (1000, 1000); a build carries the same box as w and h. */
	function held(kind: "picture" | "build", ink: InkStroke[], o: InkOverlayPlugin) {
		const base = { path: PATH, at: { x: 0, y: 0, zoom: 4.5 }, backing: 1, dpr: 2, look: inkLookKey(), strokes: ink, count: ink.length, generation: inlineInk.generation(PATH) };
		if (kind === "picture") o.overview = { ...base, pen: recordingCanvas(4500, 4500), hl: null };
		else o.overviewBuild = { ...base, w: 4500, h: 4500, hasHl: false, floor: null as never, pen: null, hl: null, next: 0, timer: 0 };
		return () => {
			const h = (kind === "picture" ? o.overview : o.overviewBuild)!;
			return { count: h.count, drawn: kind === "picture" ? (o.overview!.pen as HTMLCanvasElement & { calls: string[] }).calls.filter(c => PAINT.test(c)).length : -1 };
		};
	}

	it.each(["picture", "build"] as const)("the %s takes a stroke inside its box and refuses one reaching past it", kind => {
		const ink = [realStroke("a", 100, 100), realStroke("b", 300, 400), realStroke("c", 700, 800)];
		const o = overlay(4.5, 4.5, ink);
		const read = held(kind, ink, o);
		commitInto(o, ink, [realStroke("d", 500, 500)]);
		const took = read();
		expect(took.count).toBe(4);
		if (kind === "picture") expect(took.drawn).toBeGreaterThan(0);
		commitInto(o, ink, [realStroke("e", 990, 500)]);
		expect(read()).toEqual(took);
		expect(kind === "picture" ? o.overviewHolds(o.overview!, ink) : o.overviewHolds(o.overviewBuild!, ink)).toBe(false);
	});

	it.each(["picture", "build"] as const)("the %s with no highlighter layer takes a pen stroke and refuses a highlighter stroke", kind => {
		const ink = [realStroke("a", 100, 100), realStroke("b", 300, 400), realStroke("c", 700, 800)];
		const o = overlay(4.5, 4.5, ink);
		const read = held(kind, ink, o);
		commitInto(o, ink, [realStroke("d", 500, 500)]);
		const took = read();
		expect(took.count).toBe(4);
		if (kind === "picture") expect(took.drawn).toBeGreaterThan(0);
		commitInto(o, ink, [hlStroke("e", 600, 600)]);
		expect(read()).toEqual(took);
	});
	/**
	 * The three-stroke note over the extent cap, landed at 4.5 with its overview whole. `land(z)` is a whole repaint at z, `finish()`
	 * runs the build out, `restore()` puts performance.now back.
	 */
	async function landedWhole() {
		const ink = [realStroke("a", 5000, 5000), realStroke("b", 5300, 5700), realStroke("c", 5529, 6436)];
		const o = overlay(4.5, 4.5, ink);
		delete (o as Record<string, unknown>).committedStrokes;
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const ctx = new Proxy({}, { get: (_t, k) => (k === "canvas" ? o.committedCanvas : () => {}) });
		Object.assign(o, {
			committedCanvas: recordingCanvas(1600, 1200), committedCtx: ctx, highlightCtx: ctx, extentMayBuild: true, extentArmAsked: false,
			extentBuild: null, inQueuedFrame: true, markCommittedPaint() {}, usableExtent: () => null, lastScrollAskAt: -Infinity,
		});
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		const land = (zoom: number) => o.paintCommittedWork({ x: 0, y: 0, zoom }, "all", o.noteStrokes(PATH));
		const finish = async () => {
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
			}
		};
		land(4.5);
		await finish();
		return { o, ink, frames, land, finish, restore: () => now.mockRestore() };
	}

	/** A zoom preview's first frame from `from` to `now`, the committed layer last painted at `from`. */
	function previewAt(o: InkOverlayPlugin, from: number, now: number, ink: readonly InkStroke[]) {
		Object.assign(o, { pinchAnchor: { fromScale: from }, pinchScaleNow: now, cssScale: now, lastPaintCam: { x: 0, y: 0, zoom: from } });
		return o.heldRasterSource(PATH, o.lastPaintCam!, ink);
	}

	it("a landing at 3.0 after a whole 4.5 picture: a zoom out before any new piece holds the 4.5 picture, clipped", async () => {
		const r = await landedWhole();
		try {
			const at45 = r.o.overview ?? null;
			expect(at45, "premise: the 4.5 picture is whole").not.toBe(null);
			r.land(3.0);
			const pick = previewAt(r.o, 3.0, 2.8, r.ink);
			expect(pick?.src).toBe(at45);
			expect(pick?.clip).toBe(true);
			expect(pick?.f).toBeCloseTo((3.0 * 2) / (at45!.at.zoom * at45!.backing), 9);
		} finally {
			r.restore();
		}
	});

	it("a picture as sharp as a new build, whose copy fits, is kept and no build is armed (over the cap, landing 3.0)", async () => {
		const r = await landedWhole();
		try {
			const at45 = r.o.overview!;
			r.land(3.0);
			expect(r.o.overview).toBe(at45);
			expect(r.o.overviewBuild ?? null).toBe(null);
			expect(r.frames).toHaveLength(0);
			expect(at45.pen.width).toBeGreaterThan(0);
		} finally {
			r.restore();
		}
	});

	it("a picture sharper than the landing at scale 1, whose copy fits, is kept and no build is armed (under the cap, 4.5 to 3.0)", () => {
		const ink = [stroke(100, 100, 50, 50)];
		const o = overlay(3.0, 3.0, ink);
		const frames: unknown[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: unknown) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		const kept = picture(ink, 4.5, 1);
		o.overview = kept;
		o.armOverviewBuild({ x: 0, y: 0, zoom: 3.0 }, ink as never);
		expect(o.overview).toBe(kept);
		expect(o.overviewBuild ?? null).toBe(null);
		expect(frames).toHaveLength(0);
	});

	it("a picture whose copy does not fit and that would overrun the pair cap beside the build is dropped and released, as before", () => {
		const ink = [stroke(100, 100, 50, 50)];
		const o = overlay(0.5, 0.5, ink);
		const frames: unknown[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: unknown) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		// 4000 x 9000 device px, over the pair cap alone; copied at 0.5 x 2 / (4.5 x 1), under the smallest factor.
		const old = picture(ink, 4.5, 0.5);
		o.overview = old;
		o.armOverviewBuild({ x: 0, y: 0, zoom: 0.5 }, ink as never);
		expect(o.overview ?? null).toBe(null);
		expect(old.pen.width).toBe(0);
		expect(o.overviewBuild?.at.zoom).toBe(0.5);
	});

	/** A note under the cap with a whole picture at 3.0 (backing 2, scale 1), landed at 4.5: kept through the 4.5 build. */
	function keptThroughBuild() {
		const ink = [realStroke("a", 100, 100), realStroke("b", 200, 250), realStroke("c", 300, 350)];
		const o = overlay(4.5, 4.5, ink);
		const frames: (() => void)[] = [];
		shadowWin(o, { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: () => 1, clearTimeout() {} });
		Object.assign(o, { committedCanvas: recordingCanvas(1600, 1200), lastScrollAskAt: -Infinity, extentBuild: null });
		const kept = { path: PATH, pen: recordingCanvas(1400, 1600), hl: null, at: { x: 98, y: 98, zoom: 3.0 }, backing: 2, dpr: 2, look: inkLookKey(),
			strokes: ink, count: ink.length, generation: inlineInk.generation(PATH) };
		o.overview = kept;
		o.armOverviewBuild({ x: 0, y: 0, zoom: 4.5 }, ink);
		return { o, ink, frames, kept };
	}

	it("a picture less sharp than the new build is kept through it, and the build's last piece swaps it out and frees it, taken down first", async () => {
		const { o, ink, frames, kept } = keptThroughBuild();
		expect(o.overviewBuild?.at.zoom, "premise: a build at 4.5 is armed").toBe(4.5);
		expect(o.overview).toBe(kept);
		expect(previewAt(o, 4.5, 4.2, ink)?.src, "the kept picture is held while the build runs").toBe(kept);
		o.heldRaster = { src: { pen: kept.pen } } as never;
		const takeDown = vi.fn(function (this: InkOverlayPlugin) { this.heldRaster = null; });
		o.takeDownHeldRaster = takeDown;
		let clock = 0;
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += EXTENT_PIECE_MS));
		try {
			for (let i = 0; i < 200 && o.overviewBuild; i++) {
				frames.splice(0).forEach(fn => fn());
				await new Promise(r => setTimeout(r, 1));
			}
		} finally {
			now.mockRestore();
		}
		expect(o.overview).not.toBe(kept);
		expect(o.overview?.at.zoom).toBe(4.5);
		expect(kept.pen.width).toBe(0);
		expect(takeDown).toHaveBeenCalledTimes(1);
		expect(previewAt(o, 4.5, 4.2, ink)?.src).toBe(o.overview);
	});

	it("a stroke added while the build runs beside a kept picture goes to the build only: the kept picture is held no more", () => {
		const { o, ink, kept } = keptThroughBuild();
		expect(previewAt(o, 4.5, 4.2, ink)?.src, "premise: the kept picture is held").toBe(kept);
		commitInto(o, ink, [realStroke("d", 150, 150)]);
		expect(o.overviewBuild?.count).toBe(4);
		expect(o.overviewHolds(kept, ink)).toBe(false);
		expect(previewAt(o, 4.5, 4.2, ink)).toBe(null);
	});
});

/**
 * A zoomed landing keeps a held raster up with the committed and highlight canvases hidden until the next whole paint. A second pinch
 * that starts inside that window, once the held picture no longer matches (here a shown move), engages the pinch composite over the
 * canvases still visible. Its first preview frame takes the old raster down (putUpHeldRaster), which shows the hidden canvases, and
 * finds nothing to hold. The pinch end must not write 'hidden' back onto them: nothing else ever shows them again, and all free ink
 * stays off screen until the note is reopened.
 *
 * Runs the real hideBlankPinchLayers, preparePinchComposite, heldRasterSource, lineAnchorsMoved, putUpHeldRaster,
 * takeDownHeldRaster and restorePinchLayers on a bare overlay; heldRasterSource is not stubbed.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin, inkLookKey, inlineInk } from "./InkOverlay";

const PATH = "pinch-after-held-raster.md";
const CAM = { x: 0, y: 0, zoom: 0.5 };

type Canvas = HTMLCanvasElement & { style: Record<string, string> };

function canvas(name: string): Canvas {
	const ctx = { save() {}, restore() {}, setTransform() {}, drawImage() {}, clearRect() {}, globalAlpha: 1, globalCompositeOperation: "", filter: "" };
	const style: Record<string, string> = { visibility: "" };
	const setCssStyles = (s: Record<string, string>) => { Object.assign(style, s); };
	return { name, width: 64, height: 64, remove: () => {}, getContext: () => ctx, style, setCssStyles } as unknown as Canvas;
}

function computed(c: Canvas): CSSStyleDeclaration {
	return {
		filter: "none", mixBlendMode: "normal", clipPath: "none", opacity: "1", display: "block",
		visibility: c.style.visibility || "visible", width: "64px", height: "64px", left: "0px", top: "0px",
		transform: "none", transformOrigin: "0px 0px", translate: "none", rotate: "none", scale: "none",
	} as unknown as CSSStyleDeclaration;
}

function overlay() {
	const proto = Object.create(InkOverlayPlugin.prototype) as object;
	const o = new Proxy(proto, {
		set(target, key, value) {
			Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
			return true;
		},
	}) as Record<string, unknown>;
	const c = {
		committed: canvas("committed"), highlight: canvas("highlight"), wet: canvas("wet"), highlightWet: canvas("highlightWet"),
		tail: canvas("tail"), wetTile: canvas("wetTile"), attPen: canvas("attPen"), attHl: canvas("attHl"),
	};
	o.filePath = () => PATH;
	o.freeStrokes = () => inlineInk.strokes(PATH);
	o.spaceSnapshot = null;
	o.committedBacking = 2;
	o.dpr = 1;
	o.cssScale = 0.5;
	o.cssWidth = 64;
	o.cssHeight = 64;
	o.highlightPairDeferred = false;
	o.extentRaster = null;
	o.overview = null;
	o.pinchAnchor = null;
	o.heldRaster = null;
	o.heldRasterClip = null;
	o.lastPaintCam = { ...CAM };
	o.frame = { locked: false };
	o.builder = null;
	o.winRef = { getComputedStyle: (el: Canvas) => computed(el) };
	o.allocateWet = () => {};
	o.committedCanvas = c.committed;
	o.highlightCanvas = c.highlight;
	o.wetCanvas = c.wet;
	o.highlightWetCanvas = c.highlightWet;
	o.tailCanvas = c.tail;
	o.wetTileCanvas = c.wetTile;
	// Free pen and free highlight painted; attached pen and attached highlight painted; wet, highlight wet and tail blank.
	o.committedBlank = false;
	o.highlightBlank = false;
	o.attachedLayer = { pen: c.attPen, hl: c.attHl, penBlank: false, hlBlank: false };
	o.wet = { provenBlank: true, notePixelsChanged() {}, noteBackingCleared() {} };
	o.highlightWet = { provenBlank: true };
	o.tail = { provenBlank: true };
	o.pinchHiddenCanvases = new Map();
	o.pinchComposite = false;
	const host = { style: {} };
	o.view = { dom: host, scrollDOM: { style: {}, parentElement: host } };
	o.container = { style: { left: "0px", top: "0px", transform: "" } };
	o.frontierCache = { invalidate: () => {} };
	o.scheduleRepaint = () => {};
	o.shownMoves = 0;
	o.lineAnchors = { takeStep: () => null };
	o.shownSteps = Array.from({ length: 16 }, () => ({ step: 0, bound: null }));
	const strokes = inlineInk.strokes(PATH);
	o.standIn = {
		path: PATH, pen: canvas("standInPen"), hl: null, at: { ...CAM }, backing: 2, dpr: 1, look: inkLookKey(), strokes, count: strokes.length,
		generation: inlineInk.generation(PATH), mark: null, shownMoves: 0, store: strokes,
	};
	return { o, plugin: o as unknown as InkOverlayPlugin, c };
}

/** The landing's held raster over the stand-in: the committed and highlight canvases hidden, their resting value kept. */
function landWithHeldRaster(o: Record<string, unknown>, c: ReturnType<typeof overlay>["c"]) {
	o.heldRaster = {
		src: o.standIn, f: 1, path: PATH, count: inlineInk.strokes(PATH).length, generation: inlineInk.generation(PATH),
		inner: { style: { transform: "" } }, scroll: { x: 0, y: 0 }, offX: 0, offY: 0, rasterScale: Number.NaN,
		box: "64px 64px", transform: "", hidden: [[c.committed, ""], [c.highlight, ""]], shownMoves: 0, penTiles: [], hlTiles: [], hlWrap: null,
	};
	c.committed.style.visibility = "hidden";
	c.highlight.style.visibility = "hidden";
}

/** A pinch start, its first preview frame, and its end, as the gesture runs them. */
function quickPinch(plugin: InkOverlayPlugin) {
	plugin.hideBlankPinchLayers();
	const composite = (plugin as unknown as { pinchComposite: boolean }).pinchComposite;
	plugin.putUpHeldRaster();
	const raster = (plugin as unknown as { heldRaster: unknown }).heldRaster;
	plugin.restorePinchLayers();
	return { composite, raster };
}

describe("a quick second pinch leaves the free ink shown", () => {
	it("control: a pinch with no held raster shows the committed and highlight canvases at its end", () => {
		const { o, plugin, c } = overlay();
		// No landing kept: no stand-in, nothing held.
		o.standIn = null;
		const { composite } = quickPinch(plugin);
		expect(composite, "premise: the composite engaged over four painted layers").toBe(true);
		expect([c.committed.style.visibility, c.highlight.style.visibility], "the resting values are back").toEqual(["", ""]);
	});

	it("premise: the landing's stand-in is still held before the shown move", () => {
		const { plugin } = overlay();
		expect(plugin.heldRasterSource(PATH, CAM, plugin.committedStrokes(plugin.freeStrokes(PATH)))).not.toBeNull();
	});

	it("a pinch started while a landing's held raster no longer matches shows the free ink at its end", () => {
		const { o, plugin, c } = overlay();
		landWithHeldRaster(o, c);
		plugin.lineAnchorsMoved(PATH);
		expect(plugin.heldRasterSource(PATH, CAM, plugin.committedStrokes(plugin.freeStrokes(PATH))), "premise: nothing to hold after the move").toBeNull();
		const { composite, raster } = quickPinch(plugin);
		expect([composite, raster], "premise: the composite engaged over the attached pair, the old raster came down").toEqual([true, null]);
		expect(c.committed.style.visibility, "free pen ink shown").not.toBe("hidden");
		expect(c.highlight.style.visibility, "free highlight ink shown").not.toBe("hidden");
		expect([c.attPen.style.visibility, c.attHl.style.visibility], "attached ink shown").toEqual(["", ""]);
	});
});

/**
 * The wet tile across a backing reallocation, driven through the overlay's
 * real handleResize with a real WetInkRenderer. Only the pixels are fake:
 * every drawing call on either canvas is recorded.
 *
 * - A backing change under a live stroke reallocates the full wet canvas,
 *   which blanks it. The tile's pixels belong to the old backing; copying
 *   them into the new one puts ink at the old origin that no dirty box or
 *   blank flag records, so the lift can leave it on screen. The tile is
 *   wiped there, not copied.
 * - The overlay hands the renderer its answer on CSS translate before the
 *   tile is sized. Where translate is not supported there is no tile: the
 *   strips draw into the full canvas and the tile gets no translate.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { CameraState } from "../camera/coordinates";

type Fields = Record<string, unknown>;
type Call = { op: string; args: unknown[] };
const noop = (): undefined => undefined;
const DRAWS = new Set(["stroke", "fill", "fillRect", "strokeRect", "drawImage", "putImageData"]);

const CSS_W = 1000, CSS_H = 600;
const cam: CameraState = { x: 0, y: 0, zoom: 1 };

function recordingCanvas(width: number, height: number) {
	const calls: Call[] = [];
	const sizeWrites: string[] = [];
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop) {
			if (prop === "getContextAttributes") return () => ({ desynchronized: false });
			return (...args: unknown[]) => { calls.push({ op: String(prop), args }); };
		},
		set() { return true; },
	});
	let w = width, h = height;
	const style: Record<string, string> = {};
	const canvas = {
		get width() { return w; }, set width(v: number) { w = v; sizeWrites.push(`w${v}`); },
		get height() { return h; }, set height(v: number) { h = v; sizeWrites.push(`h${v}`); },
		style,
		setCssStyles: (s: Record<string, string>) => Object.assign(style, s),
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	const draws = () => calls.filter(c => DRAWS.has(c.op));
	const clears = () => calls.filter(c => c.op === "clearRect");
	return { canvas, calls, sizeWrites, draws, clears, style };
}

function plainCanvas(width: number, height: number): Fields {
	return { width, height, style: {}, setCssStyles: noop };
}

/**
 * An overlay at dpr 1 whose canvases already match a 1000 x 600 band, so the
 * next handleResize at another dpr reallocates them.
 */
function rig(opts: { translate: boolean }) {
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ fontSize: "16px" }),
		CSS: { supports: (property: string) => property === "translate" ? opts.translate : false },
	};
	const full = recordingCanvas(CSS_W, CSS_H);
	const tile = recordingCanvas(1, 1);
	const wet = new WetInkRenderer(full.canvas, false);
	wet.applyDpr(1);

	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		dom: { ownerDocument: { defaultView: win } },
		scrollDOM: { scrollLeft: 0, scrollTop: 0 },
		contentDOM: {},
		scaleX: 1,
		scaleY: 1,
	};
	o.container = {
		getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H, right: CSS_W, bottom: CSS_H }),
		offsetWidth: CSS_W,
		offsetHeight: CSS_H,
	};
	o.committedCanvas = plainCanvas(CSS_W, CSS_H);
	o.wetCanvas = full.canvas;
	o.highlightCanvas = plainCanvas(CSS_W, CSS_H);
	o.highlightWetCanvas = plainCanvas(CSS_W, CSS_H);
	o.wetTileCanvas = tile.canvas;
	o.committedCtx = { setTransform: noop };
	o.highlightCtx = { setTransform: noop };
	o.wet = wet;
	o.highlightWet = { applyDpr: noop, noteBackingCleared: noop };
	o.tail = { applyDpr: noop, noteBackingCleared: noop, configureInlineBacking: noop };
	o.syncBand = () => "none";
	o.clearSnapPreview = noop;
	o.restorePinchLayers = noop;
	o.scheduleRepaint = noop;
	o.repaint = noop;
	o.frame = { locked: false };
	o.router = null;
	o.damage = { addAll: noop };
	o.builder = null;
	o.mode = "ink";
	o.pinchScaleNow = 1;
	o.refFontPx = 16;
	o.contentStyle = null;
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = CSS_W;
	o.cssHeight = CSS_H;
	o.updatePaperSpacing = noop;

	const handleResize = (InkOverlayPlugin.prototype as unknown as { handleResize: () => void }).handleResize;
	return {
		wet, full, tile, o,
		setDpr(dpr: number) { win.devicePixelRatio = dpr; },
		resize() { handleResize.call(o); },
	};
}

function strokeInto(wet: WetInkRenderer, n: number, x0: number, y0: number, dx: number, dy: number): void {
	wet.beginStroke({ x: x0, y: y0, pressure: 0.6, t: 0 }, DEFAULT_PEN);
	for (let i = 1; i < n; i++) wet.appendPoint(cam, DEFAULT_PEN, { x: x0 + i * dx, y: y0 + i * dy, pressure: 0.6, t: i * 4 });
}

describe("wet tile across a backing reallocation", () => {
	it("a backing change under a live stroke wipes the tile instead of copying it into the new backing", () => {
		const r = rig({ translate: true });
		// The first resize at dpr 2 sizes the canvases and the tile for this band.
		r.setDpr(2);
		r.resize();
		expect(r.wet.tileOrigin === undefined, "the renderer has no tile contract").toBe(false);
		// A live stroke: its strips sit in the tile, not yet in the full canvas.
		(r.o.frame as { locked: boolean }).locked = true;
		r.o.builder = {};
		strokeInto(r.wet, 25, 100, 100, 3, 2);
		expect(r.wet.tileOrigin, "the stroke never reached the tile, so this cell proves nothing").not.toBeNull();
		expect(r.tile.draws().length, "the stroke never drew into the tile").toBeGreaterThan(0);
		r.full.calls.length = 0;
		r.full.sizeWrites.length = 0;
		r.tile.calls.length = 0;
		// The backing changes mid-stroke (a dpr change: a window moved to
		// another monitor, a system zoom step).
		r.setDpr(1);
		r.resize();
		expect(r.full.sizeWrites.length, "handleResize did not reallocate the full wet canvas").toBeGreaterThan(0);
		expect(r.full.draws(), "the old tile was copied into the freshly blanked backing").toEqual([]);
		expect(r.tile.clears().length, "the tile kept the old backing's pixels").toBeGreaterThan(0);
		expect(r.wet.provenBlank, "the full canvas is not reported blank after the reallocation").toBe(true);
	});

	it("where CSS translate is not supported, the overlay's resize leaves no tile and strips draw into the full canvas", () => {
		const r = rig({ translate: false });
		r.setDpr(2);
		r.resize();
		expect((r.wet as unknown as { tileTranslate?: boolean }).tileTranslate,
			"the overlay did not hand the renderer its translate answer").toBe(false);
		r.full.calls.length = 0;
		r.tile.calls.length = 0;
		strokeInto(r.wet, 25, 100, 100, 3, 2);
		expect(r.full.draws().length, "no translate: the strips did not reach the full canvas").toBeGreaterThan(0);
		expect(r.tile.draws(), "no translate: a strip reached the tile").toEqual([]);
		expect(r.tile.style.translate, "no translate: the tile got a translate").toBeUndefined();
		expect(r.wet.tileOrigin, "no translate: the tile was placed").toBeNull();
	});
});

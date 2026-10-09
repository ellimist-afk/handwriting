/**
 * The small live canvases at an owned scale of 1 on a real pane.
 *
 * The overlay measures its scale as rect width over offsetWidth, and
 * offsetWidth is a whole number, so a pane at exactly 100% reads a hair under
 * 1: 0.9999960866 and 0.9998392990 were measured on a device. The wet tile and
 * the compact tail exist only when the backing has a whole pixel grid, and a
 * scale off in its sixth decimal has none, so both were switched off and every
 * pen event drew into the full-size wet canvas and a full-size tail.
 *
 * Driven through the overlay's real handleResize with a real WetInkRenderer
 * and a real TailRenderer at device pixel ratio 2 on a 1596 x 1236 band (the
 * device's pane). Only the pixels are fake. Within the measurement's rounding
 * the owned scale builds the backing and both grids; a real external zoom
 * (0.998, past the 1e-3 tolerance) keeps the measured value.
 */
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearScrollProbe, formatScrollProbe, scrollProbeLayers } from "./ScrollProbe";

type Fields = Record<string, unknown>;
const noop = (): undefined => undefined;

const CSS_W = 1596, CSS_H = 1236, DPR = 2;
/** The two measured scales a device printed at 100%. */
const DEVICE_SCALES = [0.9999960866, 0.999839299] as const;

function fakeCanvas(win: object, width: number, height: number): HTMLCanvasElement {
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop) {
			if (prop === "getContextAttributes") return () => ({ desynchronized: false });
			return (..._args: unknown[]) => undefined;
		},
		set() { return true; },
	});
	const style: Record<string, string> = {};
	return {
		width, height, style,
		ownerDocument: { defaultView: win },
		setCssStyles: (s: Record<string, string>) => Object.assign(style, s),
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
}

/** An overlay whose pane is CSS_W layout px wide and `visualW` visual px wide, at owned scale `pinch`. */
function rig(opts: { visualW: number; pinch: number; hostZoom: boolean }) {
	const win = {
		devicePixelRatio: DPR,
		getComputedStyle: () => ({ fontSize: "16px" }),
		CSS: { supports: (property: string) => property === "translate" || (property === "zoom" && opts.hostZoom) },
	};
	const visualH = CSS_H * opts.visualW / CSS_W;
	const wetCanvas = fakeCanvas(win, 1, 1), tileCanvas = fakeCanvas(win, 1, 1), tailCanvas = fakeCanvas(win, 1, 1);
	const wet = new WetInkRenderer(wetCanvas, false);
	const tail = new TailRenderer(tailCanvas);
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		dom: { ownerDocument: { defaultView: win } },
		scrollDOM: { scrollLeft: 0, scrollTop: 0 },
		contentDOM: {},
		scaleX: opts.visualW / CSS_W,
		scaleY: opts.visualW / CSS_W,
	};
	o.container = {
		getBoundingClientRect: () => ({ left: 0, top: 0, width: opts.visualW, height: visualH, right: opts.visualW, bottom: visualH }),
		offsetWidth: CSS_W,
		offsetHeight: CSS_H,
	};
	o.committedCanvas = fakeCanvas(win, 1, 1);
	o.wetCanvas = wetCanvas;
	o.highlightCanvas = fakeCanvas(win, 1, 1);
	o.highlightWetCanvas = fakeCanvas(win, 1, 1);
	o.wetTileCanvas = tileCanvas;
	o.tailCanvas = tailCanvas;
	o.committedCtx = { setTransform: noop };
	o.highlightCtx = { setTransform: noop };
	o.wet = wet;
	o.highlightWet = { applyDpr: noop, noteBackingCleared: noop };
	o.tail = tail;
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
	o.pinchScaleNow = opts.pinch;
	o.refFontPx = 16;
	o.contentStyle = null;
	o.cssScale = opts.pinch;
	o.fontZoom = 1;
	o.scale = opts.pinch;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;
	o.updatePaperSpacing = noop;
	const proto = InkOverlayPlugin.prototype as unknown as {
		handleResize: () => void;
		backingNow: () => number;
		placeCanvasLayers: () => void;
		probeStrokeLayers: () => void;
	};
	proto.handleResize.call(o);
	const tailConfig = () => (tail as unknown as { inlineBacking: { grid: number | null; tileW: number; tileH: number; backing: number } | null }).inlineBacking;
	return {
		o, wet, tail, tileCanvas, tailCanvas, tailConfig,
		backingNow: () => proto.backingNow.call(o),
		placeLayers: () => proto.placeCanvasLayers.call(o),
		probe: () => proto.probeStrokeLayers.call(o),
	};
}

describe("the small live canvases at the scale a device measures at 100%", () => {
	afterEach(() => { clearScrollProbe(); setDiagnosticsEnabled(false); });
	for (const hostZoom of [true, false]) for (const measured of DEVICE_SCALES) {
		const label = `measured ${measured}, owned 1, ${hostZoom ? "zoom" : "transform"} host`;
		it(`${label}: the backing is the device ratio exactly, the wet tile is on and the tail has a grid`, () => {
			const r = rig({ visualW: CSS_W * measured, pinch: 1, hostZoom });
			expect(r.o.cssScale, "the rig did not reproduce the device's measured scale").toBeCloseTo(measured, 12);
			expect(r.o.committedBacking, "the committed backing is not the device ratio at an owned scale of 1").toBe(DPR);
			expect(r.backingNow(), "backingNow disagrees with the backing the canvases were built with").toBe(r.o.committedBacking);
			expect([r.tileCanvas.width, r.tileCanvas.height], "the wet tile is off (1 x 1): every pen event draws into the full wet canvas").toEqual([512, 512]);
			const tail = r.tailConfig();
			expect(tail?.grid ?? null, "the tail has no grid: it stays a full-size layer").not.toBeNull();
			expect([tail?.tileW, tail?.tileH], "the tail has no compact tile").toEqual([512, 512]);
		});
		it(`${label}: a band style update keeps the tile and the tail grid`, () => {
			const r = rig({ visualW: CSS_W * measured, pinch: 1, hostZoom });
			r.placeLayers();
			expect([r.tileCanvas.width, r.tileCanvas.height], "re-placing the layers switched the wet tile off").toEqual([512, 512]);
			expect(r.tailConfig()?.grid ?? null, "re-placing the layers dropped the tail grid").not.toBeNull();
		});
	}

	for (const measured of DEVICE_SCALES) it(`measured ${measured}: the probe's per-stroke line prints the measured and the raster scale, the backing and both live canvases`, () => {
		const r = rig({ visualW: CSS_W * measured, pinch: 1, hostZoom: true });
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		r.probe();
		const lines = formatScrollProbe().split("\n").filter(l => / LAYERS {3}/.test(l));
		expect(lines.length, formatScrollProbe()).toBe(1);
		expect(lines[0]).toContain(`cssScale=${measured} raster=1 backing=2 tile=512x512 tileGrid=1 tail=512x512 tailGrid=1 tailMode=empty band=3192x2472`);
		expect(lines[0]).not.toContain("tile OFF");
		expect(formatScrollProbe()).toContain("live layers per stroke  : 1 stroke(s), wet tile off in 0, tail full size in 0");
	});

	it("the probe line flags a stroke that drew into the full-size live canvases", () => {
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		scrollProbeLayers({ cssScale: 0.9999960866, rasterScale: 0.9999960866, backing: 1.9999921732, tileW: 1, tileH: 1, tileGrid: null, tailW: 3192, tailH: 2472, tailGrid: null, tailMode: "full", bandW: 3192, bandH: 2472 });
		const text = formatScrollProbe();
		expect(text).toContain("LAYERS   cssScale=0.9999960866 raster=0.9999960866 backing=1.9999921732 tile=1x1 tileGrid=none tail=3192x2472 tailGrid=none tailMode=full band=3192x2472  tile OFF  tail FULL");
		expect(text).toContain("live layers per stroke  : 1 stroke(s), wet tile off in 1, tail full size in 1");
	});

	it("an owned pinch scale of 0.5 measured a hair off builds the backing at exactly 1 and keeps the tile", () => {
		const r = rig({ visualW: CSS_W * 0.5 * DEVICE_SCALES[0], pinch: 0.5, hostZoom: true });
		expect(r.o.committedBacking).toBe(1);
		expect([r.tileCanvas.width, r.tileCanvas.height]).toEqual([256, 256]);
		expect(r.tailConfig()?.grid ?? null).not.toBeNull();
	});

	it("a real external zoom past the tolerance keeps the measured scale for the backing", () => {
		const r = rig({ visualW: CSS_W * 0.998, pinch: 1, hostZoom: true });
		expect(r.o.committedBacking, "a 0.2% external zoom was taken for rounding").toBeCloseTo(DPR * 0.998, 12);
		expect(r.backingNow()).toBe(r.o.committedBacking);
	});

	it("an exact scale of 1 is unchanged: backing 2, tile on, tail grid", () => {
		const r = rig({ visualW: CSS_W, pinch: 1, hostZoom: true });
		expect(r.o.committedBacking).toBe(DPR);
		expect([r.tileCanvas.width, r.tileCanvas.height]).toEqual([512, 512]);
		expect(r.tailConfig()?.grid ?? null).not.toBeNull();
	});
});

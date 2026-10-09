/**
 * The small live canvases when the backing has no whole 1/64 px grid.
 *
 * A device at 200% display scaling with a 91.3% page zoom (1.2^-0.5) reports
 * devicePixelRatio 1.8257418870925903. At an owned scale of 1 the backing is
 * that ratio exactly, so a backing px is a displayed device px, but 64 x grid
 * over the backing is never whole, so the joint grid loop finds no grid: the
 * wet tile stayed 1 x 1, the tail stayed a full-size layer, and every pen event
 * drew into the full-size canvases. The same happens at a free pinch zoom
 * (0.518, 0.8734 at ratio 2) under a zoomed host.
 *
 * When the loop finds nothing, grid 1 is taken if the box is not
 * transform-scaled (zoom host, or a scale of 1 or more) and the backing px are
 * the displayed device px. An exact grid still wins. A transform-scaled box,
 * and a backing the area cap has trimmed below the device's px, stay off.
 *
 * Renderer cells drive configureWetTile and configureInlineBacking directly;
 * overlay cells drive the real handleResize with a real WetInkRenderer and
 * TailRenderer. Only the pixels are fake.
 */
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearScrollProbe, formatScrollProbe } from "./ScrollProbe";

type Fields = Record<string, unknown>;
const noop = (): undefined => undefined;

/** The device ratio a 200% display at 91.3% page zoom reports. */
const ODD_DPR = 1.8257418870925903;
/** The scale the same device measured at 100%. */
const ODD_MEASURED = 0.9999960866;
const CSS_W = 1596, CSS_H = 1236;

function fakeWin(dpr: number, hostZoom: boolean) {
	return {
		devicePixelRatio: dpr,
		getComputedStyle: () => ({ fontSize: "16px" }),
		CSS: { supports: (property: string) => property === "translate" || (property === "zoom" && hostZoom) },
	};
}

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

type TailConfig = { grid: number | null; tileW: number; tileH: number; backing: number } | null;
const tailConfigOf = (tail: TailRenderer) => (tail as unknown as { inlineBacking: TailConfig }).inlineBacking;

/** Both live renderers configured for one band, as the overlay does on resize. */
function renderers(opts: { dpr: number; backing: number; cssScale: number; hostZoom: boolean }) {
	const win = fakeWin(opts.dpr, opts.hostZoom);
	const tile = fakeCanvas(win, 1, 1), tailCanvas = fakeCanvas(win, 1, 1);
	const wet = new WetInkRenderer(fakeCanvas(win, 1, 1), false);
	wet.tileTranslate = true;
	wet.configureWetTile(tile, CSS_W, CSS_H, opts.backing, opts.cssScale, opts.hostZoom);
	const tail = new TailRenderer(tailCanvas);
	tail.configureInlineBacking(CSS_W, CSS_H, opts.backing, opts.cssScale, opts.hostZoom);
	return { wet, tile, tail, tailConfig: tailConfigOf(tail) };
}

/** An overlay whose pane is CSS_W layout px wide and `visualW` visual px wide, at owned scale `pinch`. */
function rig(opts: { dpr: number; visualW: number; pinch: number; hostZoom: boolean }) {
	const win = fakeWin(opts.dpr, opts.hostZoom);
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
	return {
		o, wet, tail, tileCanvas, tailCanvas, tailConfig: () => tailConfigOf(tail),
		backingNow: () => proto.backingNow.call(o),
		placeLayers: () => proto.placeCanvasLayers.call(o),
		probe: () => proto.probeStrokeLayers.call(o),
	};
}

/** Tile side in backing px at grid 1: 256 css px rounded up to a whole backing px. */
const side = (backing: number) => Math.ceil(256 * backing);

describe("the live canvases fall back to whole backing px when no exact grid exists", () => {
	afterEach(() => { clearScrollProbe(); setDiagnosticsEnabled(false); });

	for (const hostZoom of [true, false]) it(`ratio ${ODD_DPR}, backing the ratio, scale 1, ${hostZoom ? "zoom" : "transform"} host: grid 1, tile and compact tail on`, () => {
		const r = renderers({ dpr: ODD_DPR, backing: ODD_DPR, cssScale: 1, hostZoom });
		expect(r.wet.tileGrid, "the wet tile has no grid at the device's own ratio").toBe(1);
		expect([r.tile.width, r.tile.height], "the wet tile is off (1 x 1): every pen event draws into the full wet canvas").toEqual([468, 468]);
		expect(r.tailConfig?.grid ?? null, "the tail has no grid: it stays a full-size layer").toBe(1);
		expect([r.tailConfig?.tileW, r.tailConfig?.tileH], "the tail has no compact tile").toEqual([468, 468]);
	});

	for (const k of [0.518, 0.8734]) it(`ratio 2, free pinch ${k} on a zoom host: grid 1, tile and compact tail on`, () => {
		const backing = 2 * k;
		const r = renderers({ dpr: 2, backing, cssScale: k, hostZoom: true });
		expect(r.wet.tileGrid, `no wet tile grid at ${k}`).toBe(1);
		expect([r.tile.width, r.tile.height]).toEqual([side(backing), side(backing)]);
		expect(r.tailConfig?.grid ?? null, `no tail grid at ${k}`).toBe(1);
		expect([r.tailConfig?.tileW, r.tailConfig?.tileH]).toEqual([side(backing), side(backing)]);
	});

	it("ratio 2, Fit at 0.08 on a zoom host: the tile and compact tail are on", () => {
		const backing = 2 * 0.08;
		const r = renderers({ dpr: 2, backing, cssScale: 0.08, hostZoom: true });
		expect(r.wet.tileGrid ?? null).not.toBeNull();
		expect(r.tile.width * r.tile.height, "the wet tile is off at Fit 0.08").toBeGreaterThan(1);
		expect(r.tailConfig?.grid ?? null).not.toBeNull();
		expect(r.tailConfig?.tileW ?? 0).toBeGreaterThan(0);
	});

	it("an exact grid still wins: ratio 1.5, backing 1.5 keeps grid 3", () => {
		const r = renderers({ dpr: 1.5, backing: 1.5, cssScale: 1, hostZoom: true });
		expect(r.wet.tileGrid).toBe(3);
		expect(r.tailConfig?.grid ?? null).toBe(3);
	});

	it("ratio 2 at scale 1 is unchanged: grid 1, 512 x 512", () => {
		const r = renderers({ dpr: 2, backing: 2, cssScale: 1, hostZoom: true });
		expect(r.wet.tileGrid).toBe(1);
		expect([r.tile.width, r.tile.height]).toEqual([512, 512]);
		expect([r.tailConfig?.tileW, r.tailConfig?.tileH]).toEqual([512, 512]);
	});

	for (const k of [0.518, 0.8734]) it(`control: a transform-scaled box at pinch ${k} stays off`, () => {
		const r = renderers({ dpr: 2, backing: 2 * k, cssScale: k, hostZoom: false });
		expect(r.wet.tileGrid, "a transform-scaled box took the fallback").toBeNull();
		expect([r.tile.width, r.tile.height]).toEqual([1, 1]);
		expect(r.tailConfig?.grid ?? null).toBeNull();
		expect([r.tailConfig?.tileW, r.tailConfig?.tileH]).toEqual([0, 0]);
	});

	it("control: a backing the area cap trimmed below the device's px stays off", () => {
		// 1596 x 1236 css px at an owned 1.2 and ratio 2 is 11.4M device px; the cap trims the backing to sqrt(1e7 / area).
		const trimmed = Math.sqrt(1e7 / (CSS_W * CSS_H));
		const r = renderers({ dpr: 2, backing: trimmed, cssScale: 1.2, hostZoom: true });
		expect(r.wet.tileGrid, "a trimmed backing took the fallback").toBeNull();
		expect([r.tile.width, r.tile.height]).toEqual([1, 1]);
		expect(r.tailConfig?.grid ?? null).toBeNull();
	});

	for (const hostZoom of [true, false]) for (const measured of [1, ODD_MEASURED]) it(`overlay at ratio ${ODD_DPR}, measured ${measured}, ${hostZoom ? "zoom" : "transform"} host: backing is the ratio, tile 468 x 468, tail compact`, () => {
		const r = rig({ dpr: ODD_DPR, visualW: CSS_W * measured, pinch: 1, hostZoom });
		expect(r.o.committedBacking, "the backing is not the device ratio").toBe(ODD_DPR);
		expect(r.backingNow()).toBe(r.o.committedBacking);
		expect([r.tileCanvas.width, r.tileCanvas.height], "the wet tile is off (1 x 1)").toEqual([468, 468]);
		expect(r.tailConfig()?.grid ?? null, "the tail has no grid").toBe(1);
		expect([r.tailConfig()?.tileW, r.tailConfig()?.tileH]).toEqual([468, 468]);
		r.placeLayers();
		expect([r.tileCanvas.width, r.tileCanvas.height], "a band style update turned the tile off").toEqual([468, 468]);
		expect(r.tailConfig()?.grid ?? null, "a band style update dropped the tail grid").toBe(1);
	});

	for (const k of [0.518, 0.8734]) it(`overlay at ratio 2, owned pinch ${k}, zoom host: tile and compact tail on`, () => {
		const r = rig({ dpr: 2, visualW: CSS_W * k, pinch: k, hostZoom: true });
		const backing = r.o.committedBacking as number;
		expect(backing).toBeCloseTo(2 * k, 12);
		expect([r.tileCanvas.width, r.tileCanvas.height], `the wet tile is off at ${k}`).toEqual([side(backing), side(backing)]);
		expect(r.tailConfig()?.grid ?? null, `no tail grid at ${k}`).toBe(1);
	});

	it(`the probe's per-stroke line prints the device ratio`, () => {
		const r = rig({ dpr: ODD_DPR, visualW: CSS_W * ODD_MEASURED, pinch: 1, hostZoom: true });
		setDiagnosticsEnabled(true);
		clearScrollProbe();
		r.probe();
		const lines = formatScrollProbe().split("\n").filter(l => / LAYERS {3}/.test(l));
		expect(lines.length, formatScrollProbe()).toBe(1);
		expect(lines[0]).toContain(`backing=${ODD_DPR} tile=468x468 tileGrid=1 tail=468x468 tailGrid=1 tailMode=empty`);
		expect(lines[0]).toContain(` dpr=${ODD_DPR}`);
		expect(lines[0]).not.toContain("tile OFF");
		expect(lines[0]).not.toContain("tail FULL");
	});
});

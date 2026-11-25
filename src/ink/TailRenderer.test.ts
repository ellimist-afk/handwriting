import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live head is a separate canvas layer drawn OVER the wet ribbon, so its
 * width has to be the ribbon's width or the join shows as a step. It used to
 * be computed here from raw pressure while the ribbon underneath came from
 * the shaper, which carries three things raw pressure does not: velocity
 * thinning, the start taper, and smoothed pressure. At stroke start with a
 * fast pen that is up to ~12x, and it reads as a seam rather than as a
 * thickening.
 *
 * `drawHead` now takes an optional WORLD half-width and uses it when given.
 * This test reads that number directly, in world units, before any camera
 * conversion, by mocking `fillRibbon` - the one place `drawHead` hands its
 * geometry to the canvas. The seam is StrokeOutline.test.ts's.
 */

const capturedRibbons: { x: number; y: number; hw: number }[][] = [];

vi.mock("./RibbonRenderer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RibbonRenderer")>();
	return {
		...actual,
		fillRibbon: (_ctx: unknown, _cam: unknown, pts: { x: number; y: number; hw: number }[]) => {
			capturedRibbons.push(pts);
		},
	};
});

import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN, widthForPressure } from "./PenStyle";
import { TailRenderer } from "./TailRenderer";

type Rect = [number, number, number, number];

/** The PdfWetShape.test.ts fake: every call a no-op, clearRect remembered. */
function fakeCanvas(): { canvas: HTMLCanvasElement; clears: Rect[] } {
	const clears: Rect[] = [];
	const ctx = new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "clearRect") return (...a: Rect) => void clears.push(a);
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				if (prop === "setTransform") return () => undefined;
				return () => undefined;
			},
			set() {
				return true;
			},
		}
	);
	return { canvas: { getContext: () => ctx } as unknown as HTMLCanvasElement, clears };
}

const cam: CameraState = { x: 100, y: 200, zoom: 2 };
const style = DEFAULT_PEN;
const from = { x: 110, y: 210 };
const to = { x: 130, y: 215 };

/** The one hw every point of the drawn ribbon shares. */
function drawnHalfWidth(): number {
	expect(capturedRibbons).toHaveLength(1);
	const pts = capturedRibbons[0]!;
	expect(pts).toHaveLength(2);
	expect(pts[0]!.hw).toBe(pts[1]!.hw);
	return pts[0]!.hw;
}

describe("TailRenderer.drawHead width", () => {
	beforeEach(() => {
		capturedRibbons.length = 0;
	});

	it("takes the world half-width it is handed, not the pressure law", () => {
		// The precondition IS the defect: the two numbers must disagree, or
		// this test passes whatever drawHead does with its argument.
		const shaped = 0.31;
		const fromPressure = widthForPressure(style, 0.9) / 2;
		expect(shaped).not.toBeCloseTo(fromPressure, 6);

		const { canvas } = fakeCanvas();
		new TailRenderer(canvas).drawHead(cam, style, from, to, 0.9, shaped);
		expect(drawnHalfWidth()).toBe(shaped);
	});

	it("uses the width in world units, with no camera conversion of its own", () => {
		// A half-width handed in at zoom 2 must arrive unscaled: the ribbon
		// point's `hw` is a world half-width and fillRibbon does the camera.
		// Dividing or multiplying by zoom anywhere on the way in is the
		// factor-of-zoom half of the unit error this fix exists to avoid.
		const { canvas } = fakeCanvas();
		new TailRenderer(canvas).drawHead(cam, style, from, to, 0.9, 0.31);
		expect(cam.zoom).toBe(2);
		expect(drawnHalfWidth()).toBe(0.31);
	});

	it("falls back to the pressure law when no width is given", () => {
		// The fallback has to stay exactly what this drew before the
		// parameter existed - it is what a caller with no wet layer to ask
		// still gets, and it is the wet layer's own non-shaping branch.
		const { canvas } = fakeCanvas();
		new TailRenderer(canvas).drawHead(cam, style, from, to, 0.9);
		expect(drawnHalfWidth()).toBe(widthForPressure(style, 0.9) / 2);
	});

	it("pads the dirty rect with the width it actually drew", () => {
		// The erase box is computed from the same hw. Take the width from
		// one source and the padding from the other and a wide head leaves a
		// smear the next clear() does not reach.
		const wide = 12;
		const fromPressure = widthForPressure(style, 0.9) / 2;
		expect(wide).toBeGreaterThan(fromPressure);

		const { canvas, clears } = fakeCanvas();
		const tail = new TailRenderer(canvas);
		tail.drawHead(cam, style, from, to, 0.9, wide);
		tail.clear();

		expect(clears).toHaveLength(1);
		const [x, y, w, h] = clears[0]!;
		const pad = wide * cam.zoom + 2;
		const x1 = (from.x - cam.x) * cam.zoom;
		const y1 = (from.y - cam.y) * cam.zoom;
		const x2 = (to.x - cam.x) * cam.zoom;
		const y2 = (to.y - cam.y) * cam.zoom;
		expect(x).toBeCloseTo(Math.min(x1, x2) - pad, 10);
		expect(y).toBeCloseTo(Math.min(y1, y2) - pad, 10);
		expect(w).toBeCloseTo(Math.abs(x2 - x1) + pad * 2, 10);
		expect(h).toBeCloseTo(Math.abs(y2 - y1) + pad * 2, 10);
	});
});

/**
 * `clear()`'s no-box fallback, which is what lets the pen-up sites take the
 * dirty-rect clear at all.
 *
 * Three paths on this class PAINT and then null the dirty box without leaving
 * one behind - `drawLasso`, `drawSelectionBox` and `drawSpaceDivider`, and the
 * first says so in its own comment. Against a nulled box the old
 * `if (!this.dirty) return;` was a total NO-OP: measured in real Chromium over
 * three tail states x two zooms x two device pixel ratios, it left 920, 1453,
 * 3356 and 5091 painted pixels - in every case exactly what had been drawn,
 * nothing erased at all - where `clearAll` erased the canvas in all twelve
 * (`test/measure/TailClearBox.test.ts`, outside the gate).
 *
 * NOTE THE LIMIT OF THE CLAIM. That is a CONDITIONAL: if the box is null then
 * `clear()` erases nothing. Nobody has shown an ink pen-up can reach that
 * state - a pen-down dissolves the selection for a bare tip, and a lasso
 * gesture ends on its own branch - and this fallback is not evidence that it
 * can. It makes the question moot at no cost, which is why it is here instead
 * of a reachability hunt.
 *
 * This file has no real canvas, so the pixel count lives in the measure suite
 * above; what is pinned here is the CALL, executed - a nulled box plus a size
 * issues a whole-canvas clearRect - so the gate notices if the fallback goes.
 */
describe("TailRenderer.clear falls back to the whole canvas when it has no box", () => {
	const W = 320;
	const H = 240;

	/** Paint, then null the box the way the selection UI does. */
	function paintAndNull(tail: TailRenderer): void {
		tail.drawSelectionBox(cam, { x: 110, y: 210, width: 40, height: 25 }, "#1e6ec8");
	}

	it("clears the whole canvas when the box was nulled by the selection UI", () => {
		const { canvas, clears } = fakeCanvas();
		const tail = new TailRenderer(canvas);
		paintAndNull(tail);
		// The precondition IS the defect: with no size this is a no-op, which
		// is exactly the state the measure suite counted pixels in.
		tail.clear();
		expect(clears, "a bare clear() erased something, so the fallback is untested").toEqual(
			[]
		);

		tail.clear(W, H);
		expect(clears, "the nulled box did not fall back to the whole canvas").toEqual([
			[0, 0, W, H],
		]);
	});

	it("still prefers the dirty rect when it has one, so the hot path is untouched", () => {
		// The fallback must not turn every clear into a whole-canvas clear:
		// the head is erased once per pointer event at 200-250 Hz.
		const { canvas, clears } = fakeCanvas();
		const tail = new TailRenderer(canvas);
		tail.drawHead(cam, style, from, to, 0.9, 4);
		tail.clear(W, H);
		expect(clears).toHaveLength(1);
		const [x, y, w, h] = clears[0]!;
		expect([x, y, w, h], "a head with a real box took the whole-canvas path").not.toEqual([
			0, 0, W, H,
		]);
		expect(w).toBeLessThan(W);
		expect(h).toBeLessThan(H);
	});

	it("is a no-op with no box and no size, which is what the hot path calls", () => {
		// The size is optional precisely so the per-event callers keep the
		// early return they have. Changing that would put a whole-canvas
		// clearRect on the 200-250 Hz path.
		const { canvas, clears } = fakeCanvas();
		const tail = new TailRenderer(canvas);
		paintAndNull(tail);
		tail.clear();
		expect(clears).toEqual([]);
	});
});

/**
 * The compact tail's size across note zoom, on the tablet pane the zoom pins use (ZoomLayersPins.test.ts). Band,
 * grid and tile sizes up to 200 percent are the ones the real overlay printed in Chromium at those rows; they are
 * literals here so a changed size law cannot carry its own expectation. Above 200 percent the tile is never larger
 * on screen than it is at 200 percent, so it stays a small share of the band and stays on at 800 percent, where
 * 256 css px times the backing is wider than the band and used to leave the tail full size.
 */
const ODD_RATIO = 1.8257418870925903;
type TailRow = { dpr: number; zoom: number; band: [number, number]; grid: number; size: [number, number] };
const TAIL_ROWS: TailRow[] = [
	{ dpr: 2, zoom: 1, band: [3556, 2734], grid: 1, size: [512, 512] },
	{ dpr: 2, zoom: 1.5, band: [3555, 2733], grid: 3, size: [768, 768] },
	{ dpr: 2, zoom: 1.79, band: [3555, 2732], grid: 1, size: [917, 917] },
	{ dpr: 2, zoom: 1.95, band: [3557, 2734], grid: 39, size: [1014, 1014] },
	{ dpr: 2, zoom: 2, band: [3556, 2736], grid: 1, size: [1024, 1024] },
	{ dpr: 2, zoom: 2.5, band: [3555, 2730], grid: 5, size: [1025, 1025] },
	{ dpr: 2, zoom: 3.5, band: [3556, 2730], grid: 7, size: [1029, 1029] },
	{ dpr: 2, zoom: 4, band: [3560, 2736], grid: 1, size: [1024, 1024] },
	{ dpr: 2, zoom: 6, band: [3552, 2736], grid: 3, size: [1026, 1026] },
	{ dpr: 2, zoom: 8, band: [3568, 2752], grid: 1, size: [1024, 1024] },
	{ dpr: ODD_RATIO, zoom: 1, band: [3246, 2496], grid: 1, size: [468, 468] },
	{ dpr: ODD_RATIO, zoom: 1.5, band: [3245, 2495], grid: 1, size: [702, 702] },
	{ dpr: ODD_RATIO, zoom: 1.79, band: [3245, 2494], grid: 1, size: [837, 837] },
	{ dpr: ODD_RATIO, zoom: 1.95, band: [3247, 2496], grid: 1, size: [912, 912] },
	{ dpr: ODD_RATIO, zoom: 2, band: [3246, 2494], grid: 1, size: [935, 935] },
	{ dpr: ODD_RATIO, zoom: 2.5, band: [3245, 2492], grid: 1, size: [935, 935] },
	{ dpr: ODD_RATIO, zoom: 3.5, band: [3246, 2492], grid: 1, size: [935, 935] },
	{ dpr: ODD_RATIO, zoom: 4, band: [3243, 2498], grid: 1, size: [935, 935] },
	{ dpr: ODD_RATIO, zoom: 6, band: [3243, 2498], grid: 1, size: [935, 935] },
	{ dpr: ODD_RATIO, zoom: 8, band: [3257, 2512], grid: 1, size: [935, 935] },
];

/** A canvas whose window reports the device ratio and supports translate; its pixels are fake. */
function ratioCanvas(dpr: number): HTMLCanvasElement {
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop) {
			if (prop === "getContextAttributes") return () => ({ desynchronized: false });
			return () => undefined;
		},
		set() { return true; },
	});
	const win = { devicePixelRatio: dpr, CSS: { supports: (property: string) => property === "translate" } };
	return { width: 1, height: 1, style: {}, ownerDocument: { defaultView: win }, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

type InlineBacking = { grid: number | null; tileW: number; tileH: number };

describe("the compact tail's size across note zoom", () => {
	for (const row of TAIL_ROWS) {
		const at = row.zoom <= 2 ? "as it is today" : "never larger than at 200 percent";
		it(`ratio ${row.dpr}, note zoom ${row.zoom}: the compact tail is ${row.size[0]} x ${row.size[1]}, ${at}, and at most half the band`, () => {
			const backing = row.dpr * row.zoom;
			const cssW = row.zoom === 1 ? 1778 : row.band[0] / backing, cssH = row.zoom === 1 ? 1367 : row.band[1] / backing;
			expect([Math.round(cssW * backing), Math.round(cssH * backing)], "the band in backing px").toEqual(row.band);
			const tail = new TailRenderer(ratioCanvas(row.dpr));
			tail.configureInlineBacking(cssW, cssH, backing, row.zoom, true);
			const config = (tail as unknown as { inlineBacking: InlineBacking | null }).inlineBacking;
			expect(config?.grid ?? null, "the grid").toBe(row.grid);
			expect([config?.tileW, config?.tileH], `the compact tail at ${row.zoom} (0 x 0 is off: the tail stays full size)`).toEqual(row.size);
			expect((config?.tileW ?? 0) * (config?.tileH ?? 0), "the tile covers more than half the band").toBeLessThanOrEqual(row.band[0] * row.band[1] / 2);
		});
	}
});

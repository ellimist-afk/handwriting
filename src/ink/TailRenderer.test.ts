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

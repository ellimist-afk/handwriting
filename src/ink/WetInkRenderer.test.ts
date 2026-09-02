import { afterEach, describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import { setInkShaping } from "./InkShape";
import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, widthForPressure } from "./PenStyle";

/**
 * A 2d context that answers every call with a no-op and remembers clearRect.
 * The renderer's drawing is exercised for real; only the pixels are fake.
 */
type Rect = [number, number, number, number];

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
	const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
	return { canvas, clears };
}

const cam: CameraState = { x: 100, y: 200, zoom: 2 };
const style = DEFAULT_PEN;

describe("WetInkRenderer.clearStroke", () => {
	it("clears the whole canvas when nothing was drawn", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.clearStroke(800, 600);
		expect(clears).toEqual([[0, 0, 800, 600]]);
	});

	it("clears only the box the stroke painted, in screen px, padded by its width", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		// world (110,210) -> screen (20,20); world (160,240) -> screen (120,80)
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		expect(clears).toHaveLength(1);
		const [x, y, w, h] = clears[0]!;
		// contains the segment
		expect(x).toBeLessThanOrEqual(20);
		expect(y).toBeLessThanOrEqual(20);
		expect(x + w).toBeGreaterThanOrEqual(120);
		expect(y + h).toBeGreaterThanOrEqual(80);
		// and is nowhere near the whole canvas
		expect(w).toBeLessThan(200);
		expect(h).toBeLessThan(150);
		// padding is bounded by the stroke width at this zoom, plus a couple px
		expect(20 - x).toBeLessThanOrEqual(style.baseWidth * cam.zoom + 3);
	});

	it("clamps the box to the canvas", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		// screen (-10,-10) -> (10,10): box starts off-canvas
		wet.beginStroke({ x: 95, y: 195, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 105, y: 205, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		const [x, y] = clears[0]!;
		expect(x).toBe(0);
		expect(y).toBe(0);
	});

	it("falls back to a full clear when the box is poisoned, never to no clear", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.beginStroke({ x: 110, y: 210, pressure: NaN, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: NaN, t: 1 });
		wet.clearStroke(800, 600);
		expect(clears).toEqual([[0, 0, 800, 600]]);
	});

	it("forgets the box after clearing, so the next stroke starts fresh", () => {
		const { canvas, clears } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style);
		wet.appendPoint(cam, style, { x: 160, y: 240, pressure: 0.5, t: 1 });
		wet.clearStroke(800, 600);
		wet.clearStroke(800, 600);
		expect(clears[1]).toEqual([0, 0, 800, 600]);
	});
});

/**
 * The wet layer must make the SAME two decisions the committed renderer makes
 * (StrokeRenderer.drawStroke): shaped width only for a non-flat tool on a
 * shaping device with the switch on, and a smoothed centerline only when
 * `centerlineSmoothed` says so. Both were inferred from `shape`, which is a
 * device-and-layer fact, so a mouse stroke read as "flat" and a shared wet
 * pair could not tell its two tools apart at all.
 *
 * `head()` is the seam: it is the raw stub between the settled curve and the
 * nib, and it exists only on a smoothed centerline.
 */
describe("WetInkRenderer takes the tool's flatness from the stroke", () => {
	afterEach(() => setInkShaping(true));

	const drive = (opts: { shape: boolean; flat: boolean }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		wet.beginStroke({ x: 110, y: 210, pressure: 0.5, t: 0 }, style, opts.flat);
		wet.appendPoint(cam, style, { x: 120, y: 210, pressure: 0.5, t: 8 });
		wet.appendPoint(cam, style, { x: 130, y: 215, pressure: 0.5, t: 16 });
		return wet;
	};

	it("draws a pen stroke raw when smoothing is off", () => {
		setInkShaping(false);
		expect(drive({ shape: true, flat: false }).head()).toBeUndefined();
	});

	it("keeps the highlighter smoothed on a layer dressed for the pen", () => {
		// The PDF's case: one wet pair, `shape` permanently true, both tools.
		setInkShaping(false);
		expect(drive({ shape: true, flat: true }).head()).toBeDefined();
	});

	it("draws a mouse stroke raw when smoothing is off", () => {
		// `shape` false is the MOUSE, which is unshaped and not flat. Inferred
		// flatness made it smoothed here and raw at pen-up.
		setInkShaping(false);
		expect(drive({ shape: false, flat: false }).head()).toBeUndefined();
	});

	it("smooths every tool when the setting is on", () => {
		for (const shape of [true, false]) {
			for (const flat of [true, false]) {
				expect(drive({ shape, flat }).head()).toBeDefined();
			}
		}
	});

	it("shapes the width only for a non-flat tool on a shaping device", () => {
		// liveWidthPx reports the shaper's half-width doubled when shaping is
		// on for the stroke, and the raw pressure width when it is not. At
		// pen-down the shaper is at the tip floor, so the two are far apart.
		const raw = widthForPressure(style, 0.5);
		const at = (shape: boolean, flat: boolean) => {
			const { canvas } = fakeCanvas();
			const wet = new WetInkRenderer(canvas, false);
			wet.smooth = true;
			wet.shape = shape;
			wet.beginStroke({ x: 0, y: 0, pressure: 0.5, t: 0 }, style, flat);
			return wet.liveWidthPx({ x: 0, y: 0, zoom: 1 }, style, 0.5);
		};
		expect(at(true, false)).toBeLessThan(raw / 2);
		expect(at(true, true)).toBeCloseTo(raw, 10);
		expect(at(false, false)).toBeCloseTo(raw, 10);
	});
});

/**
 * The live head is drawn on a layer above this one and has to be the same
 * width as the ribbon it continues. `liveHalfWidth` is how it asks, and the
 * unit is the one thing that can go wrong: `liveWidthPx` is a FULL width in
 * css px, so a head derived from it needs `/ cam.zoom / 2`, and dropping
 * either half of that ships a head at two or four times the ribbon.
 */
describe("WetInkRenderer.liveHalfWidth", () => {
	afterEach(() => setInkShaping(true));

	const at = (opts: { shape: boolean; flat: boolean; pressure?: number }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		const p = opts.pressure ?? 0.5;
		wet.beginStroke({ x: 110, y: 210, pressure: p, t: 0 }, style, opts.flat);
		wet.appendPoint(cam, style, { x: 120, y: 210, pressure: p, t: 8 });
		wet.appendPoint(cam, style, { x: 130, y: 215, pressure: p, t: 16 });
		return wet;
	};

	it("is exactly half of liveWidthPx's world width, on both branches", () => {
		for (const shape of [true, false]) {
			const wet = at({ shape, flat: false });
			const half = wet.liveHalfWidth(style, 0.5);
			const px = wet.liveWidthPx(cam, style, 0.5);
			// Precondition: zoom is not 1 and the two numbers are not the
			// same, so a call that forgot either conversion fails here
			// rather than passing by coincidence.
			expect(cam.zoom).toBe(2);
			expect(half).not.toBeCloseTo(px, 6);
			expect(half).toBeCloseTo(px / cam.zoom / 2, 10);
		}
	});

	it("reads the shaper only on the shaped branch, never a stale one", () => {
		// `shape` and `smooth` are different switches: a MOUSE stroke and a
		// HIGHLIGHTER both run unshaped with the centerline still smoothed,
		// so head() fires and this is asked for a width - while the shaper
		// was never reset for that stroke and still holds the last shaped
		// one's. It must come from pressure there.
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;

		wet.shape = true;
		wet.beginStroke({ x: 110, y: 210, pressure: 1, t: 0 }, style, false);
		for (let i = 1; i <= 6; i++) {
			wet.appendPoint(cam, style, { x: 110 + i * 6, y: 210, pressure: 1, t: i * 8 });
		}
		const shaped = wet.liveHalfWidth(style, 1);
		const rawAt = widthForPressure(style, 0.2) / 2;
		// Precondition: the shaper holds a value the pressure branch cannot
		// produce, so "stale shaper" and "correct answer" are distinguishable.
		expect(shaped).toBeGreaterThan(rawAt * 1.5);

		wet.shape = false;
		wet.beginStroke({ x: 300, y: 300, pressure: 0.2, t: 100 }, style, false);
		expect(wet.head()).toBeDefined();
		expect(wet.liveHalfWidth(style, 0.2)).toBeCloseTo(rawAt, 10);
	});
});

/**
 * The pen-down dot is the only head draw that is not gated on `head()`, and
 * for a TAP it is the entire visible mark: the wet layer has painted nothing
 * yet and the shaper has just reset to the tip floor, 12% of nominal. Handed
 * the bare live width it draws a sliver. Alan's ruling, 2026-09-02: it takes
 * the shaped width like everything else, with a floor at the nib's own base
 * width, so a tap looks like the nib rather than like the start of a stroke.
 */
describe("WetInkRenderer.contactHalfWidth", () => {
	afterEach(() => setInkShaping(true));

	const atPenDown = (opts: { shape: boolean; flat: boolean; pressure: number }) => {
		const { canvas } = fakeCanvas();
		const wet = new WetInkRenderer(canvas, false);
		wet.smooth = true;
		wet.shape = opts.shape;
		wet.beginStroke({ x: 0, y: 0, pressure: opts.pressure, t: 0 }, style, opts.flat);
		return wet;
	};

	it("holds the tap at the nib when the shaped width is at the tip floor", () => {
		const wet = atPenDown({ shape: true, flat: false, pressure: 0.5 });
		// Precondition: without the floor this dot draws at the tip floor,
		// which is where the near-invisible tap came from.
		expect(wet.liveHalfWidth(style, 0.5)).toBeLessThan(style.baseWidth / 2 / 4);
		expect(wet.contactHalfWidth(style, 0.5)).toBeCloseTo(style.baseWidth / 2, 10);
	});

	it("floors the raw branch too - Boox and mouse still draw this dot", () => {
		// Smoothing off takes the five gated head sites dark; this one keeps
		// drawing, so the floor has to hold on the pressure branch as well.
		setInkShaping(false);
		const wet = atPenDown({ shape: true, flat: false, pressure: 0.2 });
		const raw = widthForPressure(style, 0.2) / 2;
		expect(wet.liveHalfWidth(style, 0.2)).toBeCloseTo(raw, 10);
		expect(raw).toBeLessThan(style.baseWidth / 2);
		expect(wet.contactHalfWidth(style, 0.2)).toBeCloseTo(style.baseWidth / 2, 10);
	});

	it("is the nib of the tool in hand, not of the pen", () => {
		// The floor is `style.baseWidth`, so a highlighter tap is a
		// highlighter-sized dot. It is also a FULL width: the floor on a
		// half-width is baseWidth/2, and flooring at baseWidth itself would
		// draw every tap at twice the nib.
		const wet = atPenDown({ shape: true, flat: true, pressure: 0.5 });
		expect(HIGHLIGHTER_PEN.baseWidth).toBeGreaterThan(style.baseWidth);
		expect(wet.contactHalfWidth(HIGHLIGHTER_PEN, 0.5)).toBeCloseTo(
			HIGHLIGHTER_PEN.baseWidth / 2,
			10
		);
	});

	it("never falls below the nib whatever the pressure sample says", () => {
		// widthForPressure tops out AT baseWidth and the shaped width scales
		// it by two factors that are both <= 1, so the floor always wins
		// here: a tap draws at the nib, full stop. That is the ruling, and
		// it is a behaviour change rather than only a guard.
		for (const pressure of [0, 0.25, 0.5, 0.75, 1]) {
			const wet = atPenDown({ shape: true, flat: false, pressure });
			expect(wet.contactHalfWidth(style, pressure)).toBeCloseTo(style.baseWidth / 2, 10);
		}
	});
});

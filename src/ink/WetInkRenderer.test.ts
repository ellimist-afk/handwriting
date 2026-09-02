import { afterEach, describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import { setInkShaping } from "./InkShape";
import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN, widthForPressure } from "./PenStyle";

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

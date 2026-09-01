import { describe, expect, it } from "vitest";
import { WetInkRenderer } from "./WetInkRenderer";
import type { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN } from "./PenStyle";

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

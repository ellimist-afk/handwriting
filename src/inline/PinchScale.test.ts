import { describe, expect, it } from "vitest";

import {
	MAX_PINCH_SCALE,
	MIN_PINCH_SCALE,
	anchoredScroll,
	clampPinchScale,
	counterSizePercent,
	pinchScale,
} from "./PinchScale";

describe("pinchScale", () => {
	it("scales the value captured at gesture start", () => {
		expect(pinchScale(1, 2)).toBe(2);
		expect(pinchScale(2, 0.5)).toBe(1);
	});

	it("never accumulates: out and back returns to the starting scale", () => {
		const start = 1.5;
		expect(pinchScale(start, 1.6)).toBeCloseTo(2.4, 6);
		// The next sample is still measured from `start`.
		expect(pinchScale(start, 1)).toBe(start);
	});

	it("clamps at both ends", () => {
		expect(pinchScale(1, 100)).toBe(MAX_PINCH_SCALE);
		expect(pinchScale(1, 0.001)).toBe(MIN_PINCH_SCALE);
	});

	it("holds still on junk rather than collapsing the editor", () => {
		expect(pinchScale(Number.NaN, 2)).toBe(1);
		expect(pinchScale(2, Number.NaN)).toBe(2);
		expect(clampPinchScale(0)).toBe(1);
	});
});

describe("counterSizePercent", () => {
	it("sizes the box so the painted result fills the pane", () => {
		// Scaled 2x, the box must claim half the width to paint at 100%.
		expect(counterSizePercent(2)).toBe(50);
		expect(counterSizePercent(1)).toBe(100);
		expect(counterSizePercent(0.5)).toBe(200);
	});
});

describe("anchoredScroll", () => {
	it("keeps the point under the fingers still", () => {
		// Centroid 300px into the pane, already scrolled 100, zooming 1 -> 2.
		// The content coordinate under the fingers is (100+300)/1 = 400.
		// At scale 2 that coordinate sits at 800, so the scroll must be 500 to
		// leave it at 300 on screen.
		expect(anchoredScroll(100, 300, 1, 2)).toBe(500);
	});

	it("is the exact inverse when the pinch reverses", () => {
		const out = anchoredScroll(100, 300, 1, 2);
		expect(anchoredScroll(out, 300, 2, 1)).toBe(100);
	});

	it("does nothing when the scale does not change", () => {
		expect(anchoredScroll(250, 300, 1.5, 1.5)).toBe(250);
	});

	it("never scrolls above the top of the document", () => {
		// Zooming out near the origin wants a negative offset.
		expect(anchoredScroll(0, 50, 2, 1)).toBe(0);
	});

	it("holds the current offset on junk scales", () => {
		expect(anchoredScroll(120, 300, 0, 2)).toBe(120);
		expect(anchoredScroll(120, 300, 1, Number.NaN)).toBe(120);
	});
});

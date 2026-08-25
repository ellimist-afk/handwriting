import { describe, expect, it } from "vitest";

import {
	MAX_FONT_PX,
	MIN_FONT_PX,
	PINCH_SLOP_PX,
	pinchEngaged,
	pinchFontSize,
	pinchRatio,
	pinchSpread,
} from "./PinchZoom";

describe("pinchSpread", () => {
	it("measures the distance between the two contacts", () => {
		expect(pinchSpread({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(pinchSpread({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
	});
});

describe("pinchEngaged", () => {
	it("waits for the slop so a two-finger tap never resizes the note", () => {
		expect(pinchEngaged(100, 100)).toBe(false);
		expect(pinchEngaged(100, 100 + PINCH_SLOP_PX - 1)).toBe(false);
	});

	it("engages opening or closing", () => {
		expect(pinchEngaged(100, 100 + PINCH_SLOP_PX)).toBe(true);
		expect(pinchEngaged(100, 100 - PINCH_SLOP_PX)).toBe(true);
	});
});

describe("pinchRatio", () => {
	it("is the plain ratio of current spread to starting spread", () => {
		expect(pinchRatio(100, 200)).toBe(2);
		expect(pinchRatio(100, 50)).toBe(0.5);
	});

	it("holds still when the fingers land almost on top of each other", () => {
		// Otherwise a start spread near zero sends the ratio to infinity and
		// the note explodes to max font on the first sample.
		expect(pinchRatio(0, 300)).toBe(1);
		expect(pinchRatio(0.4, 300)).toBe(1);
	});
});

describe("pinchFontSize", () => {
	it("scales the size the gesture started from", () => {
		expect(pinchFontSize(16, 2)).toBe(32);
		expect(pinchFontSize(16, 0.5)).toBe(8 < MIN_FONT_PX ? MIN_FONT_PX : 8);
	});

	it("never accumulates: out and back returns to the starting size", () => {
		const start = 16;
		const out = pinchFontSize(start, 1.5);
		expect(out).toBe(24);
		// The next sample is still measured from `start`, not from `out`.
		expect(pinchFontSize(start, 1)).toBe(start);
	});

	it("clamps to a sane range", () => {
		expect(pinchFontSize(16, 100)).toBe(MAX_FONT_PX);
		expect(pinchFontSize(16, 0.001)).toBe(MIN_FONT_PX);
	});

	it("returns null when there is nothing sane to ask for", () => {
		expect(pinchFontSize(0, 2)).toBeNull();
		expect(pinchFontSize(16, 0)).toBeNull();
		expect(pinchFontSize(Number.NaN, 2)).toBeNull();
		expect(pinchFontSize(16, Number.NaN)).toBeNull();
	});
});

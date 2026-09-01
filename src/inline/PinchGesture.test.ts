import { describe, expect, it } from "vitest";

import { PINCH_SLOP_PX, pinchEngaged, pinchRatio, pinchSpread } from "./PinchScale";

describe("pinchSpread", () => {
	it("measures the distance between the two contacts", () => {
		expect(pinchSpread({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(pinchSpread({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
	});
})

describe("pinchEngaged", () => {
	it("waits for the slop so a two-finger tap never resizes the note", () => {
		expect(pinchEngaged(100, 100)).toBe(false);
		expect(pinchEngaged(100, 100 + PINCH_SLOP_PX - 1)).toBe(false);
	});

	it("engages opening or closing", () => {
		expect(pinchEngaged(100, 100 + PINCH_SLOP_PX)).toBe(true);
		expect(pinchEngaged(100, 100 - PINCH_SLOP_PX)).toBe(true);
	});
})

describe("pinchRatio", () => {
	it("is the bare ratio of current spread to starting spread", () => {
		expect(pinchRatio(100, 200)).toBe(2);
		expect(pinchRatio(100, 50)).toBe(0.5);
	});

	it("holds still when the fingers land almost on top of each other", () => {
		// Otherwise a start spread near zero sends the ratio to infinity and
		// the note explodes to max font on the first sample.
		expect(pinchRatio(0, 300)).toBe(1);
		expect(pinchRatio(0.4, 300)).toBe(1);
	});
})


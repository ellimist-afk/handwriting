import { describe, expect, it } from "vitest";

import { PINCH_SLOP_PX, pinchEngaged, pinchMidpoint, pinchRatio, pinchSpread } from "./PinchScale";

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

describe("pinchMidpoint", () => {
	// audit-fixes-design.md 5i I2: InlinePenRouter's release path used to
	// compute the pinch-end centroid AFTER removing the lifted contact from
	// its touch map, so it always read one point instead of two and reported
	// {0,0}. This is the pure math half of that fix - the router's own
	// before/after-delete ordering is stateful and is fixed directly there.
	it("is the midpoint of the two contacts", () => {
		expect(pinchMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
	});

	it("is the point itself when both contacts coincide", () => {
		expect(pinchMidpoint({ x: 7, y: -3 }, { x: 7, y: -3 })).toEqual({ x: 7, y: -3 });
	});

	it("never collapses to {0,0} just because the two points are real, non-zero contacts", () => {
		// This is the exact shape of the bug: {0,0} is a legitimate midpoint
		// only when it is actually the answer, never a fallback for "one of
		// the two contacts was already gone".
		const mid = pinchMidpoint({ x: 100, y: 200 }, { x: 140, y: 240 });
		expect(mid).toEqual({ x: 120, y: 220 });
		expect(mid).not.toEqual({ x: 0, y: 0 });
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


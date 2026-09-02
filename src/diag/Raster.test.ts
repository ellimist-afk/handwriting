/**
 * Raster's pure functions (§5l L2). `countPaintedPixels` and `inspectRaster`
 * need a live canvas/DOM context and are not covered here.
 */

import { describe, expect, it } from "vitest";
import { computeCanvasSize, scaleOfTransform } from "./Raster";

describe("scaleOfTransform", () => {
	it("no transform - untransformed", () => {
		expect(scaleOfTransform("none")).toBe(1);
		expect(scaleOfTransform("")).toBe(1);
	});

	it("uniform scale, no rotation - a alone was already right", () => {
		expect(scaleOfTransform("matrix(2,0,0,2,0,0)")).toBe(2);
	});

	it("scale 2 rotated 90deg - a is 0, hypot(a,b) is still 2 (the bug this fixes)", () => {
		expect(scaleOfTransform("matrix(0,2,-2,0,0,0)")).toBe(2);
	});

	it("matrix3d is not parsed - reports untransformed by design, documented in the function comment", () => {
		expect(scaleOfTransform("matrix3d(2,0,0,0,0,2,0,0,0,0,1,0,0,0,0,1)")).toBe(1);
	});
});

describe("computeCanvasSize", () => {
	it("dpr 1 - backing store equals the CSS size", () => {
		const s = computeCanvasSize(300, 150, 1);
		expect(s).toEqual({ backingW: 300, backingH: 150, cssW: 300, cssH: 150 });
	});

	it("dpr 2 - backing store doubles, CSS size unchanged", () => {
		const s = computeCanvasSize(300, 150, 2);
		expect(s).toEqual({ backingW: 600, backingH: 300, cssW: 300, cssH: 150 });
	});

	it("dpr 1.5 - backing store rounds, CSS size is the exact inverse of the rounded backing store", () => {
		const s = computeCanvasSize(101, 51, 1.5);
		// 101 * 1.5 = 151.5 -> rounds to 152; 51 * 1.5 = 76.5 -> rounds to 77 (round-half-up).
		expect(s.backingW).toBe(152);
		expect(s.backingH).toBe(77);
		// cssW/cssH are derived back from the rounded backing store, not kept
		// fractional, so backingW / dpr * dpr === backingW exactly.
		expect(s.cssW).toBeCloseTo(152 / 1.5, 10);
		expect(s.cssH).toBeCloseTo(77 / 1.5, 10);
	});
});

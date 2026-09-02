import { describe, expect, it } from "vitest";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, shapeFor } from "./PenStyle";

/**
 * `shapeFor` is the one place StrokeRenderer and StrokeOutline both read the
 * pen's minWidthFactor/gamma from (§5e, 1.4.6). Pinning its return to the
 * named constants' actual values, rather than to the literals it replaced,
 * means a tuning change to DEFAULT_PEN or HIGHLIGHTER_PEN shows up here as a
 * visible test change instead of silently drifting apart from either caller.
 */
describe("shapeFor", () => {
	it("returns DEFAULT_PEN's shape for a non-flat (pen) stroke", () => {
		expect(shapeFor(false)).toEqual({
			minWidthFactor: DEFAULT_PEN.minWidthFactor,
			gamma: DEFAULT_PEN.gamma,
		});
	});

	it("returns HIGHLIGHTER_PEN's shape for a flat (highlighter) stroke", () => {
		expect(shapeFor(true)).toEqual({
			minWidthFactor: HIGHLIGHTER_PEN.minWidthFactor,
			gamma: HIGHLIGHTER_PEN.gamma,
		});
	});

	it("pins DEFAULT_PEN's current values", () => {
		expect(DEFAULT_PEN.minWidthFactor).toBe(0.35);
		expect(DEFAULT_PEN.gamma).toBe(0.75);
	});

	it("pins HIGHLIGHTER_PEN's current values", () => {
		expect(HIGHLIGHTER_PEN.minWidthFactor).toBe(0.9);
		expect(HIGHLIGHTER_PEN.gamma).toBe(1);
	});
});

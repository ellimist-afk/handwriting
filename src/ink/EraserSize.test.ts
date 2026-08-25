import { describe, expect, it } from "vitest";

import {
	DEFAULT_ERASER_RADIUS_PX,
	ERASER_SIZE_STEPS,
	clampEraserRadius,
	nextEraserSize,
} from "./EraserSize";

describe("eraser sizes", () => {
	it("keeps the default as the middle step", () => {
		// Whatever the numbers are, the size you get without asking has to be
		// the one the cycle treats as home.
		expect(ERASER_SIZE_STEPS[1]!.radiusPx).toBe(DEFAULT_ERASER_RADIUS_PX);
	});

	it("cycles fine to medium to bold and back", () => {
		expect(nextEraserSize(8).name).toBe("medium");
		expect(nextEraserSize(14).name).toBe("bold");
		expect(nextEraserSize(28).name).toBe("fine");
	});

	it("starts the cycle at medium when the current size is off-step", () => {
		expect(nextEraserSize(9.5).name).toBe("medium");
	});

	it("clamps junk to something usable", () => {
		expect(clampEraserRadius(Number.NaN)).toBe(DEFAULT_ERASER_RADIUS_PX);
		expect(clampEraserRadius(0)).toBe(DEFAULT_ERASER_RADIUS_PX);
		expect(clampEraserRadius(-4)).toBe(DEFAULT_ERASER_RADIUS_PX);
		expect(clampEraserRadius(1000)).toBe(64);
		expect(clampEraserRadius(1)).toBe(3);
	});
});

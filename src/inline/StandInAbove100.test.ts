import { expect, it } from "vitest";
import { STAND_IN_MIN_FACTOR, standInFactorFits } from "./InkOverlayConstants";

// At or above 100 percent a zoom stand-in is the committed layer scaled up. Past four times it is a blur, so the layer is drawn by
// path instead. Below 100 percent there is no ceiling: the 1.4.24 stand-in is unchanged.
it("ceiling: at or above 100 percent a stand-in is copied at four times or less; below 100 percent any factor from one quarter up", () => {
	expect(standInFactorFits(4, true)).toBe(true);
	expect(standInFactorFits(4.01, true)).toBe(false);
	expect(standInFactorFits(1.5, true)).toBe(true);
	expect(standInFactorFits(STAND_IN_MIN_FACTOR, true)).toBe(true);
	expect(standInFactorFits(0.24, true)).toBe(false);
	expect(standInFactorFits(10, false)).toBe(true);
	expect(standInFactorFits(10)).toBe(true);
	expect(standInFactorFits(0.24)).toBe(false);
});

import { expect, it } from "vitest";
import { EXTENT_RASTER_MAX_PX_DESKTOP, EXTENT_RASTER_MAX_PX_MOBILE, extentPairFits, extentRasterFits } from "./InkOverlay";

// The extent raster's budget per platform. The MCB EXAM 3 ink at 10 percent at a ratio of 2 (2,220 x 2,790 device px) fits both;
// at 17 percent (3,792 x 4,765, 18.1 million) it fits the desktop cap and not the mobile one. Just over a cap there is no raster
// and the pan paints by path as before. No side may pass the canvas limit however thin the other.
it("budget: an extent raster holds at most 20 million device px a layer on desktop and 8 million on mobile", () => {
	expect(EXTENT_RASTER_MAX_PX_DESKTOP).toBe(20_000_000);
	expect(EXTENT_RASTER_MAX_PX_MOBILE).toBe(8_000_000);
	for (const mobile of [false, true]) expect(extentRasterFits(2220, 2790, mobile)).toBe(true);
	expect(extentRasterFits(3792, 4765, false)).toBe(true);
	expect(extentRasterFits(3792, 4765, true)).toBe(false);
	expect(extentRasterFits(4000, 5001, false)).toBe(false);
	expect(extentRasterFits(4000, 2001, true)).toBe(false);
	expect(extentRasterFits(16_385, 10, false)).toBe(false);
	expect(extentRasterFits(0, 10, false)).toBe(false);
});

it("budget: while a zoom stand-in is held, it and the build together hold at most 1.6 times the raster cap, 32 million device px on desktop and 12.8 million on mobile", () => {
	expect(typeof extentPairFits, "the pair test exists").toBe("function");
	expect(extentPairFits(20_000_000, 12_000_000, false), "just under on desktop").toBe(true);
	expect(extentPairFits(20_000_000, 12_000_001, false), "just over on desktop").toBe(false);
	expect(extentPairFits(8_000_000, 4_800_000, true), "just under on mobile").toBe(true);
	expect(extentPairFits(8_000_000, 4_800_001, true), "just over on mobile").toBe(false);
	// The old single cap is no longer the pair's: a pair over 20 million fits on desktop.
	expect(extentPairFits(14_000_000, 10_000_000, false), "a 24 million px pair on desktop").toBe(true);
});

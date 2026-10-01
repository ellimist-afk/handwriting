import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { onDeviceGrid } from "./InkOverlay";

/**
 * The settle's top-and-left bound, rounded to the device grid. The scroll commit rounds, so the pan it
 * leaves can sit a fraction past the bound; the correction the bound makes must be a whole number of
 * device px, so the page keeps the grid its ink is rastered on. It is the largest such move not above the
 * exact clamp move, so the page never moves further than the clamp asked and rests under one device px on
 * its own side of the bound.
 */
const wholeDevicePx = (d: number, dpr: number) => Math.abs(d * dpr - Math.round(d * dpr)) < 1e-9;

describe("onDeviceGrid: the settle's bound corrects by whole device px, never more than the clamp", () => {
	for (const dpr of [1, 2, 3]) {
		it(`dpr ${dpr}: a fraction past a ceiling of 0 moves a whole number of device px and rests at or past it, under one device px`, () => {
			for (const raw of [0.6328125, 0.01, 0.34, 0.5, 1, 1.49, 7.25]) {
				const out = onDeviceGrid(raw, Math.min(raw, 0), dpr);
				expect(wholeDevicePx(raw - out, dpr), `raw ${raw} moved ${raw - out}`).toBe(true);
				expect(out, `raw ${raw}: ${out} crossed the bound`).toBeGreaterThanOrEqual(0);
				expect(out, `raw ${raw}: ${out} is a device px or more past the bound`).toBeLessThan(1 / dpr);
			}
		});

		it(`dpr ${dpr}: a page below a floor moves a whole number of device px and rests at or under it, under one device px`, () => {
			for (const [raw, floor] of [[-10, -5.3], [-0.2, -0.1], [-3.75, -1]] as const) {
				const out = onDeviceGrid(raw, floor, dpr);
				expect(wholeDevicePx(out - raw, dpr), `raw ${raw} moved ${out - raw}`).toBe(true);
				expect(out, `raw ${raw}: ${out} crossed ${floor}`).toBeLessThanOrEqual(floor);
				expect(floor - out, `raw ${raw}: ${out} is a device px or more past ${floor}`).toBeLessThan(1 / dpr);
			}
		});

		it(`dpr ${dpr}: a page the bound did not move stays exactly where it was`, () => {
			for (const raw of [0, -0.2422, -18.0234375, -400.5]) expect(onDeviceGrid(raw, raw, dpr)).toBe(raw);
		});
	}

	it("the measured settle: scroll rounded up leaves +0.633 px of pan; at dpr 2 it moves one device px, to 0.133, not 1 px to -0.367", () => {
		expect(onDeviceGrid(0.6328125, 0, 2)).toBeCloseTo(0.1328125, 10);
	});

	it("float noise past the bound is not a correction: the bound's value stands", () => {
		expect(onDeviceGrid(1e-12, 0, 2)).toBe(0);
	});
});

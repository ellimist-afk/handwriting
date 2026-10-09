import { describe, expect, it } from "vitest";
import { snapChipOrigin, SNAP_CHIP_W, SNAP_CHIP_H } from "./SnapChip";

/**
 * snapChipOrigin clamps the chip on both axes
 * to the pane. A mouse stroke that ends within about 56 by 26 px of the pane's bottom-right corner
 * gets a chip clamped on top of the stroke's end, although the module says the chip never covers it.
 *
 * The cells assert the CORRECT behaviour, so they go red only if the finding is real.
 */

const PANE = { width: 800, height: 600 };
const covers = (at: { left: number; top: number }, x: number, y: number): boolean =>
	x >= at.left && x <= at.left + SNAP_CHIP_W && y >= at.top && y <= at.top + SNAP_CHIP_H;

describe("the snap chip never covers the end of the stroke it offers to replace", () => {
	// Mid-pane, the right edge, the bottom edge are controls: the clamp works on one axis there.
	for (const [x, y] of [
		[400, 300],
		[790, 300],
		[400, 590],
	] as const) {
		it(`control: stroke ending at (${x}, ${y})`, () => {
			const at = snapChipOrigin(x, y, PANE);
			expect(covers(at, x, y), `chip at ${JSON.stringify(at)} covers the stroke end`).toBe(false);
		});
	}

	// Near the bottom-right corner both axes clamp.
	for (const [x, y] of [
		[790, 590],
		[780, 585],
	] as const) {
		it(`stroke ending near the bottom-right corner at (${x}, ${y})`, () => {
			const at = snapChipOrigin(x, y, PANE);
			expect(covers(at, x, y), `chip at ${JSON.stringify(at)} covers the stroke end`).toBe(false);
		});
	}

	it("control: the chip stays inside the pane at the corner", () => {
		const at = snapChipOrigin(790, 590, PANE);
		expect(at.left).toBeGreaterThanOrEqual(0);
		expect(at.top).toBeGreaterThanOrEqual(0);
		expect(at.left + SNAP_CHIP_W).toBeLessThanOrEqual(PANE.width);
		expect(at.top + SNAP_CHIP_H).toBeLessThanOrEqual(PANE.height);
	});
});

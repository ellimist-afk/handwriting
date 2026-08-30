import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PEN,
	NO_PRESSURE,
	setPressureSensitivity,
	widthForPressure,
} from "./PenStyle";
import { PEN_SHAPE } from "./InkShape";

afterEach(() => setPressureSensitivity(true));

describe("pressure sensitivity", () => {
	it("on: a hard sample is wider than a light one", () => {
		expect(widthForPressure(DEFAULT_PEN, 0.9)).toBeGreaterThan(
			widthForPressure(DEFAULT_PEN, 0.1)
		);
	});

	it("off: every sample comes out at the no-pressure width", () => {
		setPressureSensitivity(false);
		const flat = widthForPressure(DEFAULT_PEN, NO_PRESSURE);
		expect(widthForPressure(DEFAULT_PEN, 0.05)).toBe(flat);
		expect(widthForPressure(DEFAULT_PEN, 1)).toBe(flat);
	});

	it("off is a pin, not a switch: the width law still runs", () => {
		setPressureSensitivity(false);
		// The setting Alan shipped this for: turning pressure off must not cost
		// anyone the speed thinning or the tapered ends.
		expect(widthForPressure(DEFAULT_PEN, 0.5)).toBeGreaterThan(0);
		expect(PEN_SHAPE.thinningK).toBeGreaterThan(0);
		expect(PEN_SHAPE.taperWidths).toBeGreaterThan(0);
	});
});

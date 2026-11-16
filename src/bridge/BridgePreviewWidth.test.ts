import { afterEach, describe, expect, it } from "vitest";
import { EXP7_PEN, setPressureSensitivity, widthForPressure } from "../ink/PenStyle";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { bridgePreviewWidth, PREVIEW_PRESSURE, PREVIEW_SPEED_FACTOR } from "./BridgePreviewWidth";

describe("bridgePreviewWidth", () => {
	afterEach(() => setPressureSensitivity(true));

	it("uses the width law a new pen stroke is built with", () => {
		const builder = new StrokeBuilder("pen", "#000000", 2.2);
		builder.start(0);
		builder.add(0, 0, 0.5, 0);
		builder.add(9, 9, 0.5, 8);
		expect(builder.finish()?.pressureProfile).toBe(EXP7_PEN.pressureProfile);
		expect(bridgePreviewWidth(2.2)).toBeCloseTo(
			widthForPressure({ ...EXP7_PEN, baseWidth: 2.2 }, PREVIEW_PRESSURE) * PREVIEW_SPEED_FACTOR,
			10
		);
	});

	it("is wider than the nib at an ordinary pressure, as the stored stroke is", () => {
		expect(bridgePreviewWidth(2.2)).toBeGreaterThan(2.2);
	});

	it("scales with the nib", () => {
		expect(bridgePreviewWidth(6.6)).toBeCloseTo(bridgePreviewWidth(2.2) * 3, 10);
	});

	it("follows the pressure switch", () => {
		setPressureSensitivity(false);
		expect(bridgePreviewWidth(2.2)).toBeCloseTo(2.2 * EXP7_PEN.pressureOffWidthFactor * PREVIEW_SPEED_FACTOR, 10);
	});
});

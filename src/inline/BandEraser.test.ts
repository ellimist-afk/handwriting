import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bandEraserIntent } from "./InlinePenRouter";
import { resetTipModeForTest, setSideButtonErases } from "./TipMode";

describe("bandEraserIntent (linked-mentions band claims)", () => {
	beforeEach(resetTipModeForTest);
	afterEach(resetTipModeForTest);
	it("pen eraser end claims: buttons bit", () => {
		expect(bandEraserIntent("pen", 32, 0, false, false)).toBe(true);
	});

	it("pen eraser end claims: button 5 on the transition event", () => {
		expect(bandEraserIntent("pen", 0, 5, false, false)).toBe(true);
	});

	it("pen tip in eraser mode claims", () => {
		expect(bandEraserIntent("pen", 1, 0, true, false)).toBe(true);
	});

	it("pen tip outside eraser mode stays native: backlink rows keep clicking", () => {
		expect(bandEraserIntent("pen", 1, 0, false, false)).toBe(false);
	});

	it("pen side button stays native", () => {
		expect(bandEraserIntent("pen", 2, 0, false, false)).toBe(false);
	});

	it("mouse left-drag claims only with BOTH eraser mode and mouse ink", () => {
		expect(bandEraserIntent("mouse", 1, 0, true, true)).toBe(true);
		expect(bandEraserIntent("mouse", 1, 0, true, false)).toBe(false);
		expect(bandEraserIntent("mouse", 1, 0, false, true)).toBe(false);
	});

	it("mouse right button never claims, even in eraser mode with mouse ink", () => {
		expect(bandEraserIntent("mouse", 2, 2, true, true)).toBe(false);
	});

	it("Android side-button pen contact claims; bare tip, mouse and touch stay unchanged", () => {
		setSideButtonErases(true);
		expect(bandEraserIntent("pen", 3, 0, false, false)).toBe(true);
		expect(bandEraserIntent("pen", 1, 0, false, false)).toBe(false);
		expect(bandEraserIntent("mouse", 2, 2, false, true)).toBe(false);
		expect(bandEraserIntent("mouse", 3, 0, false, true)).toBe(false);
		expect(bandEraserIntent("touch", 3, 0, false, true)).toBe(false);
		setSideButtonErases(false);
		expect(bandEraserIntent("pen", 3, 0, false, false)).toBe(false);
	});

	it("touch never claims", () => {
		expect(bandEraserIntent("touch", 1, 0, true, true)).toBe(false);
	});
});

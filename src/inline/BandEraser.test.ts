import { describe, expect, it } from "vitest";
import { bandEraserIntent } from "./InlinePenRouter";

describe("bandEraserIntent (linked-mentions band claims)", () => {
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

	it("pen barrel stays native", () => {
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

	it("touch never claims", () => {
		expect(bandEraserIntent("touch", 1, 0, true, true)).toBe(false);
	});
});

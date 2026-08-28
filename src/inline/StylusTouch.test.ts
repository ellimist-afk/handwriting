/**
 * The stylus-touch rule: exact on WebKit, inert everywhere else. The cost
 * of a wrong true is a dead finger gesture, so mixed and unknown inputs
 * must all come back false.
 */

import { describe, expect, it } from "vitest";
import { PALM_RADIUS_PX, palmSizedTouches, stylusOnlyTouches } from "./StylusTouch";

describe("stylusOnlyTouches", () => {
	it("matches a lone stylus touch", () => {
		expect(stylusOnlyTouches([{ touchType: "stylus" }])).toBe(true);
	});

	it("matches multiple stylus touches", () => {
		expect(
			stylusOnlyTouches([{ touchType: "stylus" }, { touchType: "stylus" }])
		).toBe(true);
	});

	it("a finger passes", () => {
		expect(stylusOnlyTouches([{ touchType: "direct" }])).toBe(false);
	});

	it("a finger alongside the stylus protects the whole event", () => {
		expect(
			stylusOnlyTouches([{ touchType: "stylus" }, { touchType: "direct" }])
		).toBe(false);
	});

	it("chromium-shaped touches (no touchType at all) pass", () => {
		expect(stylusOnlyTouches([{}])).toBe(false);
	});

	it("an empty list is nothing to eat", () => {
		expect(stylusOnlyTouches([])).toBe(false);
	});
});

describe("palmSizedTouches (palm lands before the pen, iPad)", () => {
	const palm = { radiusX: 60, radiusY: 55 };
	const finger = { radiusX: 14, radiusY: 16 };

	it("matches a hand-sized contact", () => {
		expect(palmSizedTouches([palm])).toBe(true);
	});

	it("lets a fingertip through, so taps still place the caret", () => {
		expect(palmSizedTouches([finger])).toBe(false);
	});

	it("lets a mixed batch through rather than eating the finger in it", () => {
		expect(palmSizedTouches([palm, finger])).toBe(false);
	});

	it("is inert where touches carry no radius at all", () => {
		// Every non-WebKit engine, and the Surface.
		expect(palmSizedTouches([{}])).toBe(false);
		expect(palmSizedTouches([{ radiusX: 60 }])).toBe(false);
		expect(palmSizedTouches([{ radiusX: Number.NaN, radiusY: Number.NaN }])).toBe(false);
	});

	it("matches on the larger axis, since a palm lands oblong", () => {
		expect(palmSizedTouches([{ radiusX: 12, radiusY: PALM_RADIUS_PX }])).toBe(true);
	});

	it("an empty batch is not a palm", () => {
		expect(palmSizedTouches([])).toBe(false);
	});
});

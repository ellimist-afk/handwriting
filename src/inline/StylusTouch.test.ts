/**
 * The stylus-touch rule: exact on WebKit, inert everywhere else. The cost
 * of a wrong true is a dead finger gesture, so mixed and unknown inputs
 * must all come back false.
 */

import { describe, expect, it } from "vitest";
import { stylusOnlyTouches } from "./StylusTouch";

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

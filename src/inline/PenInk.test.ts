import { afterEach, describe, expect, it } from "vitest";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "./PenInk";

afterEach(() => {
	resetPenInkForTest();
});

describe("pen ink switch", () => {
	it("defaults ON, so a fresh launch inks", () => {
		expect(penInkEnabled()).toBe(true);
	});
	it("flips both ways", () => {
		setPenInk(false);
		expect(penInkEnabled()).toBe(false);
		setPenInk(true);
		expect(penInkEnabled()).toBe(true);
	});
	it("setting what it already is changes nothing", () => {
		setPenInk(true);
		expect(penInkEnabled()).toBe(true);
		setPenInk(false);
		setPenInk(false);
		expect(penInkEnabled()).toBe(false);
	});
	// The session-only decision, as an assertion rather than a comment: this
	// module holds the whole of the state, so if a persistence path is ever
	// added it has to be added HERE, and this test is what a reader lands on.
	it("holds no writer but setPenInk - nothing here can reach data.json", async () => {
		const mod = await import("./PenInk");
		expect(Object.keys(mod).sort()).toEqual([
			"penInkEnabled",
			"resetPenInkForTest",
			"setPenInk",
		]);
	});
});

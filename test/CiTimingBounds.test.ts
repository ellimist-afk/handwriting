import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CI_TIMING_FACTOR, onCi, timingBound } from "./ciBounds";

/**
 * The scroll-cost render cells assert millisecond bounds written for Alan's Windows machine (2 ms a repaint, 5 ms a band
 * move in ScrollCost, 3 ms a carried band move in ScrollCostInk). GitHub's Linux runner reads the same repaints at 3 to
 * 10 ms, so on a runner that sets CI the bound is widened by a fixed factor and everywhere else it is the number written
 * in the cell. These cells pin both halves: the local number is unchanged, the CI branch is the only difference, and the
 * two render files take their bounds from the helper instead of a literal.
 */
describe("timingBound: the local bound is the written number, CI widens it and nothing else", () => {
	it("with CI unset, empty, 0 or false, every bound is exactly the number written", () => {
		for (const env of [{}, { CI: undefined }, { CI: "" }, { CI: "0" }, { CI: "false" }, { CI: "FALSE" }]) {
			expect(onCi(env), `env ${JSON.stringify(env)}`).toBe(false);
			expect([2, 3, 5].map(ms => timingBound(ms, env)), `env ${JSON.stringify(env)}`).toEqual([2, 3, 5]);
		}
	});

	it("with CI set (GitHub sets CI=true), every bound is the written number times the factor, and the factor is a widening", () => {
		expect(CI_TIMING_FACTOR).toBeGreaterThan(1);
		for (const env of [{ CI: "true" }, { CI: "1" }]) {
			expect(onCi(env), `env ${JSON.stringify(env)}`).toBe(true);
			expect([2, 3, 5].map(ms => timingBound(ms, env)), `env ${JSON.stringify(env)}`).toEqual([2, 3, 5].map(ms => ms * CI_TIMING_FACTOR));
		}
	});

	it("the CI branch is the only difference: the same call with and without CI differs by the factor and by nothing else", () => {
		for (const ms of [0.5, 1, 2, 3, 5, 12]) {
			expect(timingBound(ms, { CI: "true" }) / timingBound(ms, {})).toBeCloseTo(CI_TIMING_FACTOR, 10);
			expect(timingBound(ms, { CI: "true", PATH: "x", HOME: "y" }), "other variables change nothing").toBe(timingBound(ms, { CI: "true" }));
			expect(timingBound(ms, { PATH: "x", HOME: "y" }), "other variables change nothing").toBe(ms);
		}
	});
});

describe("the scroll-cost render cells take their millisecond bounds from the helper", () => {
	const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
	const scrollCost = read("./render/ScrollCost.test.ts");
	const scrollCostInk = read("./render/ScrollCostInk.test.ts");

	// The render files hold their page source in a template string; an import there is page code, not the test's.
	const importedAtTop = (src: string) => { const i = src.indexOf('import { timingBound } from "../ciBounds";'); return i >= 0 && i < src.indexOf("const PAGE = `"); };

	it("ScrollCost: 2 ms a repaint and 5 ms a band move both go through timingBound, no literal bound is left", () => {
		expect(importedAtTop(scrollCost), "timingBound is imported by the test module, above the page source").toBe(true);
		expect(scrollCost).toContain("x.ms > (bandMove(x) ? timingBound(5) : timingBound(2))");
		expect(scrollCost).not.toMatch(/x\.ms > \(bandMove\(x\) \? 5 : 2\)/);
	});

	it("ScrollCostInk: the 3 ms carried-move bound goes through timingBound, no literal bound is left", () => {
		expect(importedAtTop(scrollCostInk), "timingBound is imported by the test module, above the page source").toBe(true);
		expect(scrollCostInk).toContain("x.paintMs >= timingBound(3)");
		expect(scrollCostInk).not.toMatch(/x\.paintMs >= 3\b/);
	});
});

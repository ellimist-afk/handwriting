import { describe, expect, it } from "vitest";
import { StrokeMetrics, type LoafSource } from "./StrokeMetrics";

/**
 * recordPresent says a present that arrives
 * one frame after pen-up is accepted "so the last draw's presentation is counted", but end() has
 * already copied the counter into the report it handed out, and the next begin() resets the counter,
 * so that present is counted nowhere. Diagnostics only.
 *
 * The cells assert the CORRECT behaviour, so they go red only if the finding is real.
 */

const noLoaf: LoafSource = {
	supported: () => false,
	start() {},
	framesBetween: () => [],
	watch() {},
};

describe("a presentation that lands one frame after pen-up", () => {
	it("control: presents during the stroke are in its report", () => {
		const m = new StrokeMetrics(noLoaf);
		m.begin("inline", 0);
		m.recordPresent(10);
		m.recordPresent(20);
		expect(m.end(100).ageAtPresentMs.n).toBe(2);
	});

	it("is counted in the report of the stroke it belongs to", () => {
		const m = new StrokeMetrics(noLoaf);
		m.begin("inline", 0);
		m.recordPresent(10);
		const first = m.end(100);
		m.recordPresent(40); // the last draw of stroke 1 presents after end()
		expect(first.ageAtPresentMs.n, "stroke 1's report never sees its last present").toBe(2);
	});

	it("is not given to the next stroke's report, and the next stroke's presents do not reach the first report", () => {
		const m = new StrokeMetrics(noLoaf);
		m.begin("inline", 0);
		m.recordPresent(10);
		const first = m.end(100);
		m.recordPresent(40);
		m.begin("inline", 200);
		m.recordPresent(15);
		expect(m.end(300).ageAtPresentMs.n, "stroke 2 holds only its own present").toBe(1);
		expect(first.ageAtPresentMs.n, "stroke 1 keeps its two presents").toBe(2);
	});
});

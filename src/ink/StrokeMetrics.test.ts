import { describe, expect, it } from "vitest";
import { StrokeMetrics } from "./StrokeMetrics";

/**
 * The frame instrument reported `frame 0/0ms` for every stroke drawn in a
 * note, because its only caller was the canvas page view's ticker. Zero is
 * what a PERFECT frame record would look like, so a dead instrument and a
 * clean result were indistinguishable - and a flicker hunt spent its best
 * number on it (alan, hardware, 2026-08-30).
 *
 * These tests pin the distinction itself: unmeasured must never print as a
 * number, and a real measurement must still print as one.
 */
describe("StrokeMetrics frame reporting", () => {
	it("says nothing measured the frames, rather than printing zero", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		const summary = m.end(100);

		expect(summary.frameIntervalMs.n).toBe(0);
		const text = StrokeMetrics.summaryText(summary);
		expect(text).toContain("frame (not recorded)");
		// The exact string the old report produced for a dead instrument.
		expect(text).not.toContain("frame 0/0ms");
	});

	it("prints real numbers once frames are recorded", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		// Three ticks, two intervals: 16ms and 34ms.
		m.recordFrame(100);
		m.recordFrame(116);
		m.recordFrame(150);
		const summary = m.end(200);

		expect(summary.frameIntervalMs.n).toBe(2);
		expect(summary.frameIntervalMs.max).toBe(34);
		const text = StrokeMetrics.summaryText(summary);
		expect(text).toContain("frame 25/34ms");
		expect(text).not.toContain("not recorded");
	});

	it("ignores frames recorded outside a stroke", () => {
		const m = new StrokeMetrics();
		m.recordFrame(50);
		m.begin("ink", 0);
		m.recordFrame(100);
		const summary = m.end(200);
		// The pre-stroke tick must not seed an interval against pen-down.
		expect(summary.frameIntervalMs.n).toBe(0);
	});
});

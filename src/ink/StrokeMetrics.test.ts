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
		// This test never calls recordEvent, so the rate line legitimately
		// reads "(not recorded)" now too - the frame line specifically is
		// what this test pins.
		expect(text.split("\n")[4]).not.toContain("not recorded");
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

/**
 * moveHz and rawHz broke the same convention on the file's own first output
 * line: bare numbers with no sample count, so an uncounted rate (the PDF
 * surface's `onPenMove: () => {}`, fixed in `beb6fbb`, printed this for the
 * life of the surface) and a genuine zero rate print the identical `0Hz`.
 */
describe("StrokeMetrics rate reporting", () => {
	it("says the rate was not recorded, rather than printing 0Hz, when nothing counted it", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		const summary = m.end(100);

		// Assert the precondition: this summary genuinely carries zero events.
		expect(summary.moveEvents).toBe(0);
		expect(summary.rawEvents).toBe(0);

		const text = StrokeMetrics.summaryText(summary);
		expect(text).toContain("move (not recorded) raw (not recorded)");
		expect(text).not.toContain("0Hz");
	});

	it("still prints the real rate once events are counted", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		m.recordEvent("move", 1, 0, false);
		m.recordEvent("move", 1, 0, false);
		m.recordEvent("raw", 1, 0, false);
		const summary = m.end(100);

		expect(summary.moveEvents).toBe(2);
		expect(summary.rawEvents).toBe(1);

		const text = StrokeMetrics.summaryText(summary);
		expect(text).toContain("move 20Hz raw 10Hz");
		// Frames were never recorded in this test either, so "not recorded"
		// legitimately appears on that line - the rate line specifically
		// must carry the real numbers, not a fallback.
		expect(text.split("\n")[0]).not.toContain("not recorded");
	});
});

describe("tail backing resize evidence", () => {
	it("freezes each stroke's delta across later strokes and paste work", () => {
		const m = new StrokeMetrics() as StrokeMetrics & {
			begin(mode: string, now: number, resizeTotal: number): void;
			end(now: number, resizeTotal: number): ReturnType<StrokeMetrics["end"]> & { tailBackingResizes: number | null };
		};
		m.begin("ink", 0, 10);
		const first = m.end(100, 12);
		expect(first.tailBackingResizes).toBe(2);
		expect(StrokeMetrics.summaryText(first)).toContain("tail backing resizes 2");
		m.begin("ink", 200, 12);
		const second = m.end(300, 12);
		expect(second.tailBackingResizes).toBe(0);
		// Paste changes the renderer total between strokes, without a live stroke.
		m.begin("ink", 400, 15);
		const third = m.end(500, 16);
		expect(third.tailBackingResizes).toBe(1);
		expect(m.summaries.map(s => (s as typeof first).tailBackingResizes)).toEqual([2, 0, 1]);
		expect(first.tailBackingResizes).toBe(2);
	});

	it("marks missing totals not recorded and never inherits another surface's baseline", () => {
		const shared = new StrokeMetrics() as StrokeMetrics & {
			begin(mode: string, now: number, resizeTotal?: number): void;
			end(now: number, resizeTotal?: number): ReturnType<StrokeMetrics["end"]> & { tailBackingResizes: number | null };
		};
		shared.begin("ink", 0, 90);
		shared.end(100, 91);
		shared.begin("ink", 200);
		const unmeasured = shared.end(300);
		expect(unmeasured.tailBackingResizes).toBeNull();
		expect(StrokeMetrics.summaryText(unmeasured)).toContain("tail backing resizes (not recorded)");
		shared.begin("ink", 400, 2);
		const otherSurface = shared.end(500, 4);
		expect(otherSurface.tailBackingResizes).toBe(2);
		shared.begin("ink", 600);
		const missingStart = shared.end(700, 9);
		expect(missingStart.tailBackingResizes).toBeNull();
		expect(StrokeMetrics.summaryText(missingStart)).toContain("tail backing resizes (not recorded)");
		shared.begin("ink", 800, 3);
		const missingEnd = shared.end(900);
		expect(missingEnd.tailBackingResizes).toBeNull();
		expect(StrokeMetrics.summaryText(missingEnd)).toContain("tail backing resizes (not recorded)");
		expect(shared.summaries.map(s => (s as typeof unmeasured).tailBackingResizes)).toEqual([1, null, 2, null, null]);
	});
});

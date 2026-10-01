/**
 * The arithmetic of a ctrl+wheel zoom run. Ratios against the run's
 * start, the units the browser may report deltas in, and the quiet time that
 * stands in for a lift no touchpad pinch ever sends.
 */
import { describe, it, expect } from "vitest";
import {
	WheelZoomRun,
	wheelDeltaPx,
	wheelRatio,
	WHEEL_ZOOM_K,
	WHEEL_ZOOM_LINE_PX,
	WHEEL_ZOOM_PAGE_PX,
	WHEEL_ZOOM_QUIET_MS,
	TOUCHPAD_ZOOM_K,
	wheelRunKind,
} from "./WheelZoom";

const at = (t: number, deltaY: number, deltaMode = 0, x = 400, y = 300) => ({ deltaY, deltaMode, x, y, t });

describe("wheelDeltaPx", () => {
	it("passes pixels through, scales lines and pages", () => {
		expect(wheelDeltaPx(-120, 0)).toBe(-120);
		expect(wheelDeltaPx(-3, 1)).toBe(-3 * WHEEL_ZOOM_LINE_PX);
		expect(wheelDeltaPx(2, 2)).toBe(2 * WHEEL_ZOOM_PAGE_PX);
	});

	it("refuses a delta that is not a number rather than poisoning the run", () => {
		expect(wheelDeltaPx(Number.NaN, 0)).toBe(0);
		expect(wheelDeltaPx(Number.POSITIVE_INFINITY, 0)).toBe(0);
	});
});

describe("wheelRatio", () => {
	it("zooms in on wheel up and out on wheel down, symmetrically", () => {
		expect(wheelRatio(-100)).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_K), 12);
		expect(wheelRatio(100)).toBeCloseTo(1 / wheelRatio(-100), 12);
		expect(wheelRatio(0)).toBe(1);
	});

	it("never returns a ratio that would put a scale at zero or NaN", () => {
		expect(wheelRatio(Number.NaN)).toBe(1);
		// exp() of a large positive exponent overflows to Infinity; exp() of a large negative underflows to 0.
		expect(wheelRatio(-1e9)).toBe(1);
		expect(wheelRatio(1e9)).toBe(1);
	});
});

describe("WheelZoomRun", () => {
	it("opens with a start at ratio 1, then moves - the shape two fingers landing make", () => {
		const run = new WheelZoomRun();
		const steps = run.feed(at(0, -50));
		expect(steps.map(s => s.phase)).toEqual(["start", "move"]);
		expect(steps[0]!.ratio).toBe(1);
		expect(steps[1]!.ratio).toBeCloseTo(wheelRatio(-50), 12);
		expect(run.isLive).toBe(true);
	});

	it("accumulates travel across events, so the ratio is against the run's start and not the last event", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -50));
		const second = run.feed(at(16, -50));
		expect(second.map(s => s.phase)).toEqual(["move"]);
		expect(second[0]!.ratio).toBeCloseTo(wheelRatio(-100), 12);
		expect(run.ratio).toBeCloseTo(wheelRatio(-100), 12);
	});

	it("reverses within one run: wheeling back down returns the ratio it came from", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -80));
		const back = run.feed(at(16, 80));
		expect(back[0]!.ratio).toBeCloseTo(1, 12);
	});

	it("holds the anchor at the run's first cursor even when the pointer moves under it", () => {
		const run = new WheelZoomRun();
		const first = run.feed(at(0, -40, 0, 500, 250));
		const later = run.feed(at(16, -40, 0, 700, 600));
		expect(first[0]!.centroid).toEqual({ x: 500, y: 250 });
		expect(later[0]!.centroid).toEqual({ x: 500, y: 250 });
	});

	it("takes deltaMode 1 as lines, so one notch of a line-reporting mouse is 16 px of travel", () => {
		const lines = new WheelZoomRun();
		const pixels = new WheelZoomRun();
		// Four lines, not three, so BOTH arms open as mouse-wheel runs and the comparison is
		// still about the unit conversion alone. Three lines is 48 px, under the notch, and a run that
		// opened on 48 pixel px is a touchpad run at the other gain.
		const a = lines.feed(at(0, -4, 1));
		const b = pixels.feed(at(0, -4 * WHEEL_ZOOM_LINE_PX, 0));
		expect(a[1]!.ratio).toBeCloseTo(b[1]!.ratio, 12);
	});

	it("does not end inside the quiet window, ends once past it, and cannot end twice", () => {
		const run = new WheelZoomRun();
		run.feed(at(1000, -60));
		expect(run.endIfQuiet(1000 + WHEEL_ZOOM_QUIET_MS - 1)).toBeNull();
		const end = run.endIfQuiet(1000 + WHEEL_ZOOM_QUIET_MS);
		expect(end).not.toBeNull();
		expect(end!.phase).toBe("end");
		expect(end!.ratio).toBe(1);
		expect(end!.centroid).toEqual({ x: 400, y: 300 });
		expect(run.isLive).toBe(false);
		expect(run.endIfQuiet(1e9)).toBeNull();
	});

	it("each event pushes the quiet window out, so a slow run is one run and not many", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -20));
		run.feed(at(120, -20));
		// 120 ms after the first event, but only 0 ms after the second.
		expect(run.endIfQuiet(160)).toBeNull();
		expect(run.endIfQuiet(120 + WHEEL_ZOOM_QUIET_MS)).not.toBeNull();
	});

	it("a run after an end starts fresh: new anchor, ratio back to 1", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -100, 0, 100, 100));
		run.endIfQuiet(WHEEL_ZOOM_QUIET_MS);
		const next = run.feed(at(1000, -10, 0, 800, 800));
		expect(next.map(s => s.phase)).toEqual(["start", "move"]);
		expect(next[0]!.centroid).toEqual({ x: 800, y: 800 });
		// 10 px with deltaMode 0 opens a TOUCHPAD run, so the gain is the touchpad one.
		expect(next[1]!.ratio).toBeCloseTo(Math.exp(10 * TOUCHPAD_ZOOM_K), 12);
	});

	it("cancel drops the run without an end step", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -60));
		run.cancel();
		expect(run.isLive).toBe(false);
		expect(run.endIfQuiet(1e9)).toBeNull();
	});
});

/**
 * A touchpad pinch zooms 1.5 times as far as the same travel on a mouse wheel. The kind is
 * decided at the run's first event and held for the run, so one gesture never changes gain halfway.
 */
describe("the run's kind, decided once at its first event", () => {
	it("a touchpad run of 100 px lands at the touchpad gain", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -25));
		run.feed(at(16, -25));
		run.feed(at(32, -25));
		const last = run.feed(at(48, -25));
		expect(TOUCHPAD_ZOOM_K).toBe(0.003);
		expect(last[0]!.ratio).toBeCloseTo(Math.exp(100 * TOUCHPAD_ZOOM_K), 12);
		expect(run.ratio).toBeCloseTo(Math.exp(100 * TOUCHPAD_ZOOM_K), 12);
	});

	it("a mouse-wheel run of 100 px lands where it always did", () => {
		const run = new WheelZoomRun();
		const first = run.feed(at(0, -100));
		expect(first[1]!.ratio).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_K), 12);
		expect(run.ratio).toBeCloseTo(Math.exp(100 * WHEEL_ZOOM_K), 12);
	});

	it("STICKY: a run that opened on 3 px stays a touchpad run when one later delta is 120 px", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -3));
		const big = run.feed(at(16, -120));
		expect(big[0]!.ratio).toBeCloseTo(Math.exp(123 * TOUCHPAD_ZOOM_K), 12);
	});

	it("deltaMode 1 and deltaMode 2 are mouse-wheel runs whatever their number reads", () => {
		const lines = new WheelZoomRun();
		const lineStep = lines.feed(at(0, -2, 1));
		expect(lineStep[1]!.ratio).toBeCloseTo(Math.exp(2 * WHEEL_ZOOM_LINE_PX * WHEEL_ZOOM_K), 12);
		const pages = new WheelZoomRun();
		const pageStep = pages.feed(at(0, -1, 2));
		expect(pageStep[1]!.ratio).toBeCloseTo(Math.exp(WHEEL_ZOOM_PAGE_PX * WHEEL_ZOOM_K), 12);
	});

	it("THE LINE: a first delta of 49 px is a touchpad, 50 px is a wheel", () => {
		const under = new WheelZoomRun();
		expect(under.feed(at(0, -49))[1]!.ratio).toBeCloseTo(Math.exp(49 * TOUCHPAD_ZOOM_K), 12);
		const on = new WheelZoomRun();
		expect(on.feed(at(0, -50))[1]!.ratio).toBeCloseTo(Math.exp(50 * WHEEL_ZOOM_K), 12);
		expect(wheelRunKind(-49, 0)).toBe("touchpad");
		expect(wheelRunKind(-50, 0)).toBe("wheel");
		expect(wheelRunKind(-3, 1)).toBe("wheel");
	});

	it("the next run decides again: a wheel run then a touchpad run", () => {
		const run = new WheelZoomRun();
		run.feed(at(0, -100));
		run.endIfQuiet(WHEEL_ZOOM_QUIET_MS);
		const next = run.feed(at(1000, -10));
		expect(next[1]!.ratio).toBeCloseTo(Math.exp(10 * TOUCHPAD_ZOOM_K), 12);
	});
});

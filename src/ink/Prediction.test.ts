import { describe, expect, it } from "vitest";
import { PenSample } from "../input/PointerRouter";
import {
	DEFAULT_CAPS,
	EINK_CAPS,
	adaptiveCaps,
	buildTail,
	correctionError,
	extrapolate,
	recentSpeed,
	recentTurnDegrees,
	turnDegrees,
} from "./Prediction";

function s(x: number, y: number, t: number): PenSample {
	return { x, y, pressure: 0.4, timestamp: t, tiltX: 0, tiltY: 0 };
}

/** Straight run to the right at 0.5 px/ms, 4ms apart. */
function straight(n = 6): PenSample[] {
	return Array.from({ length: n }, (_, i) => s(i * 2, 0, i * 4));
}

describe("turnDegrees", () => {
	it("is 0 for a straight path", () => {
		expect(turnDegrees(s(0, 0, 0), s(1, 0, 1), s(2, 0, 2))).toBeCloseTo(0);
	});

	it("is 90 for a right-angle corner", () => {
		expect(turnDegrees(s(0, 0, 0), s(1, 0, 1), s(1, 1, 2))).toBeCloseTo(90);
	});

	it("is 0 for degenerate (repeated) points", () => {
		expect(turnDegrees(s(0, 0, 0), s(0, 0, 1), s(1, 1, 2))).toBe(0);
	});
});

describe("recentSpeed", () => {
	it("measures px/ms across the recent window", () => {
		expect(recentSpeed(straight())).toBeCloseTo(0.5, 5);
	});

	it("is 0 for a parked pen", () => {
		expect(recentSpeed([s(5, 5, 0), s(5, 5, 4), s(5, 5, 8)])).toBe(0);
	});
});

describe("extrapolate", () => {
	it("continues a constant-velocity path", () => {
		const out = extrapolate(straight(), 16);
		expect(out.length).toBeGreaterThan(0);
		const tip = out[out.length - 1]!;
		expect(tip.timestamp).toBeLessThanOrEqual(straight().at(-1)!.timestamp + 16);
		// 0.5 px/ms for 16ms from x=10 → x≈18
		expect(tip.x).toBeCloseTo(18, 1);
		expect(tip.y).toBeCloseTo(0, 5);
	});

	it("never carries pressure of its own", () => {
		const real = straight();
		const out = extrapolate(real, 16);
		for (const p of out) expect(p.pressure).toBe(real.at(-1)!.pressure);
	});

	it("returns nothing without enough history", () => {
		expect(extrapolate([s(0, 0, 0)], 16)).toEqual([]);
	});
});

describe("buildTail caps", () => {
	it("produces a tail on a straight fast stroke", () => {
		const r = buildTail(straight(), [], "extrap");
		expect(r.suppressed).toBe(false);
		expect(r.points.length).toBeGreaterThan(0);
		expect(r.source).toBe("extrap");
	});

	it("never exceeds the horizon cap", () => {
		const r = buildTail(straight(), [], "extrap");
		expect(r.horizonMs).toBeLessThanOrEqual(DEFAULT_CAPS.maxHorizonMs + 1e-6);
	});

	it("never exceeds the distance cap, even at absurd speed", () => {
		// 20 px/ms — far beyond any human hand.
		const fast = Array.from({ length: 6 }, (_, i) => s(i * 80, 0, i * 4));
		const r = buildTail(fast, [], "extrap");
		expect(r.tipDistPx).toBeLessThanOrEqual(DEFAULT_CAPS.maxDistPx + 1e-6);
	});

	it("suppresses prediction at a sharp corner", () => {
		const corner = [s(0, 0, 0), s(4, 0, 4), s(8, 0, 8), s(8, 4, 12)];
		const r = buildTail(corner, [], "extrap");
		expect(r.turnDeg).toBeGreaterThan(DEFAULT_CAPS.maxTurnDeg);
		expect(r.suppressed).toBe(true);
		expect(r.points).toEqual([]);
	});

	it("shortens the tail as the path bends (graded, not binary)", () => {
		const gentle = [s(0, 0, 0), s(4, 0, 4), s(8, 0, 8), s(12, 1.2, 12)];
		const bent = buildTail(gentle, [], "extrap");
		const flat = buildTail(straight(), [], "extrap");
		expect(bent.guard).toBeLessThan(1);
		expect(bent.guard).toBeGreaterThan(0);
		expect(bent.horizonMs).toBeLessThan(flat.horizonMs);
	});

	it("suppresses prediction for a parked pen", () => {
		const parked = [s(5, 5, 0), s(5, 5, 4), s(5, 5, 8)];
		expect(buildTail(parked, [], "extrap").points).toEqual([]);
	});

	it("truncates chromium predictions beyond the horizon", () => {
		const real = straight();
		const last = real.at(-1)!;
		// Relative to the cap, not to whatever the cap happened to be when this
		// was written. The horizon is retuned whenever the latency it
		// compensates for changes, and a fixture in absolute milliseconds turns
		// that into a failing test instead of a passing one.
		const h = DEFAULT_CAPS.maxHorizonMs;
		const predicted = [
			s(last.x + 1, 0, last.timestamp + h / 3),
			s(last.x + 2, 0, last.timestamp + (h * 2) / 3),
			s(last.x + 3, 0, last.timestamp + h * 10), // way out - must be dropped
		];
		const r = buildTail(real, predicted, "chromium");
		expect(r.points.length).toBe(2);
		expect(r.horizonMs).toBeLessThanOrEqual(DEFAULT_CAPS.maxHorizonMs);
	});

	it("ignores chromium predictions that are not in the future", () => {
		const real = straight();
		const last = real.at(-1)!;
		const r = buildTail(real, [s(0, 0, last.timestamp - 4)], "chromium");
		expect(r.points).toEqual([]);
	});
});

describe("correctionError", () => {
	it("measures the miss at the matching timestamp", () => {
		const tail = [s(10, 0, 100), s(12, 0, 104)];
		expect(correctionError(tail, s(12, 3, 104))).toBeCloseTo(3);
	});

	it("is undefined when the tail does not span the sample", () => {
		expect(correctionError([s(10, 0, 100)], s(10, 0, 400))).toBeUndefined();
		expect(correctionError([], s(0, 0, 0))).toBeUndefined();
	});
});

describe("recentTurnDegrees (the turn guard's input)", () => {
	/**
	 * A straight stroke at pen rates: samples half a pixel apart, with a third
	 * of a pixel of digitizer noise across the line. The hand is going
	 * straight; consecutive samples are not.
	 */
	function jitteryStraight(): PenSample[] {
		const wobble = [0, 0.3, -0.3, 0.2, -0.25, 0.3, -0.2, 0.25, -0.3, 0.2, -0.25, 0.3];
		return wobble.map((dy, i) => s(i * 0.5, dy, i * 4));
	}

	it("reads a jittery straight line as straight", () => {
		const real = jitteryStraight();
		// The old measurement - the last three samples - is dominated by the
		// noise, which is what made the guard flap and the tail strobe.
		const naive = turnDegrees(real.at(-3)!, real.at(-2)!, real.at(-1)!);
		expect(naive).toBeGreaterThan(DEFAULT_CAPS.maxTurnDeg);
		expect(recentTurnDegrees(real)).toBeLessThan(DEFAULT_CAPS.maxTurnDeg);
	});

	it("still sees a real corner", () => {
		// right, then down - the corner sits inside the window
		const real = [
			s(0, 0, 0),
			s(2, 0, 4),
			s(4, 0, 8),
			s(6, 0, 12),
			s(6, 2, 16),
			s(6, 4, 20),
			s(6, 6, 24),
			s(6, 8, 28),
			s(6, 10, 32),
		];
		expect(recentTurnDegrees(real)).toBeGreaterThan(DEFAULT_CAPS.maxTurnDeg);
	});

	it("is 0 with too little history to measure", () => {
		expect(recentTurnDegrees([s(0, 0, 0), s(1, 0, 4)])).toBe(0);
	});
});

describe("adaptiveCaps", () => {
	it("keeps the shipped default while there is no measurement", () => {
		expect(adaptiveCaps(undefined)).toEqual(DEFAULT_CAPS);
		expect(adaptiveCaps(Number.NaN)).toEqual(DEFAULT_CAPS);
	});

	it("reproduces the desktop tuning on the machine it was tuned on", () => {
		// age@present measured ~7ms on the surface DEFAULT_CAPS came from.
		// The formula has to land exactly on the hand-tuned answer there, or
		// it is not a generalization of it.
		const caps = adaptiveCaps(7);
		expect(caps.maxHorizonMs).toBe(DEFAULT_CAPS.maxHorizonMs);
		expect(caps.maxDistPx).toBe(DEFAULT_CAPS.maxDistPx);
	});

	it("never reaches shorter than the shipped default", () => {
		// A machine faster than the one this was tuned on gets the floor,
		// not a horizon so short that prediction stops doing anything.
		expect(adaptiveCaps(0).maxHorizonMs).toBe(DEFAULT_CAPS.maxHorizonMs);
		expect(adaptiveCaps(1).maxHorizonMs).toBe(DEFAULT_CAPS.maxHorizonMs);
	});

	it("reaches its own desktop ceiling on a slow path - never EINK_CAPS's", () => {
		// adaptiveCaps is the non-e-ink path exclusively: every caller gates
		// predictionEinkOn() first and uses EINK_CAPS directly when it's on
		// (InkOverlay.ts:2191, PdfInkController.ts:1594,
		// HandwritingPageView.ts:958), so this function must never reach the
		// e-ink numbers, on any lag, however long.
		const DESKTOP_CEILING_MS = 20;
		const caps = adaptiveCaps(58);
		expect(caps.maxHorizonMs).toBe(DESKTOP_CEILING_MS);
		expect(caps.maxHorizonMs).toBeLessThan(EINK_CAPS.maxHorizonMs);
		expect(caps.maxDistPx).toBe(DEFAULT_CAPS.maxDistPx);
		expect(adaptiveCaps(500).maxHorizonMs).toBe(DESKTOP_CEILING_MS);
		expect(adaptiveCaps(500).maxDistPx).toBe(DEFAULT_CAPS.maxDistPx);
	});

	it("EINK_CAPS itself is untouched by the desktop ceiling change", () => {
		expect(EINK_CAPS.maxHorizonMs).toBe(48);
		expect(EINK_CAPS.maxDistPx).toBe(24);
	});

	it("the dist clamp collapses to DEFAULT_CAPS.maxDistPx at every reachable horizon", () => {
		for (const lag of [0, 7, 12, 15, 20, 30, 58, 500]) {
			expect(adaptiveCaps(lag).maxDistPx).toBe(DEFAULT_CAPS.maxDistPx);
		}
	});

	it("lengthens the reach in between, monotonically", () => {
		// lag 10 -> horizon 15ms sits strictly between the 12ms floor and the
		// new 20ms desktop ceiling.
		const mid = adaptiveCaps(10);
		expect(mid.maxHorizonMs).toBeGreaterThan(DEFAULT_CAPS.maxHorizonMs);
		expect(mid.maxHorizonMs).toBeLessThan(20);
		let prev = 0;
		for (const lag of [0, 5, 10, 20, 30, 40, 50, 60]) {
			const h = adaptiveCaps(lag).maxHorizonMs;
			expect(h).toBeGreaterThanOrEqual(prev);
			prev = h;
		}
	});

	it("never loosens the guards that stop a wrong guess being drawn", () => {
		for (const lag of [0, 7, 20, 45, 200]) {
			const caps = adaptiveCaps(lag);
			expect(caps.maxTurnDeg).toBe(DEFAULT_CAPS.maxTurnDeg);
			expect(caps.minSpeedPxPerMs).toBe(DEFAULT_CAPS.minSpeedPxPerMs);
		}
	});
});

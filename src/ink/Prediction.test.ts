import { describe, expect, it } from "vitest";
import { PenSample } from "../input/PointerRouter";
import {
	DEFAULT_CAPS,
	buildTail,
	correctionError,
	extrapolate,
	recentSpeed,
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
		const predicted = [
			s(last.x + 1, 0, last.timestamp + 8),
			s(last.x + 2, 0, last.timestamp + 16),
			s(last.x + 3, 0, last.timestamp + 200), // way out — must be dropped
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

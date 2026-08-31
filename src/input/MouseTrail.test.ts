/**
 * The mouse filter, judged on the two things that justify its existence: the
 * integer staircase comes out, and nothing a hand meant goes with it.
 */

import { describe, expect, it } from "vitest";
import { PenSample } from "./PointerRouter";
import { MouseTrail } from "./MouseTrail";

function sample(x: number, y: number, t = 0): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 1, tiltY: 2 };
}

/** A diagonal as a mouse reports it: whole pixels, alternating jogs. */
function staircase(n: number): PenSample[] {
	const out: PenSample[] = [];
	for (let i = 0; i < n; i++) {
		// The true line is y = x/2; the grid forces y to whole numbers.
		out.push(sample(i, Math.round(i / 2), i * 8));
	}
	return out;
}

/**
 * The wobble alone. Rounding half-up biases every residual a quarter pixel
 * the same way, and a uniform shift is invisible; what the eye catches is the
 * oscillation around it, so the mean is subtracted before the worst is taken.
 */
function deviation(samples: PenSample[]): number {
	const res = samples.map((s) => s.y - s.x / 2);
	const mean = res.reduce((a, b) => a + b, 0) / res.length;
	return Math.max(...res.map((v) => Math.abs(v - mean)));
}

describe("the mouse trail", () => {
	it("takes most of the grid out of a diagonal", () => {
		const trail = new MouseTrail();
		const smoothed = staircase(40).map((s) => trail.push(s));
		// Judged past the ramp-in: the first few outputs average a partial
		// window on purpose, so the stroke stays anchored to the click.
		// Beyond it, the even window cancels the period-two staircase almost
		// outright; a window of three left a third of it, which is what this
		// bound is set to refuse.
		expect(deviation(smoothed.slice(6))).toBeLessThan(deviation(staircase(40)) / 3);
	});

	it("leaves the first sample exactly where the click was", () => {
		const trail = new MouseTrail();
		const first = trail.push(sample(17, 23));
		expect([first.x, first.y]).toEqual([17, 23]);
	});

	it("touches position and nothing else", () => {
		const trail = new MouseTrail();
		trail.push(sample(0, 0, 0));
		const out = trail.push(sample(2, 2, 8));
		expect(out.pressure).toBe(0.5);
		expect(out.timestamp).toBe(8);
		expect(out.tiltX).toBe(1);
		expect(out.tiltY).toBe(2);
	});

	it("keeps a corner a corner, half a window late", () => {
		const trail = new MouseTrail();
		const path = [
			sample(0, 0),
			sample(10, 0),
			sample(20, 0),
			sample(20, 10),
			sample(20, 20),
			sample(20, 30),
		];
		const out = path.map((s) => trail.push(s));
		// The trailing points have converged back onto the vertical leg.
		expect(out[5]!.x).toBe(20);
	});

	it("forgets the previous stroke at reset", () => {
		const trail = new MouseTrail();
		trail.push(sample(1000, 1000));
		trail.reset();
		const first = trail.push(sample(3, 4));
		expect([first.x, first.y]).toEqual([3, 4]);
	});
});

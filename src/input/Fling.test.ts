import { describe, expect, it } from "vitest";
import {
	FLING_MAX_SPEED,
	FLING_MIN_START_SPEED,
	FLING_TAU_MS,
	flingStep,
	releaseVelocity,
} from "./Fling";

describe("releaseVelocity — was that a flick?", () => {
	it("measures velocity over the recent window", () => {
		const v = releaseVelocity(
			[
				{ t: 920, x: 0, y: 0 },
				{ t: 960, x: -40, y: 0 },
				{ t: 1000, x: -80, y: 0 },
			],
			1000
		);
		expect(v).not.toBeNull();
		expect(v!.vx).toBeCloseTo(-1); // 80 px over 80 ms, leftward
		expect(v!.vy).toBeCloseTo(0);
	});

	it("ignores stale samples outside the window", () => {
		const v = releaseVelocity(
			[
				{ t: 0, x: 500, y: 0 }, // ancient — must not count
				{ t: 960, x: -40, y: 0 },
				{ t: 1000, x: -80, y: 0 },
			],
			1000
		);
		expect(v!.vx).toBeCloseTo(-1);
	});

	it("a slow drag is not a flick", () => {
		const v = releaseVelocity(
			[
				{ t: 920, x: 0, y: 0 },
				{ t: 1000, x: -(FLING_MIN_START_SPEED * 80) / 2, y: 0 },
			],
			1000
		);
		expect(v).toBeNull();
	});

	it("a finger held still before lift is not a flick", () => {
		expect(releaseVelocity([{ t: 700, x: 10, y: 10 }], 1000)).toBeNull();
	});

	it("clamps glitched timestamps to the speed ceiling", () => {
		const v = releaseVelocity(
			[
				{ t: 999, x: 0, y: 0 },
				{ t: 1000, x: -500, y: 0 },
			],
			1000
		);
		expect(Math.hypot(v!.vx, v!.vy)).toBeCloseTo(FLING_MAX_SPEED);
	});
});

describe("flingStep — exponential glide", () => {
	it("total glide converges to v·τ regardless of frame rate", () => {
		for (const frame of [8, 16.7, 33]) {
			let vx = 1.5;
			let vy = 0;
			let travelled = 0;
			for (let i = 0; i < 2000; i++) {
				const s = flingStep(vx, vy, frame);
				travelled += s.dx;
				vx = s.vx;
				vy = s.vy;
				if (s.done) break;
			}
			// Ideal glide is v·τ; the stop threshold truncates the final
			// FLING_STOP_SPEED·τ ≈ 6.5 px of asymptotic tail.
			const ideal = 1.5 * FLING_TAU_MS;
			expect(travelled).toBeGreaterThan(ideal - 8);
			expect(travelled).toBeLessThanOrEqual(ideal);
		}
	});

	it("ends: speed decays below the stop threshold in finite time", () => {
		let vx = 8;
		let vy = 8;
		let steps = 0;
		for (; steps < 1000; steps++) {
			const s = flingStep(vx, vy, 16.7);
			vx = s.vx;
			vy = s.vy;
			if (s.done) break;
		}
		expect(steps).toBeLessThan(200); // ~2 s at 60 fps, comfortably finite
	});

	it("zero/negative dt is a no-op, never NaN", () => {
		const s = flingStep(1, 1, 0);
		expect(s.dx).toBe(0);
		expect(s.done).toBe(false);
	});
});

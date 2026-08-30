import { PenSample } from "../input/PointerRouter";

/**
 * Transient stroke prediction (v0.1.3 experiment).
 *
 * Predicted points are NEVER added to the stroke being built. They exist only
 * as a disposable visual tail that is erased and rebuilt on every real input
 * event. Everything here works in screen space (CSS px): the camera is frozen
 * for the duration of a stroke, and the tail never outlives the next real
 * sample, so there is nothing to transform into world space.
 *
 * Two sources:
 *   "chromium"   PointerEvent.getPredictedEvents(), if the platform has it
 *   "extrap"     short velocity/acceleration extrapolation from recent real
 *                samples, for when it doesn't (or returns nothing useful)
 *
 * Both go through the same conservative caps. The purpose of the caps is that
 * a wrong prediction must be small enough that erasing it is invisible: sharp
 * corners are exactly where extrapolation overshoots, so the turn guard scales
 * the horizon down to zero as the path bends.
 */

export type PredictionSource = "chromium" | "extrap" | "none";

export interface PredictionCaps {
	/** Never predict further ahead in time than this. */
	maxHorizonMs: number;
	/** Never let the tail travel further than this (screen px). */
	maxDistPx: number;
	/** At this much direction change, prediction is fully suppressed. */
	maxTurnDeg: number;
	/** Below this speed the pen is effectively parked; predicting adds jitter. */
	minSpeedPxPerMs: number;
}

export const DEFAULT_CAPS: PredictionCaps = {
	maxHorizonMs: 24,
	maxDistPx: 20,
	maxTurnDeg: 30,
	minSpeedPxPerMs: 0.02,
};

export interface PredictionResult {
	/** Tail points to draw after the last real sample, in order. Never persisted. */
	points: PenSample[];
	source: PredictionSource;
	/** How far ahead of the last real sample the tip is, in ms. */
	horizonMs: number;
	/** Straight-line distance from last real sample to the tip, in px. */
	tipDistPx: number;
	/** Recent direction change, degrees. */
	turnDeg: number;
	/** Guard factor actually applied (1 = straight, 0 = fully suppressed). */
	guard: number;
	suppressed: boolean;
}

const EMPTY: PredictionResult = {
	points: [],
	source: "none",
	horizonMs: 0,
	tipDistPx: 0,
	turnDeg: 0,
	guard: 0,
	suppressed: true,
};

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

/** Anything with a position: the turn only ever needs x and y. */
interface Xy {
	x: number;
	y: number;
}

/** Direction change at b, in degrees, across a→b→c. 0 when degenerate. */
export function turnDegrees(a: Xy, b: Xy, c: Xy): number {
	const ux = b.x - a.x;
	const uy = b.y - a.y;
	const vx = c.x - b.x;
	const vy = c.y - b.y;
	const lu = Math.hypot(ux, uy);
	const lv = Math.hypot(vx, vy);
	if (lu < 1e-6 || lv < 1e-6) return 0;
	const cos = clamp((ux * vx + uy * vy) / (lu * lv), -1, 1);
	return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Direction change at the pen, measured between AVERAGED positions rather
 * than between three raw samples.
 *
 * At 200+ Hz three consecutive samples can span a fraction of a pixel, and
 * the angle between two sub-pixel vectors is mostly digitizer noise. Feeding
 * that to the turn guard made it flap between "straight" and "fully
 * suppressed" several times per letter, and the tail strobed at the tip
 * (hardware, 2026-08-29 - flicker while writing).
 *
 * The window is split into three, and each third contributes its centroid.
 * Averaging cuts the noise without lengthening the baseline, which matters:
 * a longer baseline would dilute a real corner and let the tail hook past it.
 * Early in a stroke, when only three samples exist, this is exactly the old
 * measurement - there is nothing better to be had yet.
 */
export function recentTurnDegrees(real: readonly PenSample[], window = 9): number {
	const n = real.length;
	if (n < 3) return 0;
	const w = Math.min(window, n);
	const k = Math.floor(w / 3);
	if (k < 1) return 0;
	const start = n - k * 3;
	const centroid = (from: number, count: number): Xy => {
		let x = 0;
		let y = 0;
		for (let i = from; i < from + count; i++) {
			x += real[i]!.x;
			y += real[i]!.y;
		}
		return { x: x / count, y: y / count };
	};
	return turnDegrees(
		centroid(start, k),
		centroid(start + k, k),
		centroid(start + 2 * k, k)
	);
}

/** Recent speed in px/ms from the tail of the real-sample history. */
export function recentSpeed(real: readonly PenSample[]): number {
	const n = real.length;
	if (n < 2) return 0;
	const last = real[n - 1]!;
	// Look back up to 3 samples for a stable estimate.
	const ref = real[Math.max(0, n - 4)]!;
	const dt = last.timestamp - ref.timestamp;
	if (dt <= 0) return 0;
	return Math.hypot(last.x - ref.x, last.y - ref.y) / dt;
}

/**
 * Velocity + damped acceleration extrapolation from the last few real samples.
 * Acceleration is halved and clamped: it sharpens the tail on accelerating
 * strokes without letting a noisy sample fling the tip away.
 */
export function extrapolate(
	real: readonly PenSample[],
	horizonMs: number,
	stepMs = 4,
	maxSteps = 8
): PenSample[] {
	const n = real.length;
	if (n < 2 || horizonMs <= 0) return [];
	const last = real[n - 1]!;
	const mid = real[Math.max(0, n - 3)]!;
	const dt1 = last.timestamp - mid.timestamp;
	if (dt1 <= 0) return [];
	const vx = (last.x - mid.x) / dt1;
	const vy = (last.y - mid.y) / dt1;

	let ax = 0;
	let ay = 0;
	if (n >= 4) {
		const older = real[Math.max(0, n - 5)]!;
		const dt0 = mid.timestamp - older.timestamp;
		if (dt0 > 0) {
			const pvx = (mid.x - older.x) / dt0;
			const pvy = (mid.y - older.y) / dt0;
			const span = (dt0 + dt1) / 2;
			if (span > 0) {
				// Damp by half; full second-order extrapolation overshoots.
				ax = (0.5 * (vx - pvx)) / span;
				ay = (0.5 * (vy - pvy)) / span;
			}
		}
	}
	const speed = Math.hypot(vx, vy);
	// Never let acceleration contribute more than the velocity term itself.
	const aMax = speed / Math.max(1, horizonMs);
	const aMag = Math.hypot(ax, ay);
	if (aMag > aMax && aMag > 0) {
		ax = (ax / aMag) * aMax;
		ay = (ay / aMag) * aMax;
	}

	const steps = Math.min(maxSteps, Math.max(1, Math.ceil(horizonMs / stepMs)));
	const out: PenSample[] = [];
	for (let i = 1; i <= steps; i++) {
		const t = Math.min(horizonMs, i * stepMs);
		out.push({
			x: last.x + vx * t + 0.5 * ax * t * t,
			y: last.y + vy * t + 0.5 * ay * t * t,
			pressure: last.pressure,
			timestamp: last.timestamp + t,
			tiltX: last.tiltX,
			tiltY: last.tiltY,
		});
		if (t >= horizonMs) break;
	}
	return out;
}

/**
 * Build the tail to draw after `real`'s last sample. `predicted` is whatever
 * getPredictedEvents() handed us (may be empty, which falls back to nothing in
 * "chromium" mode; the caller decides whether to retry as "extrap").
 */
export function buildTail(
	real: readonly PenSample[],
	predicted: readonly PenSample[],
	mode: "chromium" | "extrap",
	caps: PredictionCaps = DEFAULT_CAPS
): PredictionResult {
	const n = real.length;
	const last = real[n - 1];
	if (!last) return EMPTY;

	if (recentSpeed(real) < caps.minSpeedPxPerMs) {
		return { ...EMPTY, source: "none" };
	}

	// Turn guard: scale the horizon down as the recent path bends, to zero at
	// maxTurnDeg. This is what keeps corners from growing hooks.
	// Measured over a baseline, not over the last three samples: at pen rates
	// the last three can be sub-pixel apart, and the guard was flapping on
	// noise rather than on the shape of the letter.
	const turnDeg = recentTurnDegrees(real);
	const guard = clamp(1 - turnDeg / caps.maxTurnDeg, 0, 1);
	if (guard <= 0) {
		return { ...EMPTY, turnDeg, guard: 0, suppressed: true };
	}

	const horizon = caps.maxHorizonMs * guard;
	const maxDist = caps.maxDistPx * guard;

	const candidates =
		mode === "chromium"
			? [...predicted]
					.filter((p) => p.timestamp > last.timestamp)
					.sort((a, b) => a.timestamp - b.timestamp)
			: extrapolate(real, horizon);

	const points: PenSample[] = [];
	let prevX = last.x;
	let prevY = last.y;
	let travelled = 0;
	for (const p of candidates) {
		if (p.timestamp - last.timestamp > horizon) break;
		const step = Math.hypot(p.x - prevX, p.y - prevY);
		if (travelled + step > maxDist) break;
		travelled += step;
		points.push({ ...p, pressure: last.pressure });
		prevX = p.x;
		prevY = p.y;
	}

	if (points.length === 0) {
		return { ...EMPTY, turnDeg, guard, suppressed: true };
	}
	const tip = points[points.length - 1]!;
	return {
		points,
		source: mode,
		horizonMs: tip.timestamp - last.timestamp,
		tipDistPx: Math.hypot(tip.x - last.x, tip.y - last.y),
		turnDeg,
		guard,
		suppressed: false,
	};
}

/**
 * How wrong the last tail turned out to be: distance between the real sample
 * that just arrived and where the tail claimed the pen would be at that time.
 * Returns undefined when the tail didn't cover that timestamp.
 */
export function correctionError(
	tail: readonly PenSample[],
	actual: PenSample
): number | undefined {
	if (tail.length === 0) return undefined;
	let best: PenSample | undefined;
	let bestDt = Infinity;
	for (const p of tail) {
		const dt = Math.abs(p.timestamp - actual.timestamp);
		if (dt < bestDt) {
			bestDt = dt;
			best = p;
		}
	}
	// Only meaningful if the tail actually spans this moment (±8ms).
	if (!best || bestDt > 8) return undefined;
	return Math.hypot(best.x - actual.x, best.y - actual.y);
}

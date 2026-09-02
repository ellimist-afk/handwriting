/**
 * Assist-pan momentum (v0.13.2, the touch-and-pen feel pass).
 *
 * The standing guard's assist carries the first finger gesture after touch
 * idle (its gesture snapshot was taken under touch-action: none). Position
 * tracking is 1:1, but a native pan ends with a FLING, and the assist used
 * to stop dead at finger-lift, which is exactly the "first swipe feels
 * different" asymmetry. This module supplies the missing inertia:
 *
 *   release velocity  measured over the last ~80 ms of finger motion,
 *   decay             exponential, v(t) = v₀·e^(−t/τ) with τ = 325 ms,
 *                     the familiar mobile-scroll friction curve,
 *   life              finite by construction: below the stop speed the
 *                     fling is over; total glide ≈ v₀·τ (a fast 1.5 px/ms
 *                     flick glides ~490 px over ~1.3 s).
 *
 * The router drives it from requestAnimationFrame (a finite, self-ending
 * chain, not a recurring timer) and cancels it instantly on ANY new
 * input: pen signal (pen always wins), a new finger (takes over), or
 * disposal. Pure math here; DOM and rAF in the router.
 *
 * A wheel/touchpad scroll does NOT cancel a fling: InlinePenRouter
 * registers no "wheel" listener, so there is nothing here to wire it to.
 * Acceptable because a touch fling and a trackpad wheel scroll landing on
 * the same device at the same moment is rare (audit-fixes-design.md §5m
 * M1; retracts the wheel promise from Slice K3's un-skipped seam).
 */

/** Exponential decay time-constant, ms. */
export const FLING_TAU_MS = 325;
/** Below this speed (px/ms) the fling ends. */
export const FLING_STOP_SPEED = 0.02;
/** Release speeds below this never start a fling (it was a drag, not a flick). */
export const FLING_MIN_START_SPEED = 0.25;
/** Velocity is measured over samples no older than this. */
export const FLING_VELOCITY_WINDOW_MS = 80;
/** Hard ceiling so a glitched timestamp cannot launch the page. */
export const FLING_MAX_SPEED = 8;

export interface VelocitySample {
	t: number;
	x: number;
	y: number;
}

/**
 * Release velocity (px/ms) from the newest samples inside the window.
 * Null when there is not enough recent motion to call it a flick.
 */
export function releaseVelocity(
	samples: readonly VelocitySample[],
	now: number
): { vx: number; vy: number } | null {
	const recent = samples.filter((s) => now - s.t <= FLING_VELOCITY_WINDOW_MS);
	if (recent.length < 2) return null;
	const first = recent[0]!;
	const last = recent[recent.length - 1]!;
	const dt = last.t - first.t;
	if (dt <= 0) return null;
	let vx = (last.x - first.x) / dt;
	let vy = (last.y - first.y) / dt;
	const speed = Math.hypot(vx, vy);
	if (speed < FLING_MIN_START_SPEED) return null;
	if (speed > FLING_MAX_SPEED) {
		const k = FLING_MAX_SPEED / speed;
		vx *= k;
		vy *= k;
	}
	return { vx, vy };
}

/**
 * One decay step: the scroll displacement for this frame and the velocity
 * carried into the next. `done` when the speed falls below the stop speed.
 * Closed-form over dt, so frame-rate changes cannot alter the total glide.
 */
export function flingStep(
	vx: number,
	vy: number,
	dtMs: number,
	tauMs: number = FLING_TAU_MS
): { dx: number; dy: number; vx: number; vy: number; done: boolean } {
	if (dtMs <= 0) return { dx: 0, dy: 0, vx, vy, done: false };
	const decay = Math.exp(-dtMs / tauMs);
	// ∫v = v·τ·(1 − e^(−dt/τ))
	const travel = tauMs * (1 - decay);
	const dx = vx * travel;
	const dy = vy * travel;
	const nvx = vx * decay;
	const nvy = vy * decay;
	return { dx, dy, vx: nvx, vy: nvy, done: Math.hypot(nvx, nvy) < FLING_STOP_SPEED };
}

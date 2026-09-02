/**
 * What this machine's ink path actually costs, measured while writing.
 *
 * `age@present` is already recorded on every surface that draws wet ink: the
 * rAF after a raw event asks how old the newest sample is by the time a frame
 * goes out. That number is the software latency prediction is aiming into,
 * and until now nothing read it back - the horizon was a constant tuned on
 * one Surface (see DEFAULT_CAPS), and every other machine got that machine's
 * answer. A Surface Pro 8 reporting a delay on the same build with the same
 * setting is what this is for (dumbdreamed, 2026-09-01).
 *
 * Session-wide and shared by all three wet surfaces (inline, page, pdf): they
 * are the same machine, and the estimate wants samples faster than any one of
 * them produces alone.
 *
 * MEDIAN, not mean. A GC pause, a background tab, or a window drag produces a
 * present age in the hundreds of ms; one of those must not move the horizon,
 * and with a mean a single 400ms sample drags 64 good ones by 6ms.
 */

/** Recent present ages, oldest overwritten. */
const WINDOW = 64;

/**
 * Samples needed before the estimate is trusted. Below this the caller keeps
 * the shipped default: a horizon derived from four samples is noise, and the
 * first strokes of a session are exactly when the machine is busiest.
 */
const WARMUP = 24;

/**
 * Anything past this is not latency, it is a stall - a hidden tab, a resume
 * from sleep, the compositor waiting on something else entirely. Dropped
 * rather than clamped: a stall carries no information about the steady state.
 */
const IMPLAUSIBLE_MS = 500;

const ring: number[] = [];
let next = 0;
let cached: number | undefined;

/** Median of what is in the ring right now. Called on write, never on read. */
function recompute(): void {
	if (ring.length < WARMUP) {
		cached = undefined;
		return;
	}
	const sorted = [...ring].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	cached =
		sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Feed one `age@present` measurement, in ms. Safe to call from the frame
 * callback on the hot path: the median is computed here, so reading it back
 * during a pointer event is a field access.
 */
export function recordPresentAge(ms: number): void {
	if (!Number.isFinite(ms) || ms < 0 || ms > IMPLAUSIBLE_MS) return;
	if (ring.length < WINDOW) ring.push(ms);
	else {
		ring[next] = ms;
		next = (next + 1) % WINDOW;
	}
	recompute();
}

/**
 * Median present age in ms, or undefined while still warming up. Undefined
 * means "no opinion" - callers fall back to the shipped constant rather than
 * guessing from too little.
 */
export function presentLagMs(): number | undefined {
	return cached;
}

/** Test seam. Nothing in the plugin resets this; a session is one machine. */
export function resetLatencyEstimate(): void {
	ring.length = 0;
	next = 0;
	cached = undefined;
}

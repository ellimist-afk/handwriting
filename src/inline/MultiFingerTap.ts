/**
 * Two- and three-finger taps, decided without touching the DOM.
 *
 * Two fingers tapped together undo; three redo - the convention of most
 * handwriting apps, so a hand that already knows it from elsewhere does not
 * have to reach for the strip. This file only says WHICH tap happened; the
 * router feeds it contacts and the surface decides what a tap does.
 *
 * A tap is every finger landing, staying put and lifting quickly. Anything
 * else is navigation and must never undo: a finger that travels past the
 * slop (a scroll or a pinch), a gesture that outlasts the window (a resting
 * hand), a cancelled contact (the browser took it), or a spoil from outside
 * (a palm the gate swallowed, the pen arriving). A spoiled gesture stays
 * spoiled until every finger has lifted, so the tail of a pinch can never
 * read as a tap.
 */

/** First contact down to last contact up. Longer is a hold, not a tap. */
export const MULTI_TAP_MAX_MS = 300;

/** How far any one finger may wander, in CSS px, and still be tapping. */
export const MULTI_TAP_SLOP_PX = 15;

/** The taps that mean something: two fingers undo, three redo. */
export type MultiFingerTapCount = 2 | 3;

export class MultiFingerTap {
	private readonly downAt = new Map<number, { x: number; y: number }>();
	private startedAt = 0;
	private peak = 0;
	private spoiled = false;

	/** A finger landed. The first one of a gesture starts its clock. */
	down(pointerId: number, x: number, y: number, now: number): void {
		if (this.downAt.size === 0) {
			this.startedAt = now;
			this.peak = 0;
			this.spoiled = false;
		}
		this.downAt.set(pointerId, { x, y });
		this.peak = Math.max(this.peak, this.downAt.size);
	}

	/** A finger moved. Past the slop, the whole gesture is navigation. */
	move(pointerId: number, x: number, y: number): void {
		const start = this.downAt.get(pointerId);
		if (start && Math.hypot(x - start.x, y - start.y) > MULTI_TAP_SLOP_PX) this.spoiled = true;
	}

	/**
	 * A finger lifted. Answers the tap once the LAST finger is up, and only if
	 * nothing spoiled it; null for every other lift.
	 */
	up(pointerId: number, now: number): MultiFingerTapCount | null {
		if (!this.downAt.delete(pointerId) || this.downAt.size > 0) return null;
		if (this.spoiled || now - this.startedAt > MULTI_TAP_MAX_MS) return null;
		return this.peak === 2 || this.peak === 3 ? this.peak : null;
	}

	/** The browser cancelled a finger: it took the gesture, so this is not a tap. */
	cancel(pointerId: number): void {
		if (this.downAt.delete(pointerId)) this.spoiled = true;
	}

	/** Something outside the fingers ruled this gesture out (a palm, the pen). */
	spoil(): void {
		if (this.downAt.size > 0) this.spoiled = true;
	}

	/** Forget every contact, for a router being torn down or reset. */
	reset(): void {
		this.downAt.clear();
		this.peak = 0;
		this.spoiled = false;
	}
}

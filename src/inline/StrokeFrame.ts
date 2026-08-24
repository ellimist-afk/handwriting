/**
 * The stroke frame lock, as its own tiny state machine so the lifecycle is a
 * testable contract instead of a scattered boolean.
 *
 * While a stroke is in flight it owns its coordinate frame: `syncCamera` and
 * committed repaints are frozen until the gesture ends, so mid-stroke reflow
 * can't shear the ink (the frozen pen pipeline's core rule, unchanged here).
 *
 * The leak this extraction fixes: `begin()` had matching `end()`s only on the
 * pen-up paths. Switching files or unmounting the overlay mid-stroke reset
 * every OTHER piece of gesture state but left the lock held, wedging the next
 * note's camera and repaints until the next pen-down happened to clear it.
 * `cancel()` is the lifecycle escape hatch: file switch, overlay unmount and
 * plugin unload all cancel, and a cancelled frame never leaks into the next
 * note.
 */
export class StrokeFrame {
	private lockedFlag = false;

	/** True while a gesture owns the coordinate frame. */
	get locked(): boolean {
		return this.lockedFlag;
	}

	/** Pen-down, after the one allowed camera sync: freeze the frame. */
	begin(): void {
		this.lockedFlag = true;
	}

	/** Pen-up (any gesture kind): the frame is live again. */
	end(): void {
		this.lockedFlag = false;
	}

	/**
	 * Lifecycle teardown mid-gesture: file switch under a planted pen,
	 * overlay unmount, plugin unload. Identical effect to end(), named
	 * separately so call sites document WHY the lock is being released.
	 */
	cancel(): void {
		this.lockedFlag = false;
	}
}

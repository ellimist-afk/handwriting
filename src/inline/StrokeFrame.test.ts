import { describe, expect, it } from "vitest";
import { StrokeFrame } from "./StrokeFrame";

/**
 * The v0.13.6 lifecycle fix: begin() used to have matching releases only on
 * the pen-up paths, so a file switch or unmount mid-stroke left the lock
 * held and wedged the next note's camera and repaints until its first
 * pen-down. cancel() is wired into resetGestureState(), which every
 * lifecycle teardown path (file switch, unmount, plugin unload) runs.
 */
describe("StrokeFrame — the stroke frame lock lifecycle", () => {
	it("normal gesture: unlocked → begin locks → end releases", () => {
		const f = new StrokeFrame();
		expect(f.locked).toBe(false);
		f.begin();
		expect(f.locked).toBe(true);
		f.end();
		expect(f.locked).toBe(false);
	});

	it("THE LEAK: cancel mid-stroke releases the lock for the next note", () => {
		const f = new StrokeFrame();
		f.begin(); // pen is down on note A…
		f.cancel(); // …and the pane switches to note B mid-stroke
		expect(f.locked).toBe(false); // B's camera and repaints are live
	});

	it("cancel and end are idempotent and safe in any state", () => {
		const f = new StrokeFrame();
		f.cancel();
		f.end();
		expect(f.locked).toBe(false);
		f.begin();
		f.cancel();
		f.cancel();
		expect(f.locked).toBe(false);
		// The next stroke locks cleanly after a cancelled one.
		f.begin();
		expect(f.locked).toBe(true);
	});
});

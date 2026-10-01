/**
 * AUDIT PROBE InkOverlay-5-3 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: startOverscrollBounce (InkOverlay.ts :7749-7790) stamps `startedAt` with the bare global
 * `performance.now()` (:7774), which is the main window's clock because plugin code runs in the main
 * window's realm, but measures progress with the `now` that `this.winRef.requestAnimationFrame` passes
 * (:7776-7778, :7786-7787). For a popout editor winRef is the popout window, whose rAF timestamps are
 * relative to the popout's own (later) time origin. So `now - startedAt` is negative, t clamps to 0 and
 * the ease never leaves the overshoot until the popout's age has elapsed.
 *
 * Correct behaviour (product contract): an edge left inside the pane eases home in OVERSCROLL_BOUNCE_MS
 * (500 ms) in whichever window the note lives. These cells assert that, so they go red only on the
 * claimed mechanism.
 *
 * Rig: the real InkOverlayPlugin off its prototype (the Object.create idiom HoverRaisesPenTools.test.ts,
 * K4.test.ts use), the real resumeStrandedPan -> startOverscrollBounce -> step -> cancel path, the real
 * winRef getter. Only `writeViewportPan` (the DOM write of the offset, not the subject) is replaced by a
 * recorder. The global `performance.now` is the main-window clock (spied so frames are deterministic).
 * The fake window's rAF delivers timestamps on ITS OWN clock: main clock minus the popout's opening
 * delay (0 for the main window, which is the control cell).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "../inline/InkOverlay";

type Fields = Record<string, unknown>;

let mainClock = 0;

function fakeWindow(timeOriginDelayMs: number) {
	const queue: Array<{ id: number; cb: (t: number) => void }> = [];
	let nextId = 1;
	const delivered: number[] = [];
	const win = {
		requestAnimationFrame: (cb: (t: number) => void): number => {
			const id = nextId++;
			queue.push({ id, cb });
			return id;
		},
		cancelAnimationFrame: (id: number): void => {
			const i = queue.findIndex((q) => q.id === id);
			if (i >= 0) queue.splice(i, 1);
		},
		/** This window's own performance.now(): relative to its time origin, which is `timeOriginDelayMs` after the main window's. */
		ownNow: (): number => mainClock - timeOriginDelayMs,
		/** A real window carries that clock as `performance`, the same one its frames are stamped with. */
		performance: { now: (): number => mainClock - timeOriginDelayMs },
	};
	return {
		win,
		delivered,
		queued: () => queue.length,
		/** One frame: wall time advances 16 ms, every queued callback runs with this window's rAF timestamp. */
		frame(): void {
			mainClock += 16;
			const due = queue.splice(0);
			const ts = win.ownNow();
			for (const q of due) {
				delivered.push(ts);
				q.cb(ts);
			}
		},
	};
}

function makeOverlay(win: object) {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	// Field initializers the exercised path reads (InkOverlay.ts :1644, :1802, :1814, :1816, :7830-7835).
	o.view = { dom: { ownerDocument: { defaultView: win } }, scrollDOM: {} };
	o.canvasMode = true; // Infinite Canvas on for this note.
	o.bounceOffset = { x: 0, y: 0 };
	o.bounceState = null;
	o.bouncedHold = null;
	o.pinchPreview = null;
	o.frame = { locked: false };
	o.boundReadout = { floorX: 0, floorY: 0 };
	o.committedCanvas = null;
	o.previewPaperEl = null;
	// The top edge was left 80 px inside the pane when the last contact lifted.
	o.viewportPan = { x: 0, y: 80 };
	const offsets: number[] = [];
	o.writeViewportPan = (): void => { offsets.push((o.bounceOffset as { y: number }).y); };
	return { o, offsets };
}

type Api = {
	resumeStrandedPan(): boolean;
	overscrollBounceReadout(): { active: boolean; y: number; fromY: number; startedAt: number | null };
};

afterEach(() => {
	vi.restoreAllMocks();
});

function run(timeOriginDelayMs: number) {
	mainClock = 200_000; // 200 s since app launch (the main window's time origin).
	vi.spyOn(performance, "now").mockImplementation(() => mainClock);
	const w = fakeWindow(timeOriginDelayMs);
	const globalRaf = vi.fn();
	(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = globalRaf;
	const { o, offsets } = makeOverlay(w.win);
	const api = o as unknown as Api;
	const started = api.resumeStrandedPan();
	const atStart = api.overscrollBounceReadout();
	// 700 ms of frames: well past the 500 ms ease.
	for (let i = 0; i < 44 && w.queued() > 0; i++) w.frame();
	const after = api.overscrollBounceReadout();
	delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
	return { started, atStart, after, offsets, w, globalRaf, o };
}

describe("InkOverlay-5-3: the overscroll bounce eases home in any window", () => {
	it("control: editor in the main window (same clock) eases to rest within 700 ms", () => {
		const r = run(0);
		expect(r.started).toBe(true);
		expect(r.atStart.active).toBe(true);
		expect(r.atStart.fromY).toBe(80);
		expect(r.globalRaf).not.toHaveBeenCalled();
		expect(r.after.active).toBe(false);
		expect(r.after.y).toBe(0);
	});

	it("popout opened 120 s after launch: the same bounce eases to rest within 700 ms", () => {
		const r = run(120_000);
		// Preconditions: the bounce started from an 80 px overshoot, its frames were requested on the
		// editor's own (popout) window, and that window's rAF timestamps are on its own clock, which is
		// behind the main window's performance.now() by the popout's age at open.
		expect(r.started).toBe(true);
		expect(r.atStart.active).toBe(true);
		expect(r.atStart.fromY).toBe(80);
		expect(r.globalRaf).not.toHaveBeenCalled();
		expect(r.w.delivered.length).toBeGreaterThan(30);
		// The trigger, stated without the mechanism so it holds before and after a fix: this window's frame
		// stamps run behind the main window's performance.now() (200 000 at the start).
		expect(r.w.delivered[0]).toBeLessThan(200_000);
		// Correct behaviour: after 700 ms of frames the page is at its rest and the loop has ended.
		expect({ active: r.after.active, offsetY: r.after.y, lastWrittenOffsetY: r.offsets.at(-1) })
			.toEqual({ active: false, offsetY: 0, lastWrittenOffsetY: 0 });
	});
});

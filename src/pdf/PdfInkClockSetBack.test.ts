/**
 * A PDF zoom repaints the ink on time after the PC clock is set back.
 *
 * The repaint after a zoom goes through the sync throttle: a sync stamps when
 * it ran, and the next viewer change inside the floor (SYNC_MIN_GAP_MS) waits
 * for one trailing sync at the floor. The probe cache has a backstop age
 * (PROBE_MAX_AGE_MS) on the same kind of stamp. When those stamps are wall
 * clock, a clock set back by a time sync or by hand makes the gap negative:
 * the trailing sync waits the floor plus the whole set-back, and the probe
 * backstop is off for as long. The ink then stays stretched at the old zoom's
 * sharpness until some other path repaints it.
 *
 * Two clocks are driven here on their own: the wall clock (Date.now) and the
 * steady clock (performance.now, on the global and on the pane's window, so
 * either read is driven). Real time passing moves both; a set-back moves only
 * the wall clock. Timers and frames run on the steady clock in a small
 * scheduler of our own, so no cell waits on real time.
 *
 * The controller is built without its constructor (the prototype and the
 * fields these methods read): the real sync stamps, the real throttle reads
 * the stamp, the real probe reads and serves its cache. The viewer root has
 * no scroller, so a sync stops right after its probe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PdfInkController, PROBE_MAX_AGE_MS, SYNC_MIN_GAP_MS } from "./PdfInkController";

/** One pane on two clocks, with its timers and frames run by hand. */
interface Rig {
	ctl: PdfInkController;
	/** Steady-clock times at which a sync ran. */
	syncs: number[];
	/** Steady-clock "now". */
	steady(): number;
	/** Real time passes: both clocks move, and every timer due by then runs, each followed by its frames. */
	advance(ms: number): void;
	/** The PC clock is set back (negative moves it forward); the steady clock does not move. */
	setBack(ms: number): void;
	/** Run the frames asked for so far. */
	frames(): void;
}

const STEADY_START = 50_000;
const WALL_START = 1_000_000_000;

function rig(): Rig {
	let steady = STEADY_START;
	let wall = WALL_START;
	vi.spyOn(Date, "now").mockImplementation(() => wall);
	vi.spyOn(performance, "now").mockImplementation(() => steady);
	const timers: Array<{ id: number; due: number; fn: () => void }> = [];
	let frameQueue: Array<() => void> = [];
	let ids = 0;
	const win = {
		performance: { now: () => steady },
		setTimeout: (fn: () => void, ms: number) => {
			const id = ++ids;
			timers.push({ id, due: steady + Math.max(0, ms), fn });
			return id;
		},
		clearTimeout: (id: number) => {
			const at = timers.findIndex((t) => t.id === id);
			if (at >= 0) timers.splice(at, 1);
		},
		requestAnimationFrame: (fn: () => void) => {
			frameQueue.push(fn);
			return ++ids;
		},
	} as unknown as Window;
	const ctl = Object.create(PdfInkController.prototype) as PdfInkController;
	const syncs: number[] = [];
	const ownSync = PdfInkController.prototype.sync;
	const fields: Record<string, unknown> = {
		win,
		root: { querySelector: () => null },
		mounted: true,
		syncQueued: false,
		trailingSync: null,
		lastSyncAt: 0,
		probedCache: null,
		probedAt: 0,
		probedValid: false,
		probeReads: 0,
		probeServed: 0,
		sync(this: PdfInkController) {
			syncs.push(steady);
			ownSync.call(this);
		},
	};
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(ctl, key, { value, writable: true, configurable: true });
	}
	const frames = (): void => {
		while (frameQueue.length > 0) {
			const run = frameQueue;
			frameQueue = [];
			for (const fn of run) fn();
		}
	};
	const advance = (ms: number): void => {
		const target = steady + ms;
		for (;;) {
			timers.sort((a, b) => a.due - b.due || a.id - b.id);
			const next = timers[0];
			if (!next || next.due > target) break;
			timers.shift();
			wall += next.due - steady;
			steady = next.due;
			next.fn();
			frames();
		}
		wall += target - steady;
		steady = target;
	};
	return {
		ctl,
		syncs,
		steady: () => steady,
		advance,
		setBack: (ms: number) => {
			wall -= ms;
		},
		frames,
	};
}

/** A zoom step: the root observer sends the viewer's restyle through the throttle. */
function zoomStep(r: Rig): void {
	r.ctl.scheduleThrottled();
	r.frames();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pdf zoom repaint after the PC clock is set back", () => {
	it("a zoom just after a repaint is repainted at the normal floor when the clock was set back a minute", () => {
		const r = rig();
		const t0 = r.steady();
		r.ctl.sync();
		expect(r.syncs).toEqual([t0]);
		r.setBack(60_000);
		r.advance(30);
		zoomStep(r);
		expect(r.syncs, "a zoom inside the floor repainted at once").toEqual([t0]);
		r.advance(SYNC_MIN_GAP_MS - 30 - 1);
		expect(r.syncs, "the zoom was repainted before the floor").toEqual([t0]);
		r.advance(1);
		expect(r.syncs, "after the clock went back a minute, the zoom was not repainted at the floor").toEqual([
			t0,
			t0 + SYNC_MIN_GAP_MS,
		]);
	});

	it("a zoom burst with a repaint in the middle still gets its last repaint at the floor after a set-back", () => {
		const r = rig();
		const t0 = r.steady();
		r.ctl.sync();
		r.setBack(60_000);
		r.advance(30);
		zoomStep(r);
		// A repaint from another road in the middle of the burst: a pen lift, a tool pick.
		r.advance(20);
		r.ctl.sync();
		expect(r.syncs).toEqual([t0, t0 + 50]);
		// The last step of the burst, inside the floor of that repaint.
		r.advance(30);
		zoomStep(r);
		expect(r.syncs, "the last zoom step repainted at once, inside the floor").toEqual([t0, t0 + 50]);
		r.advance(SYNC_MIN_GAP_MS);
		const after = r.syncs.filter((t) => t >= t0 + 80);
		expect(
			after.length,
			"after the clock went back a minute, the last zoom step of the burst was never repainted"
		).toBeGreaterThan(0);
		expect(after[0], "the last zoom step waited past the floor of the repaint before it").toBeLessThanOrEqual(
			t0 + 50 + SYNC_MIN_GAP_MS
		);
	});

	it("the viewer is read again once the backstop age has passed, after the clock was set back", () => {
		const r = rig();
		r.ctl.probe();
		expect(r.ctl.probeReads).toBe(1);
		r.setBack(60_000);
		r.advance(PROBE_MAX_AGE_MS - 1);
		r.ctl.probe();
		expect(r.ctl.probeReads, "the viewer was read again inside the backstop age").toBe(1);
		expect(r.ctl.probeServed).toBe(1);
		r.advance(1);
		r.ctl.probe();
		expect(r.ctl.probeReads, "after the clock went back a minute, an old viewer read was still served").toBe(2);
	});
});

describe("pdf zoom repaint on a clock that is not set back", () => {
	it("keeps the throttle and the backstop timing as they are on a steady clock", () => {
		const r = rig();
		const t0 = r.steady();
		r.ctl.sync();
		r.advance(30);
		zoomStep(r);
		expect(r.syncs, "a zoom inside the floor repainted at once").toEqual([t0]);
		r.advance(SYNC_MIN_GAP_MS - 30 - 1);
		expect(r.syncs, "the zoom was repainted before the floor").toEqual([t0]);
		r.advance(1);
		expect(r.syncs, "the zoom was not repainted at the floor").toEqual([t0, t0 + SYNC_MIN_GAP_MS]);
		// Past the floor, a zoom repaints at once.
		r.advance(SYNC_MIN_GAP_MS);
		zoomStep(r);
		expect(r.syncs, "a zoom past the floor waited").toEqual([t0, t0 + SYNC_MIN_GAP_MS, t0 + 2 * SYNC_MIN_GAP_MS]);
		// Only one trailing sync for a whole burst inside the floor.
		r.advance(10);
		zoomStep(r);
		r.advance(10);
		zoomStep(r);
		r.advance(10);
		zoomStep(r);
		r.advance(SYNC_MIN_GAP_MS);
		expect(r.syncs, "a burst inside the floor did not collapse into one trailing repaint").toEqual([
			t0,
			t0 + SYNC_MIN_GAP_MS,
			t0 + 2 * SYNC_MIN_GAP_MS,
			t0 + 3 * SYNC_MIN_GAP_MS,
		]);

		const p = rig();
		p.ctl.probe();
		p.advance(PROBE_MAX_AGE_MS - 1);
		p.ctl.probe();
		expect([p.ctl.probeReads, p.ctl.probeServed], "the probe cache was not served inside its age").toEqual([1, 1]);
		p.advance(1);
		p.ctl.probe();
		expect([p.ctl.probeReads, p.ctl.probeServed], "the probe cache was served at its age").toEqual([2, 1]);
	});

	it("a zoom after the clock moved forward is still repainted by the floor", () => {
		const r = rig();
		const t0 = r.steady();
		r.ctl.sync();
		r.setBack(-60_000);
		r.advance(30);
		zoomStep(r);
		r.advance(SYNC_MIN_GAP_MS - 30);
		const after = r.syncs.filter((t) => t >= t0 + 30);
		expect(after.length, "a zoom after the clock moved forward was never repainted").toBeGreaterThan(0);
		expect(after[0]).toBeLessThanOrEqual(t0 + SYNC_MIN_GAP_MS);
	});
});

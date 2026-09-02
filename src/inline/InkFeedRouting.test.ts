/**
 * The feed decision, exercised through the router's real registered handlers
 * instead of the arbiter alone. InkFeed.test.ts proves the arithmetic; this
 * file proves the wiring: a WebKit-shaped stream (down, moves carrying
 * coalesced lists, up, zero raws — the iPad report of 2026-08-25) comes out
 * of InlinePenRouter as expanded onPenRaw deliveries, and a Chromium-shaped
 * stream still inks from raw alone with the move handler back to counting.
 *
 * The DOM here is the thinnest thing the constructor will hold still for:
 * an element fake that records addEventListener registrations so tests can
 * invoke the capture handlers directly, and a window stub for the mirror and
 * the end backstop. No jsdom; the suite runs where every other test runs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { setMouseInk } from "./MouseInk";
import { markPenSeen, resetPenToolsForTest } from "./PenToolsMode";
// The DOM scaffolding lives in test/routerHarness.ts now, shared with the
// trace replay - one element fake on purpose, so the two suites cannot
// drift apart and disagree about what the router saw.
import {
	cancelledRafIds,
	fakeEl,
	fedTimestamps,
	harness,
	installFakeWindow,
	penEvent,
	rafCallbacks,
} from "../../test/routerHarness";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});


// ---- the streams -----------------------------------------------------------

describe("move-fed ink through the real router (WebKit stream: no raw ever)", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	it("expands each move's coalesced list into one onPenRaw delivery", () => {
		h.fire(penEvent("pointerdown", 100));
		expect(h.rec.downs).toBe(1);
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		h.fire(penEvent("pointermove", 120, { coalesced: [112, 116, 120] }));
		expect(h.rec.rawCalls.length).toBe(2);
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112, 116, 120]);
		h.fire(penEvent("pointerup", 124, { pressure: 0, buttons: 0 }));
		expect(h.rec.ups).toBe(1);
	});

	it("a move without getCoalescedEvents feeds itself", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 110));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([110]);
	});

	it("keeps the move counter fed alongside the ink", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		expect(h.rec.moveCounts).toEqual([2]);
	});

	it("drops hover-tail samples stamped at or before the down", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [92, 96, 100, 104, 108] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108]);
	});

	it("drops overlap between consecutive coalesced lists", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		h.fire(penEvent("pointermove", 112, { coalesced: [108, 112] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112]);
	});

	it("the second stroke feeds again after the first ends", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		h.fire(penEvent("pointerup", 112, { pressure: 0, buttons: 0 }));
		h.fire(penEvent("pointerdown", 300));
		h.fire(penEvent("pointermove", 308, { coalesced: [304, 308] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 304, 308]);
		expect(h.rec.ups).toBe(1);
		expect(h.rec.downs).toBe(2);
	});
});

describe("raw-fed ink through the real router (Chromium stream)", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		h = harness();
	});

	it("raw feeds the ink and the move handler only counts", () => {
		// Approach hover: raw with no contact latches the channel.
		h.fire(penEvent("pointerrawupdate", 90, { pressure: 0, buttons: 0 }));
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerrawupdate", 104, { coalesced: [102, 104] }));
		h.fire(penEvent("pointermove", 104, { coalesced: [102, 104] }));
		h.fire(penEvent("pointerrawupdate", 112, { coalesced: [108, 112] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([102, 104, 108, 112]);
		// Both moves-as-counters and no duplicate ink from the move.
		expect(h.rec.moveCounts.length).toBe(1);
	});

	it("cold strike: a flushed move ahead of the first raw never double-inks", () => {
		// Session's first stroke, zero prior hover. The frame-aligned move
		// dispatches first; the withheld raw then flushes the same samples.
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108]);
		h.fire(penEvent("pointerrawupdate", 112, { coalesced: [104, 108, 112] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112]);
		// The channel is proven; later moves are counters again.
		h.fire(penEvent("pointermove", 120, { coalesced: [116, 120] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112]);
	});

	it("stylus-typed touches are eaten before the editor sees them", () => {
		// The webkit second stream: same pen, wearing its touch costume.
		let prevented = 0;
		let stopped = 0;
		const touch = (touchType?: string, target: unknown = h.el) =>
			({
				type: "touchstart",
				target,
				changedTouches: touchType === undefined ? [{}] : [{ touchType }],
				preventDefault: () => void prevented++,
				stopPropagation: () => void stopped++,
			}) as unknown as PointerEvent;
		h.fireWin(touch("stylus"));
		expect(prevented).toBe(1);
		expect(stopped).toBe(1);
		// A finger and a chromium-shaped touch both pass untouched.
		h.fireWin(touch("direct"));
		h.fireWin(touch(undefined));
		expect(prevented).toBe(1);
		expect(stopped).toBe(1);
	});

	it("leaves touches outside its own scroller entirely alone", () => {
		// The guards moved to the window to get ahead of Obsidian's app-level
		// handlers, which means they now SEE every touch in the app. A stylus
		// touch on a sidebar, a modal, another editor - none of it is ours,
		// and eating it would break the rest of the app in exactly the way
		// window-level listeners are notorious for.
		let prevented = 0;
		const elsewhere = fakeEl();
		h.fireWin({
			type: "touchstart",
			target: elsewhere,
			changedTouches: [{ touchType: "stylus" }],
			preventDefault: () => void prevented++,
			stopPropagation: () => {},
		} as unknown as PointerEvent);
		expect(prevented).toBe(0);
	});

	it("a raw during a later stroke keeps the move handler out for the session", () => {
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerrawupdate", 104, { coalesced: [104] }));
		h.fire(penEvent("pointerup", 108, { pressure: 0, buttons: 0 }));
		h.fire(penEvent("pointerdown", 200));
		h.fire(penEvent("pointermove", 208, { coalesced: [204, 208] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104]);
	});
});

describe("mouse ink through the real router", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		setMouseInk(false);
		h = harness();
	});
	afterEach(() => setMouseInk(false));

	function mouseEvent(type: string, ts: number, buttons: number, coalesced?: number[]) {
		const ev = penEvent(type, ts, { buttons, pressure: buttons & 1 ? 0.5 : 0, coalesced });
		(ev as unknown as Record<string, unknown>).pointerType = "mouse";
		return ev;
	}

	it("off: the mouse is never touched", () => {
		h.fire(mouseEvent("pointerdown", 100, 1));
		expect(h.rec.downs).toBe(0);
		h.fire(mouseEvent("pointermove", 108, 1, [104, 108]));
		expect(h.rec.rawCalls.length).toBe(0);
	});

	it("on: the left button inks like a pen tip", () => {
		setMouseInk(true);
		h.fire(mouseEvent("pointerdown", 100, 1));
		expect(h.rec.downs).toBe(1);
		h.fire(mouseEvent("pointermove", 108, 1, [104, 108]));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108]);
		h.fire(mouseEvent("pointerup", 112, 0));
		expect(h.rec.ups).toBe(1);
	});

	it("on: the right button stays native", () => {
		setMouseInk(true);
		h.fire(mouseEvent("pointerdown", 100, 2));
		expect(h.rec.downs).toBe(0);
	});
});

describe("stabilizing-hand contextmenu", () => {
	let h: ReturnType<typeof harness>;
	beforeEach(() => {
		resetPenToolsForTest();
		h = harness();
	});
	afterEach(resetPenToolsForTest);

	function touchMenu() {
		let prevented = 0;
		const ev = {
			type: "contextmenu",
			pointerType: "touch",
			preventDefault: () => void prevented++,
			stopPropagation: () => {},
		} as unknown as PointerEvent;
		h.fire(ev);
		return prevented;
	}

	it("suppressed once a pen has been seen this session", () => {
		markPenSeen();
		expect(touchMenu()).toBe(1);
	});

	it("kept for sessions that never see a pen", () => {
		expect(touchMenu()).toBe(0);
	});
});

/**
 * Battery: the pen router listens for `pointerrawupdate` only while a stroke
 * is in flight. Chromium generates raw events only while a listener exists,
 * so with the listener gone a hovering pen stops costing a raw dispatch
 * every 4 ms; hover bookkeeping stays on `pointermove`. A stroke still inks
 * from raw, so nothing about how ink follows the pen changes.
 *
 *   1. The listener is added at the stroke's claim and removed at every end:
 *      a lift, a blur commit, an abandon, and the router's dispose.
 *   2. The raw stream may start late (the browser learns about a new listener
 *      a few ms after the claim). A stroke whose raw starts up to 50 ms after
 *      the down inks every sample exactly once, in order: moves feed ink until
 *      that stroke's first raw, and the overlap drops by timestamp. Every
 *      stroke, not only the session's first.
 *
 * The element fake honours `removeEventListener` for raw and, like a browser,
 * delivers no raw event while no raw listener is bound (test/routerHarness.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { InlinePenRouter } from "./InlinePenRouter";
import { fedTimestamps, harness as baseHarness, installFakeWindow, penEvent } from "../../test/routerHarness";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});

const built: InlinePenRouter[] = [];
function harness(): ReturnType<typeof baseHarness> {
	const h = baseHarness();
	built.push(h.router);
	return h;
}
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
});

const hover = (ts: number) => penEvent("pointermove", ts, { pressure: 0, buttons: 0 });
const up = (ts: number) => penEvent("pointerup", ts, { pressure: 0, buttons: 0 });
const rawBound = (h: ReturnType<typeof harness>) => h.el.handlers.has("pointerrawupdate");

describe("the raw listener lives from a stroke's claim to its end", () => {
	it("no raw listener while the pen only hovers", () => {
		const h = harness();
		expect(rawBound(h), "bound at construction").toBe(false);
		h.fire(hover(50));
		h.fire(hover(58));
		expect(h.el.rawLog).toEqual([]);
		expect(rawBound(h)).toBe(false);
	});

	it("added at the pen claim, removed at the lift, once each per stroke", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(rawBound(h), "not bound during the stroke").toBe(true);
		h.fire(penEvent("pointerrawupdate", 104, { coalesced: [102, 104] }));
		h.fire(up(110));
		expect(rawBound(h), "still bound after the lift").toBe(false);
		h.fire(penEvent("pointerdown", 200));
		h.fire(up(210));
		expect(h.el.rawLog).toEqual(["add", "remove", "add", "remove"]);
	});

	it("removed when a blur commits the stroke", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		expect(h.router.finishActiveStroke()).toBe(true);
		expect(rawBound(h)).toBe(false);
		expect(h.el.rawLog).toEqual(["add", "remove"]);
	});

	it("removed when the stroke is abandoned", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.router.abandonActiveStroke();
		expect(rawBound(h)).toBe(false);
		expect(h.el.rawLog).toEqual(["add", "remove"]);
	});

	it("removed when the router is disposed mid-stroke", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.router.dispose();
		expect(rawBound(h)).toBe(false);
		expect(h.el.rawLog).toEqual(["add", "remove"]);
	});
});

describe("a raw stream that starts late still inks every sample once, in order", () => {
	it("the session's first stroke: moves carry the ink until the first raw, the overlap drops", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointermove", 108, { coalesced: [104, 108] }));
		h.fire(penEvent("pointermove", 116, { coalesced: [112, 116] }));
		// The raw stream arrives 20 ms after the down, flushing what the moves already fed.
		h.fire(penEvent("pointerrawupdate", 120, { coalesced: [104, 108, 112, 116, 120] }));
		h.fire(penEvent("pointermove", 124, { coalesced: [120, 124] }));
		h.fire(penEvent("pointerrawupdate", 124, { coalesced: [124] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([104, 108, 112, 116, 120, 124]);
	});

	it("every later stroke too: a raw in one stroke does not silence the next stroke's moves", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerrawupdate", 104, { coalesced: [102, 104] }));
		h.fire(up(110));
		h.fire(hover(150));
		h.fire(penEvent("pointerdown", 300));
		h.fire(penEvent("pointermove", 308, { coalesced: [304, 308] }));
		// The new listener's stream starts after the samples the moves carried:
		// no flush, so a move held out of the ink here would lose 304 and 308.
		h.fire(penEvent("pointerrawupdate", 312, { coalesced: [312] }));
		h.fire(penEvent("pointerrawupdate", 316, { coalesced: [316] }));
		h.fire(penEvent("pointermove", 320, { coalesced: [316, 320] }));
		h.fire(penEvent("pointerrawupdate", 320, { coalesced: [320] }));
		expect(fedTimestamps(h.rec.rawCalls)).toEqual([102, 104, 304, 308, 312, 316, 320]);
	});

	it("a raw stream that starts 50 ms after the down: nothing lost, nothing twice", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		const moved: number[] = [];
		for (let t = 108; t <= 148; t += 8) {
			h.fire(penEvent("pointermove", t, { coalesced: [t - 4, t] }));
			moved.push(t - 4, t);
		}
		h.fire(penEvent("pointerrawupdate", 152, { coalesced: [...moved, 150, 152] }));
		h.fire(penEvent("pointermove", 156, { coalesced: [152, 156] }));
		h.fire(penEvent("pointerrawupdate", 156, { coalesced: [154, 156] }));
		const fed = fedTimestamps(h.rec.rawCalls);
		expect(fed).toEqual([...moved, 150, 152, 154, 156]);
		expect(new Set(fed).size, "a sample inked twice").toBe(fed.length);
	});
});
